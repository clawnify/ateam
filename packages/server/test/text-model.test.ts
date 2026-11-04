import { afterEach, describe, expect, it } from "bun:test";
import { DEFAULT_OPENAI_TEXT_MODEL, DEFAULT_OPENROUTER_TEXT_MODEL } from "@ateam/protocol";
import { looksSecret, redactSecrets } from "../src/secrets";
import { askTextModel, resolveTextModel } from "../src/text-model";

const KEY = "sk-or-v1-test";
const OPENAI_KEY = "sk-proj-test";
const OR = { openRouter: KEY };
const OAI = { openAi: OPENAI_KEY };
const NONE = {};

describe("resolveTextModel", () => {
	const engine = (
		textModel: string,
		openRouterTextModel = "google/gemini-2.5-flash-lite",
		openAiTextModel = "gpt-6-luna-pro",
	) =>
		({ textModel, openRouterTextModel, openAiTextModel }) as Parameters<typeof resolveTextModel>[0];

	it("automatic: OpenRouter with its key, else OpenAI with its key, else Claude Code", () => {
		expect(resolveTextModel(engine("auto"), OR)).toEqual({
			kind: "openrouter",
			model: "google/gemini-2.5-flash-lite",
			apiKey: KEY,
		});
		expect(resolveTextModel(engine("auto"), { ...OR, ...OAI })?.kind).toBe("openrouter");
		expect(resolveTextModel(engine("auto"), OAI)).toEqual({
			kind: "openai",
			model: "gpt-6-luna-pro",
			apiKey: OPENAI_KEY,
		});
		expect(resolveTextModel(engine("auto"), NONE)).toEqual({ kind: "claude" });
	});

	it("a provider chosen without its key writes nothing rather than switching provider", () => {
		expect(resolveTextModel(engine("openrouter"), OAI)).toBeNull();
		expect(resolveTextModel(engine("openai"), OR)).toBeNull();
	});

	it("Claude Code and Off mean what they say, key or not", () => {
		expect(resolveTextModel(engine("claude"), { ...OR, ...OAI })).toEqual({ kind: "claude" });
		expect(resolveTextModel(engine("off"), { ...OR, ...OAI })).toBeNull();
	});

	it("an empty model id falls back to the default, an unknown choice to automatic", () => {
		expect(resolveTextModel(engine("openrouter", "  "), OR)).toEqual({
			kind: "openrouter",
			model: DEFAULT_OPENROUTER_TEXT_MODEL,
			apiKey: KEY,
		});
		expect(resolveTextModel(engine("openai", "x", ""), OAI)).toEqual({
			kind: "openai",
			model: DEFAULT_OPENAI_TEXT_MODEL,
			apiKey: OPENAI_KEY,
		});
		expect(resolveTextModel(engine("banana"), NONE)).toEqual({ kind: "claude" });
	});
});

describe("askTextModel over OpenRouter", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	function stubFetch(respond: (body: Record<string, unknown>) => Response) {
		const sent: Record<string, unknown>[] = [];
		globalThis.fetch = (async (_url: string, init: RequestInit) => {
			const body = JSON.parse(String(init.body)) as Record<string, unknown>;
			sent.push(body);
			return respond(body);
		}) as unknown as typeof fetch;
		return sent;
	}

	const target = { kind: "openrouter", model: "anthropic/claude-haiku-5.5", apiKey: KEY } as const;

	it("returns the reply, and never sends a key-looking string", async () => {
		const sent = stubFetch(() =>
			Response.json({ choices: [{ message: { content: "Board loads faster." } }] }),
		);
		const reply = await askTextModel(target, {
			prompt: "summarize: I set OPENAI to sk-proj-abcdef0123456789xyz and it works",
			maxTokens: 100,
			timeoutMs: 1_000,
		});
		expect(reply).toBe("Board loads faster.");
		const content = (sent[0]?.messages as { content: string }[])[0]?.content ?? "";
		expect(content).not.toContain("sk-proj-abcdef0123456789xyz");
		expect(content).toContain("[redacted]");
		expect(sent[0]?.model).toBe("anthropic/claude-haiku-5.5");
	});

	it("turns reasoning off, and retries with room to reason for a model that must", async () => {
		const sent = stubFetch((body) =>
			body.reasoning
				? new Response('{"error":{"message":"Reasoning is mandatory"}}', { status: 400 })
				: Response.json({ choices: [{ message: { content: "Theme not persisted" } }] }),
		);
		const reply = await askTextModel(target, {
			prompt: "title?",
			maxTokens: 120,
			timeoutMs: 1_000,
		});
		expect(reply).toBe("Theme not persisted");
		expect(sent[0]?.reasoning).toEqual({ effort: "none" });
		expect(sent[0]?.max_tokens).toBe(120);
		expect(sent[1]?.reasoning).toBeUndefined();
		expect(Number(sent[1]?.max_tokens)).toBeGreaterThanOrEqual(2_000);
	});

	it("returns empty on a failed call, so the caller's fallback stands", async () => {
		stubFetch(() => new Response("no credit", { status: 402 }));
		expect(await askTextModel(target, { prompt: "x", maxTokens: 10, timeoutMs: 1_000 })).toBe("");
		stubFetch(() => Response.json({ choices: [] }));
		expect(await askTextModel(target, { prompt: "x", maxTokens: 10, timeoutMs: 1_000 })).toBe("");
	});
});

describe("askTextModel over OpenAI", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});
	const target = { kind: "openai", model: "gpt-6-luna", apiKey: OPENAI_KEY } as const;

	it("calls Chat Completions with OpenAI's names for reasoning off and the budget", async () => {
		const seen: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] =
			[];
		globalThis.fetch = (async (url: string, init: RequestInit) => {
			seen.push({
				url,
				body: JSON.parse(String(init.body)),
				headers: init.headers as Record<string, string>,
			});
			return Response.json({ choices: [{ message: { content: "Fix flaky login test" } }] });
		}) as unknown as typeof fetch;
		const reply = await askTextModel(target, {
			prompt: "title?",
			maxTokens: 120,
			timeoutMs: 1_000,
		});
		expect(reply).toBe("Fix flaky login test");
		expect(seen[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
		expect(seen[0]?.headers.Authorization).toBe(`Bearer ${OPENAI_KEY}`);
		expect(seen[0]?.headers["X-Title"]).toBeUndefined();
		expect(seen[0]?.body).toEqual({
			model: "gpt-6-luna",
			messages: [{ role: "user", content: "title?" }],
			max_completion_tokens: 120,
			reasoning_effort: "none",
		});
	});

	it("retries without reasoning_effort, with room to reason, for a model that must", async () => {
		const sent: Record<string, unknown>[] = [];
		globalThis.fetch = (async (_url: string, init: RequestInit) => {
			const body = JSON.parse(String(init.body)) as Record<string, unknown>;
			sent.push(body);
			return body.reasoning_effort
				? new Response('{"error":{"message":"Unsupported value"}}', { status: 400 })
				: Response.json({ choices: [{ message: { content: "ok" } }] });
		}) as unknown as typeof fetch;
		expect(await askTextModel(target, { prompt: "x", maxTokens: 120, timeoutMs: 1_000 })).toBe(
			"ok",
		);
		expect(sent[1]?.reasoning_effort).toBeUndefined();
		expect(Number(sent[1]?.max_completion_tokens)).toBeGreaterThanOrEqual(2_000);
	});
});

describe("redactSecrets", () => {
	it("removes tokens and key-like runs, and keeps ordinary text", () => {
		expect(redactSecrets("token ghp_abcdefghijklmnopqrstuvwxyz0123 here")).toBe(
			"token [redacted] here",
		);
		expect(redactSecrets("sha 3f9a1c0be47d2a6f9e8b7c6d5a4b3c2d1e0f9a8b")).toBe("sha [redacted]");
		const plain =
			"rename syncEngineSettingsToBoxesEverywhereAtOnce in apps/desktop/src/main/host.ts";
		expect(redactSecrets(plain)).toBe(plain);
	});

	it("agrees with looksSecret on what is a secret", () => {
		for (const text of [
			"use sk-or-v1-abcdef0123456789 for it",
			"fix the bug wich breaks the build",
		]) {
			expect(redactSecrets(text) !== text).toBe(looksSecret(text));
		}
	});
});
