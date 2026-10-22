import { describe, expect, test } from "bun:test";
import { PROVIDERS, providerById } from "../src/index";

// Ids and input keys name Keychain items on the phone (`ateam.provider.<id>.<key>`),
// which allow only these characters.
const KEYCHAIN_SAFE = /^[A-Za-z0-9._-]+$/;

describe("provider definitions", () => {
	test("ids are unique and Keychain-safe", () => {
		const ids = PROVIDERS.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(id).toMatch(KEYCHAIN_SAFE);
	});

	test("a wake definition declares inputs with unique, Keychain-safe keys", () => {
		for (const p of PROVIDERS) {
			if (!p.wake) continue;
			const keys = p.wake.inputs.map((i) => i.key);
			expect(keys.length).toBeGreaterThan(0);
			expect(new Set(keys).size).toBe(keys.length);
			for (const key of keys) expect(key).toMatch(KEYCHAIN_SAFE);
		}
	});

	test("looks a provider up by id, and nothing up by nothing", () => {
		expect(providerById("boxd")?.label).toBe("boxd");
		expect(providerById("nope")).toBeUndefined();
		expect(providerById(null)).toBeUndefined();
	});
});
