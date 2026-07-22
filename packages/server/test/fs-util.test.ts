import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CH } from "@ateam/protocol";
import { createTestDb } from "../../db/test/helpers/test-db";
import { createDispatcher } from "../src/dispatcher";
import type { Engine } from "../src/engine";

// The dispatcher only touches services.{db,userDataDir} for these handlers.
function makeEngine(userDataDir: string): Engine {
	return {
		services: {
			db: createTestDb(),
			pty: { has: () => false },
			mergeQueue: {},
			loopRunner: { describe: () => [] },
			userDataDir,
		},
		sendTaskUpdated: () => {},
		sendLoopsUpdated: () => {},
	} as unknown as Engine;
}

describe("fs:listDir (remote-native repo picker)", () => {
	it("lists subdirectories only, flags git repos, and exposes the parent", async () => {
		const root = mkdtempSync(join(tmpdir(), "ateam-fs-"));
		mkdirSync(join(root, "plain"));
		mkdirSync(join(root, "repo", ".git"), { recursive: true });
		writeFileSync(join(root, "afile.txt"), "x"); // files are excluded from the listing
		const d = createDispatcher(makeEngine(root));

		const listing = (await d.handle(CH.fsListDir, [root])) as {
			path: string;
			parent: string | null;
			entries: { name: string; path: string; isRepo: boolean }[];
		};

		expect(listing.path).toBe(root);
		expect(listing.parent).not.toBeNull();
		// Sorted, directories only (no afile.txt).
		expect(listing.entries.map((e) => e.name)).toEqual(["plain", "repo"]);
		expect(listing.entries.find((e) => e.name === "repo")?.isRepo).toBe(true);
		expect(listing.entries.find((e) => e.name === "plain")?.isRepo).toBe(false);
		expect(listing.entries.find((e) => e.name === "repo")?.path).toBe(join(root, "repo"));
	});

	it("rejects (via the dispatcher) a path that does not exist", async () => {
		const d = createDispatcher(makeEngine(mkdtempSync(join(tmpdir(), "ateam-fs2-"))));
		expect(d.handle(CH.fsListDir, [join(tmpdir(), "definitely-not-here-xyz")])).rejects.toThrow();
	});
});

describe("util:writeImageBytes (remote image attach)", () => {
	it("writes the decoded bytes under attachments/ and returns the path", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "ateam-att-"));
		const d = createDispatcher(makeEngine(dataDir));
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

		const file = (await d.handle(CH.utilWriteImageBytes, [png.toString("base64")])) as string;

		expect(file.startsWith(join(tmpdir(), "ateam-attachments"))).toBe(true);
		expect(file.endsWith(".png")).toBe(true);
		expect(existsSync(file)).toBe(true);
		expect(readFileSync(file).equals(png)).toBe(true);
	});

	it("sanitizes the extension so it can't inject a path or separator", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "ateam-att2-"));
		const d = createDispatcher(makeEngine(dataDir));
		const file = (await d.handle(CH.utilWriteImageBytes, ["", "../evil.jpg"])) as string;
		// Non-alphanumerics stripped: "../evil.jpg" → "eviljpg"; no traversal survives.
		expect(file.endsWith(".eviljpg")).toBe(true);
		expect(file.startsWith(join(tmpdir(), "ateam-attachments"))).toBe(true);
	});
});
