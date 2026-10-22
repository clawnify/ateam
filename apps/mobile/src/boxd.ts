// The phone's way to wake a hibernated boxd box before connecting to it.
//
// The phone reaches a box over Tailscale, straight to the VM, and that path
// never wakes it: only a connection through boxd's own proxy, or boxd's API,
// does (measured; see docs/providers/boxd.md "Sleep and wake"). So with the
// user's boxd API key the phone asks the API: what state is this machine in,
// and if it's asleep, wake it.
//
// Two RPCs, each carrying one string, so this speaks grpc-web by hand instead
// of pulling in @boxd-sh/sdk: the SDK's web entry relies on AbortSignal.timeout
// and binary request bodies, neither of which React Native's fetch can be
// trusted with. This uses grpc-web's TEXT mode (base64 both ways), which is
// plain strings end to end. Wire details are from the SDK's own source
// (@boxd-sh/sdk 0.2.18, _transportWeb.js and auth.js) and boxd's proto.
//
// Pure TS, no React Native imports, so it runs under bun test.

const API = "https://boxd.sh:9443/boxd.api.v1.BoxdApi";
const EXCHANGE = "https://app.boxd.sh/api/v1/auth/token";
/** Re-exchange the key this long before the session token expires (the SDK's skew). */
const REFRESH_SKEW_S = 300;
const CALL_TIMEOUT_MS = 15_000;

/** A gRPC status from boxd, or null for a transport failure. */
export class BoxdError extends Error {
	constructor(
		message: string,
		readonly code: number | null,
	) {
		super(message);
	}
}

const GRPC_NOT_FOUND = 5;
const GRPC_PERMISSION_DENIED = 7;
const GRPC_UNAUTHENTICATED = 16;

// ── protobuf, just enough: one string field out, one string field back ──

/** `{ vm_id = 1: string }`, the request of both GetVm and WakeVm. */
export function encodeVmId(vmId: string): Uint8Array {
	const out: number[] = [0x0a]; // field 1, wire type 2 (length-delimited)
	const bytes: number[] = [];
	for (const ch of vmId) {
		const c = ch.charCodeAt(0);
		// boxd machine names are [a-z0-9-]; anything else is not a name we made.
		if (c > 0x7f) throw new BoxdError(`not a boxd machine name: ${vmId}`, null);
		bytes.push(c);
	}
	let n = bytes.length;
	while (n > 0x7f) {
		out.push((n & 0x7f) | 0x80);
		n >>>= 7;
	}
	out.push(n);
	return Uint8Array.from([...out, ...bytes]);
}

function readVarint(buf: Uint8Array, at: number): [value: number, next: number] {
	let value = 0;
	let shift = 0;
	let i = at;
	for (;;) {
		if (i >= buf.length) throw new BoxdError("boxd sent a truncated message", null);
		const b = buf[i++] as number;
		value += (b & 0x7f) * 2 ** shift;
		if (b < 0x80) return [value, i];
		shift += 7;
	}
}

/** One string field of a message (ASCII, as boxd's status values are), or null. */
export function readStringField(msg: Uint8Array, field: number): string | null {
	let i = 0;
	while (i < msg.length) {
		const [key, afterKey] = readVarint(msg, i);
		const wire = key % 8;
		const num = Math.floor(key / 8);
		i = afterKey;
		if (wire === 0) [, i] = readVarint(msg, i);
		else if (wire === 1) i += 8;
		else if (wire === 5) i += 4;
		else if (wire === 2) {
			const [len, start] = readVarint(msg, i);
			if (num === field) return String.fromCharCode(...msg.subarray(start, start + len));
			i = start + len;
		} else throw new BoxdError(`boxd sent an unknown wire type ${wire}`, null);
	}
	return null;
}

// ── grpc-web framing: [flag:1][length:4 BE][payload], 0x80 marks the trailers ──

function frame(payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(5 + payload.length);
	new DataView(out.buffer).setUint32(1, payload.length, false);
	out.set(payload, 5);
	return out;
}

function toBase64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}

function fromBase64(text: string): Uint8Array {
	// A text-mode body may be several base64 chunks back to back, each padded.
	const parts = text.replace(/\s+/g, "").match(/[^=]+=*/g) ?? [];
	const bin = parts.map((p) => atob(p)).join("");
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function parseTrailers(payload: Uint8Array): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of String.fromCharCode(...payload).split("\r\n")) {
		const at = line.indexOf(":");
		if (at > 0) out[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
	}
	return out;
}

function decodeMessage(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

/** The single message of a unary reply, or the gRPC error it carried. */
export function parseUnaryReply(body: Uint8Array): Uint8Array {
	let message: Uint8Array | null = null;
	let i = 0;
	while (i + 5 <= body.length) {
		const flag = body[i] as number;
		const len = new DataView(body.buffer, body.byteOffset + i + 1, 4).getUint32(0, false);
		const payload = body.subarray(i + 5, i + 5 + len);
		i += 5 + len;
		if (flag & 0x80) {
			const t = parseTrailers(payload);
			const status = Number(t["grpc-status"] ?? "0");
			if (status !== 0) throw statusError(status, decodeMessage(t["grpc-message"] ?? ""));
		} else {
			message = payload;
		}
	}
	if (!message) throw new BoxdError("boxd sent no reply message", null);
	return message;
}

function statusError(code: number, message: string): BoxdError {
	if (code === GRPC_UNAUTHENTICATED) return new BoxdError("boxd rejected the API key", code);
	if (code === GRPC_PERMISSION_DENIED)
		return new BoxdError("this boxd key can't reach that machine", code);
	return new BoxdError(message || `boxd error ${code}`, code);
}

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new BoxdError(`${what} timed out after ${CALL_TIMEOUT_MS / 1000}s`, null)),
			CALL_TIMEOUT_MS,
		);
		p.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}

export interface BoxdClient {
	/** The machine's status: "running", "hibernated", "standby", "waking", … */
	status(machine: string): Promise<string>;
	wake(machine: string): Promise<void>;
	/** Sign in with the key and nothing else: a rejected key throws. */
	check(): Promise<void>;
}

export function createBoxdClient(
	apiKey: string,
	opts: { fetch?: typeof fetch; now?: () => number } = {},
): BoxdClient {
	const doFetch = opts.fetch ?? fetch;
	const nowS = () => (opts.now ?? Date.now)() / 1000;
	let session: { token: string; expiresAt: number } | null = null;

	const token = async (): Promise<string> => {
		if (session && nowS() < session.expiresAt - REFRESH_SKEW_S) return session.token;
		const resp = await withTimeout(
			doFetch(EXCHANGE, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ api_key: apiKey }),
			}),
			"boxd sign-in",
		);
		if (resp.status === 401 || resp.status === 403) {
			throw new BoxdError("boxd rejected the API key", GRPC_UNAUTHENTICATED);
		}
		if (!resp.ok) throw new BoxdError(`boxd sign-in failed (HTTP ${resp.status})`, null);
		const data = (await resp.json()) as { token?: unknown; expires_at?: unknown };
		if (typeof data.token !== "string" || typeof data.expires_at !== "number") {
			throw new BoxdError("boxd sign-in returned no token", null);
		}
		session = { token: data.token, expiresAt: data.expires_at };
		return session.token;
	};

	const call = async (method: string, machine: string): Promise<Uint8Array> => {
		const resp = await withTimeout(
			doFetch(`${API}/${method}`, {
				method: "POST",
				headers: {
					"content-type": "application/grpc-web-text",
					accept: "application/grpc-web-text",
					"x-grpc-web": "1",
					authorization: `Bearer ${await token()}`,
				},
				body: toBase64(frame(encodeVmId(machine))),
			}),
			`boxd ${method}`,
		);
		// A rejection before any message arrives as trailers-only headers.
		const headerStatus = resp.headers.get("grpc-status");
		if (headerStatus !== null && headerStatus !== "0") {
			const code = Number(headerStatus);
			if (code === GRPC_UNAUTHENTICATED) session = null; // re-exchange next time
			throw statusError(code, decodeMessage(resp.headers.get("grpc-message") ?? ""));
		}
		if (!resp.ok) throw new BoxdError(`boxd ${method} failed (HTTP ${resp.status})`, null);
		const type = resp.headers.get("content-type") ?? "";
		const body = type.includes("text")
			? fromBase64(await resp.text())
			: new Uint8Array(await resp.arrayBuffer());
		return parseUnaryReply(body);
	};

	return {
		async status(machine) {
			try {
				// GetVmResponse.status is field 5.
				return readStringField(await call("GetVm", machine), 5) ?? "unknown";
			} catch (err) {
				if (err instanceof BoxdError && err.code === GRPC_NOT_FOUND) {
					throw new BoxdError(`boxd has no machine named ${machine}`, GRPC_NOT_FOUND);
				}
				throw err;
			}
		},
		async wake(machine) {
			await call("WakeVm", machine);
		},
		async check() {
			await token();
		},
	};
}

/** States a box comes back from with WakeVm. */
const ASLEEP = new Set(["hibernated", "standby", "hibernating", "suspended"]);

/**
 * Make sure `machine` is up before the phone connects. Returns what it found:
 * "running" means nothing was done. Waits for the wake to land so the connect
 * that follows doesn't race a box still coming up.
 */
export async function ensureAwake(
	client: BoxdClient,
	machine: string,
	opts: { pollMs?: number; maxWaitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string> {
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const pollMs = opts.pollMs ?? 1_000;
	const maxWaitMs = opts.maxWaitMs ?? 20_000;
	const before = await client.status(machine);
	if (before === "running") return before;
	if (before === "stopped") {
		throw new BoxdError(`${machine} is stopped, not asleep: start it from boxd`, null);
	}
	if (ASLEEP.has(before)) await client.wake(machine);
	for (let waited = 0; waited < maxWaitMs; waited += pollMs) {
		if ((await client.status(machine)) === "running") return before;
		await sleep(pollMs);
	}
	throw new BoxdError(`${machine} didn't wake within ${maxWaitMs / 1000}s`, null);
}
