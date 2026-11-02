// The phone's Sprites wake: what it asks Sprites for, and how it reads the answers.
import { describe, expect, test } from "bun:test";
import { createSpritesClient, holdCommand, WAKE_HOLD, WAKE_HOLD_EXPIRE, SpritesError } from "./wake-sprites";

/** A fake Sprites API that records each request and answers with `reply`. */
function fakeSprites(reply: (url: URL) => Response) {
	const seen: { method: string; url: URL; auth: string | null }[] = [];
	const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const headers = new Headers(init?.headers);
		seen.push({ method: init?.method ?? "GET", url, auth: headers.get("authorization") });
		return reply(url);
	}) as unknown as typeof fetch;
	return { seen, doFetch };
}

describe("holdCommand", () => {
	test("puts the phone's own hold on the Sprite's API socket", () => {
		const [shell, flag, script] = holdCommand();
		expect([shell, flag]).toEqual(["bash", "-c"]);
		expect(script).toContain("--unix-socket /.sprite/api.sock");
		expect(script).toContain(`/v1/tasks/${WAKE_HOLD}`);
		expect(script).toContain(JSON.stringify({ expire: WAKE_HOLD_EXPIRE }));
	});
});

describe("createSpritesClient", () => {
	test("wakes through the exec API with the hold as its command, signed with the token", async () => {
		const fake = fakeSprites(() => new Response("200", { status: 200 }));
		await createSpritesClient("my-org/1/2/secret", { fetch: fake.doFetch }).wake("ateam-box");
		const [req] = fake.seen;
		expect(req?.method).toBe("POST");
		expect(`${req?.url.origin}${req?.url.pathname}`).toBe(
			"https://api.sprites.dev/v1/sprites/ateam-box/exec",
		);
		expect(req?.url.searchParams.getAll("cmd")).toEqual(holdCommand());
		expect(req?.auth).toBe("Bearer my-org/1/2/secret");
	});

	test("a rejected token says so", async () => {
		const fake = fakeSprites(() => new Response("unauthorized", { status: 401 }));
		const err = await createSpritesClient("bad", { fetch: fake.doFetch })
			.wake("ateam-box")
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SpritesError);
		expect((err as SpritesError).message).toBe("Sprites rejected the token");
	});

	test("an unknown Sprite is named", async () => {
		const fake = fakeSprites(() => new Response("not found", { status: 404 }));
		await expect(createSpritesClient("t", { fetch: fake.doFetch }).wake("nope")).rejects.toThrow(
			"Sprites has no Sprite named nope",
		);
	});

	test("a Sprite that woke but refused the hold is an error, not a wake", async () => {
		// The exec answers with the socket's own status: 400 is a hold the Sprite refused.
		const fake = fakeSprites(() => new Response("400", { status: 200 }));
		await expect(createSpritesClient("t", { fetch: fake.doFetch }).wake("ateam-box")).rejects.toThrow(
			"its hold didn't take (400)",
		);
	});

	// Sprites' exec answers in its stream frames (since late Oct 2026): 0x01 before stdout,
	// 0x02 before stderr, 0x03 and the exit code at the end. These are real answers, recorded.
	test("a framed answer is read for its stdout: the hold took", async () => {
		const fake = fakeSprites(() => new Response("\x01200\x03\x00", { status: 200 }));
		await createSpritesClient("t", { fetch: fake.doFetch }).wake("ateam-box");
	});

	test("stderr and the exit code in a framed answer are not read as the status", async () => {
		const fake = fakeSprites(() => new Response("\x0120\x02warn\x010\x03\x00", { status: 200 }));
		await createSpritesClient("t", { fetch: fake.doFetch }).wake("ateam-box");
	});

	test("a framed answer that lost its first tag on the way still reads as the status", async () => {
		const fake = fakeSprites(() => new Response("200\x03\x00", { status: 200 }));
		await createSpritesClient("t", { fetch: fake.doFetch }).wake("ateam-box");
	});

	test("a framed refusal is still an error, named by its status", async () => {
		// curl prints 000 and exits 7 when the Sprite's API socket isn't there.
		const fake = fakeSprites(() => new Response("\x01000\x03\x07", { status: 200 }));
		await expect(createSpritesClient("t", { fetch: fake.doFetch }).wake("ateam-box")).rejects.toThrow(
			"its hold didn't take (000)",
		);
	});

	test("check lists Sprites with the token and nothing else", async () => {
		const fake = fakeSprites(() => new Response('{"sprites":[]}', { status: 200 }));
		await createSpritesClient("t", { fetch: fake.doFetch }).check();
		expect(fake.seen.map((r) => `${r.method} ${r.url.pathname}`)).toEqual(["GET /v1/sprites"]);
	});

	test("check rejects a token Sprites won't take", async () => {
		const fake = fakeSprites(() => new Response("forbidden", { status: 403 }));
		await expect(createSpritesClient("t", { fetch: fake.doFetch }).check()).rejects.toThrow(
			"Sprites rejected the token",
		);
	});
});
