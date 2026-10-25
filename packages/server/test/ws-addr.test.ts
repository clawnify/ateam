// The phone listener's address: the variable when set, else the installer's file.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWsAddr, WS_ADDR_FILE } from "../src/ws-addr";

function dataDir(fileContent?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "ateam-ws-addr-"));
	if (fileContent !== undefined) writeFileSync(join(dir, WS_ADDR_FILE), fileContent);
	return dir;
}

describe("the phone listener's address", () => {
	test("an engine started without the variable reads the installer's file", () => {
		expect(resolveWsAddr({}, dataDir("100.94.46.10:8787\n"))).toBe("100.94.46.10:8787");
	});

	test("the variable wins over the file", () => {
		const dir = dataDir("100.94.46.10:8787\n");
		expect(resolveWsAddr({ ATEAM_WS_ADDR: "127.0.0.1:8787" }, dir)).toBe("127.0.0.1:8787");
	});

	test("with neither, there is no listener", () => {
		expect(resolveWsAddr({}, dataDir())).toBeUndefined();
	});

	test("a blank variable or file counts as unset", () => {
		expect(resolveWsAddr({ ATEAM_WS_ADDR: "  " }, dataDir("100.64.0.1:8787"))).toBe(
			"100.64.0.1:8787",
		);
		expect(resolveWsAddr({}, dataDir("\n"))).toBeUndefined();
	});
});
