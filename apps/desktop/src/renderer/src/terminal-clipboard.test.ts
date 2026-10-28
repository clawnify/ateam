import { expect, test } from "bun:test";
import { osc52Text } from "./terminal-clipboard";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

test("decodes a clipboard write", () => {
	expect(osc52Text(`c;${b64("https://dashboard.stripe.com/profiles")}`)).toBe(
		"https://dashboard.stripe.com/profiles",
	);
});

test("decodes multi-byte UTF-8, not Latin-1", () => {
	expect(osc52Text(`c;${b64("café · ✓")}`)).toBe("café · ✓");
});

test("accepts an empty or other selection target", () => {
	expect(osc52Text(`;${b64("x")}`)).toBe("x");
	expect(osc52Text(`p;${b64("x")}`)).toBe("x");
});

test("never answers a clipboard read", () => {
	expect(osc52Text("c;?")).toBeNull();
});

test("ignores malformed payloads", () => {
	expect(osc52Text("")).toBeNull();
	expect(osc52Text("c;")).toBeNull();
	expect(osc52Text("no-separator")).toBeNull();
	expect(osc52Text("c;!!!not base64")).toBeNull();
	expect(osc52Text(`c;${Buffer.from([0xff, 0xfe]).toString("base64")}`)).toBeNull();
});
