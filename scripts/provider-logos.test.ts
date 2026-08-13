// Provider logos are contributed by PR and rendered by the app in fixed-size
// slots, so the constraints that matter are shape and self-containment. Stating
// them in docs/providers/README.md isn't enough — an unenforced asset rule is
// exactly how `ateam-server.tar.gz` went missing from two releases. This runs in
// `bun test`, so it guards CI and contributors' machines with no extra wiring.
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..", "assets", "providers");
const MAX_BYTES = 20 * 1024;

const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".svg")) : [];

describe("provider logos", () => {
	it("live in assets/providers", () => {
		expect(existsSync(DIR)).toBe(true);
	});

	for (const file of files) {
		describe(file, () => {
			const path = join(DIR, file);
			const svg = readFileSync(path, "utf8");

			// The app draws these at one size in a list; a wide mark either letterboxes
			// with dead space or gets squashed, and neither is the provider's brand.
			it("is square (1:1)", () => {
				const viewBox = svg.match(/viewBox\s*=\s*"([^"]+)"/)?.[1];
				expect(viewBox, `${file}: no viewBox`).toBeDefined();
				const nums = (viewBox as string).trim().split(/[\s,]+/).map(Number);
				expect(nums, `${file}: viewBox needs 4 numbers`).toHaveLength(4);
				expect(nums.every(Number.isFinite)).toBe(true);
				expect(nums[2], `${file}: viewBox is not 1:1`).toBe(nums[3] as number);

				// An explicit width/height must not re-introduce a ratio the viewBox ruled out.
				const w = svg.match(/\bwidth\s*=\s*"([\d.]+)"/)?.[1];
				const h = svg.match(/\bheight\s*=\s*"([\d.]+)"/)?.[1];
				if (w && h) expect(Number(w), `${file}: width/height not 1:1`).toBe(Number(h));
			});

			// Bundled into a desktop app under a strict CSP, and it must render offline.
			it("is self-contained — no scripts, no remote references", () => {
				expect(svg, `${file}: contains a script`).not.toMatch(/<script/i);
				// xmlns values are namespace identifiers, never fetched — everything else is.
				const withoutNamespaces = svg.replace(/xmlns(:\w+)?\s*=\s*"[^"]*"/g, "");
				expect(withoutNamespaces, `${file}: references a remote URL`).not.toMatch(
					/https?:\/\//i,
				);
			});

			it("is small enough to ship in the binary", () => {
				expect(statSync(path).size).toBeLessThanOrEqual(MAX_BYTES);
			});
		});
	}
});
