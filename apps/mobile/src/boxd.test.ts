// The phone's boxd wake client, against a fake boxd that speaks its wire format.
//
// boxd.ts imports nothing from React Native, so it runs under plain bun, like
// connection.test.ts. What it pins is the wire contract (token exchange, the
// grpc-web text framing, the one protobuf field read back) and the wake flow.
import { describe, expect, test } from "bun:test";
import {
	type BoxdClient,
	BoxdError,
	createBoxdClient,
	encodeVmId,
	ensureAwake,
	parseUnaryReply,
	readStringField,
} from "./boxd";

function frame(flag: number, payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(5 + payload.length);
	out[0] = flag;
	new DataView(out.buffer).setUint32(1, payload.length, false);
	out.set(payload, 5);
	return out;
}
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** A GetVmResponse: vm_id (1), name (2), status (5), plus a varint field to skip. */
function getVmResponse(status: string): Uint8Array {
	const str = (field: number, s: string) =>
		concat(Uint8Array.of((field << 3) | 2, s.length), ascii(s));
	return concat(
		str(1, "23ac77df"),
		str(2, "mybox"),
		Uint8Array.of(8 << 3, 0xac, 0x02),
		str(5, status),
	);
}
const okTrailers = frame(0x80, ascii("grpc-status: 0\r\ngrpc-message: \r\n"));

describe("wire format", () => {
	test("a vm id is field 1, length-delimited", () => {
		expect([...encodeVmId("mybox")]).toEqual([0x0a, 5, ...ascii("mybox")]);
	});

	test("reads status (field 5) past fields of other wire types", () => {
		expect(readStringField(getVmResponse("hibernated"), 5)).toBe("hibernated");
		expect(readStringField(getVmResponse("running"), 9)).toBeNull();
	});

	test("a trailer frame with a status is an error", () => {
		const body = frame(0x80, ascii("grpc-status: 5\r\ngrpc-message: no%20such%20vm\r\n"));
		expect(() => parseUnaryReply(body)).toThrow("no such vm");
	});
});

/** A fake boxd: the token exchange plus GetVm/WakeVm over grpc-web text. */
function fakeBoxd(opts: { statuses: string[]; rejectKey?: boolean }) {
	const seen: { url: string; init: RequestInit }[] = [];
	let exchanges = 0;
	const statuses = [...opts.statuses];
	const doFetch = (async (url: string, init: RequestInit) => {
		seen.push({ url, init });
		if (url.endsWith("/api/v1/auth/token")) {
			exchanges += 1;
			if (opts.rejectKey) return new Response("bad key", { status: 401 });
			return Response.json({ token: "jwt-1", expires_at: Date.now() / 1000 + 3600 });
		}
		const method = url.split("/").pop();
		const reply =
			method === "GetVm"
				? frame(
						0,
						getVmResponse(
							statuses.length > 1 ? (statuses.shift() as string) : (statuses[0] as string),
						),
					)
				: frame(0, new Uint8Array(0)); // WakeVmResponse {}
		return new Response(b64(concat(reply, okTrailers)), {
			headers: { "content-type": "application/grpc-web-text+proto" },
		});
	}) as unknown as typeof fetch;
	return { doFetch, seen, exchanges: () => exchanges };
}

describe("createBoxdClient", () => {
	test("exchanges the key once, then calls GetVm with the token over grpc-web text", async () => {
		const fake = fakeBoxd({ statuses: ["hibernated"] });
		const client = createBoxdClient("bxd_test", { fetch: fake.doFetch });
		expect(await client.status("mybox")).toBe("hibernated");
		expect(await client.status("mybox")).toBe("hibernated");
		expect(fake.exchanges()).toBe(1);

		const exchange = fake.seen[0];
		expect(exchange?.url).toBe("https://app.boxd.sh/api/v1/auth/token");
		expect(JSON.parse(String(exchange?.init.body))).toEqual({ api_key: "bxd_test" });

		const rpc = fake.seen[1];
		expect(rpc?.url).toBe("https://boxd.sh:9443/boxd.api.v1.BoxdApi/GetVm");
		const headers = rpc?.init.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer jwt-1");
		expect(headers["content-type"]).toBe("application/grpc-web-text");
		// The body is the base64 of one frame holding { vm_id: "mybox" }.
		expect(rpc?.init.body).toBe(b64(frame(0, encodeVmId("mybox"))));
	});

	test("a rejected key says so", async () => {
		const client = createBoxdClient("bxd_bad", {
			fetch: fakeBoxd({ statuses: [], rejectKey: true }).doFetch,
		});
		await expect(client.status("mybox")).rejects.toThrow("boxd rejected the API key");
	});

	test("a trailers-only rejection is read from the headers", async () => {
		const doFetch = (async (url: string) =>
			url.endsWith("/auth/token")
				? Response.json({ token: "t", expires_at: Date.now() / 1000 + 3600 })
				: new Response("", {
						headers: { "grpc-status": "5", "grpc-message": "vm%20not%20found" },
					})) as unknown as typeof fetch;
		const err = await createBoxdClient("k", { fetch: doFetch })
			.status("gone")
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(BoxdError);
		expect((err as BoxdError).message).toBe("boxd has no machine named gone");
	});

	test("check signs in and calls nothing else", async () => {
		const fake = fakeBoxd({ statuses: [] });
		await createBoxdClient("bxd_test", { fetch: fake.doFetch }).check();
		expect(fake.exchanges()).toBe(1);
		expect(fake.seen.map((s) => s.url)).toEqual(["https://app.boxd.sh/api/v1/auth/token"]);
	});

	test("check rejects a key boxd won't take", async () => {
		const client = createBoxdClient("bxd_bad", {
			fetch: fakeBoxd({ statuses: [], rejectKey: true }).doFetch,
		});
		await expect(client.check()).rejects.toThrow("boxd rejected the API key");
	});
});

describe("ensureAwake", () => {
	const noSleep = async () => {};

	function scripted(statuses: string[]): BoxdClient & { wakes: number } {
		const queue = [...statuses];
		const c = {
			wakes: 0,
			status: async () => (queue.length > 1 ? (queue.shift() as string) : (queue[0] as string)),
			wake: async () => {
				c.wakes += 1;
			},
			check: async () => {},
		};
		return c;
	}

	test("a running box is left alone", async () => {
		const c = scripted(["running"]);
		expect(await ensureAwake(c, "mybox", { sleep: noSleep })).toBe("running");
		expect(c.wakes).toBe(0);
	});

	test("a hibernated box is woken, and the call returns once it runs", async () => {
		const c = scripted(["hibernated", "waking", "waking", "running"]);
		expect(await ensureAwake(c, "mybox", { sleep: noSleep })).toBe("hibernated");
		expect(c.wakes).toBe(1);
	});

	test("a box already waking is waited for, not woken twice", async () => {
		const c = scripted(["waking", "running"]);
		await ensureAwake(c, "mybox", { sleep: noSleep });
		expect(c.wakes).toBe(0);
	});

	test("a stopped box is not something wake can fix", async () => {
		await expect(ensureAwake(scripted(["stopped"]), "mybox", { sleep: noSleep })).rejects.toThrow(
			"stopped, not asleep",
		);
	});

	test("gives up if it never comes up", async () => {
		const c = scripted(["hibernated", "waking"]);
		await expect(
			ensureAwake(c, "mybox", { sleep: noSleep, pollMs: 1000, maxWaitMs: 3000 }),
		).rejects.toThrow("didn't wake within 3s");
	});
});
