import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	credentialStatuses,
	credentialsPath,
	openAiApiKey,
	openRouterApiKey,
	updateCredentials,
} from "../src/credentials-file";

let dir: string;
let path: string;
const noEnv = {} as NodeJS.ProcessEnv;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ateam-creds-"));
	path = join(dir, "credentials.json");
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("credentials file", () => {
	it("sits beside settings.json, so ATEAM_CONFIG moves both", () => {
		expect(credentialsPath({ ATEAM_CONFIG: "/x/y/settings.json" } as NodeJS.ProcessEnv)).toBe(
			"/x/y/credentials.json",
		);
	});

	it("reports no key before one is saved", () => {
		expect(openRouterApiKey(path, noEnv)).toBeUndefined();
		expect(openAiApiKey(path)).toBeUndefined();
		expect(credentialStatuses(path, noEnv)).toEqual({
			openRouter: { set: false },
			openAi: { set: false },
		});
	});

	it("stores a key readable only by its owner, and reports only its last four", () => {
		updateCredentials({ openRouterApiKey: " sk-or-v1-abcdef1234 " }, path);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(openRouterApiKey(path, noEnv)).toBe("sk-or-v1-abcdef1234");
		expect(credentialStatuses(path, noEnv).openRouter).toEqual({
			set: true,
			hint: "1234",
			source: "file",
		});
	});

	it("removes a key on null and keeps other entries", () => {
		updateCredentials({ openRouterApiKey: "sk-or-1" }, path);
		updateCredentials({ openRouterApiKey: null }, path);
		expect(openRouterApiKey(path, noEnv)).toBeUndefined();
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
	});

	it("lets OPENROUTER_API_KEY win over the file", () => {
		updateCredentials({ openRouterApiKey: "sk-or-file" }, path);
		const env = { OPENROUTER_API_KEY: "sk-or-envkey" } as NodeJS.ProcessEnv;
		expect(openRouterApiKey(path, env)).toBe("sk-or-envkey");
		expect(credentialStatuses(path, env).openRouter).toEqual({
			set: true,
			hint: "vkey",
			source: "env",
		});
	});

	it("keeps each key apart: saving or removing one leaves the other", () => {
		updateCredentials({ openRouterApiKey: "sk-or-1111" }, path);
		updateCredentials({ openAiApiKey: " sk-proj-2222 " }, path);
		expect(openRouterApiKey(path, noEnv)).toBe("sk-or-1111");
		expect(openAiApiKey(path)).toBe("sk-proj-2222");
		expect(credentialStatuses(path, noEnv).openAi).toEqual({
			set: true,
			hint: "2222",
			source: "file",
		});
		updateCredentials({ openAiApiKey: null }, path);
		expect(openAiApiKey(path)).toBeUndefined();
		expect(openRouterApiKey(path, noEnv)).toBe("sk-or-1111");
	});

	it("never takes an OpenAI key from OPENAI_API_KEY, which other tools set for themselves", () => {
		const env = { OPENAI_API_KEY: "sk-proj-shell" } as NodeJS.ProcessEnv;
		expect(credentialStatuses(path, env).openAi).toEqual({ set: false });
		expect(openAiApiKey(path)).toBeUndefined();
	});

	it("keeps an entry it does not know, so a save never drops a key a newer Ateam wrote", () => {
		writeFileSync(path, JSON.stringify({ someFutureKey: "x" }));
		updateCredentials({ openAiApiKey: "sk-proj-1" }, path);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			someFutureKey: "x",
			openAiApiKey: "sk-proj-1",
		});
	});
});
