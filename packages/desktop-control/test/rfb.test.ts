import { expect, test } from "bun:test";
import { RfbInputGate } from "../src/rfb";

const handshake = Buffer.concat([
	Buffer.from("RFB 003.008\n"),
	Buffer.from([2]),
	Buffer.alloc(16),
	Buffer.from([1]),
]);
const key = (down: boolean) => Buffer.from([4, down ? 1 : 0, 0, 0, 0, 0, 0, 65]);
const pointer = Buffer.from([5, 1, 0, 20, 0, 30]);
function fixture() {
	let allowed = false;
	const sent: Buffer[] = [];
	const gate = new RfbInputGate(
		(b) => sent.push(Buffer.from(b)),
		() => allowed,
	);
	gate.feed(handshake);
	sent.length = 0;
	return {
		gate,
		sent,
		allow: (a: boolean) => {
			allowed = a;
		},
	};
}
test("spectators can request pixels but cannot type, click, resize or write clipboard", () => {
	const { gate, sent } = fixture();
	const request = Buffer.from([3, 1, 0, 0, 0, 0, 5, 0, 2, 208]);
	const clipboard = Buffer.from([6, 0, 0, 0, 0, 0, 0, 1, 65]);
	gate.feed(Buffer.concat([key(true), pointer, clipboard, request]));
	expect(sent).toEqual([request]);
});
test("fragmented and coalesced messages keep their boundaries", () => {
	const { gate, sent, allow } = fixture();
	allow(true);
	const both = Buffer.concat([key(true), pointer, key(false)]);
	for (const b of both) gate.feed(Buffer.from([b]));
	expect(sent).toEqual([key(true), pointer, key(false)]);
});
test("takeover releases held keys/buttons and drops the old viewer's late key-up", () => {
	const { gate, sent, allow } = fixture();
	allow(true);
	gate.feed(Buffer.concat([key(true), pointer]));
	allow(false);
	gate.revoke();
	gate.feed(key(false));
	expect(sent).toEqual([key(true), pointer, key(false), Buffer.from([5, 0, 0, 20, 0, 30])]);
});
test("partial input that began before ownership cannot be completed after acquire", () => {
	const { gate, sent, allow } = fixture();
	gate.feed(key(true).subarray(0, 2));
	allow(true);
	gate.feed(key(true).subarray(2));
	expect(sent).toEqual([]);
	gate.feed(key(true).subarray(0, 2));
	gate.revoke();
	gate.feed(key(true).subarray(2));
	expect(sent).toEqual([]);
});
test("unknown extensions and oversized clipboard messages fail closed", () => {
	const { gate } = fixture();
	expect(() => gate.feed(Buffer.from([255, 1]))).toThrow("Unsupported");
	const next = fixture().gate;
	expect(() => next.feed(Buffer.from([6, 0, 0, 0, 127, 255, 255, 255]))).toThrow("too large");
});
test("rejects an alternate authentication mode instead of misparsing subsequent bytes", () => {
	const gate = new RfbInputGate(
		() => {},
		() => true,
	);
	expect(() => gate.feed(Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1])]))).toThrow(
		"password",
	);
});
test("reports only input it forwarded for the controlling viewer", () => {
	let allowed = false;
	let inputs = 0;
	const gate = new RfbInputGate(
		() => {},
		() => allowed,
		() => {
			inputs++;
		},
	);
	gate.feed(handshake);
	gate.feed(Buffer.concat([key(true), pointer]));
	expect(inputs).toBe(0);
	allowed = true;
	gate.feed(Buffer.concat([key(false), pointer, Buffer.from([3, 1, 0, 0, 0, 0, 5, 0, 2, 208])]));
	expect(inputs).toBe(2); // The pixel request is not input.
});
