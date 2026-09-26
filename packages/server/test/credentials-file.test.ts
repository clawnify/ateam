import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	credentialStatus,
	credentialsPath,
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
		expect(credentialStatus(path, noEnv)).toEqual({ set: false });
	});

	it("stores a key readable only by its owner, and reports only its last four", () => {
		updateCredentials({ openRouterApiKey: " sk-or-v1-abcdef1234 " }, path);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(openRouterApiKey(path, noEnv)).toBe("sk-or-v1-abcdef1234");
		expect(credentialStatus(path, noEnv)).toEqual({ set: true, hint: "1234", source: "file" });
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
		expect(credentialStatus(path, env)).toEqual({ set: true, hint: "vkey", source: "env" });
	});
});
