// The phone's provider marks are the repo's assets/providers/<id>.svg, path for path,
// so a logo updated in one place can't quietly go stale in the other.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROVIDER_LOGOS } from "./provider-logos";

const ASSETS = join(import.meta.dir, "..", "..", "..", "assets", "providers");

describe("provider logos", () => {
	for (const [id, logo] of Object.entries(PROVIDER_LOGOS)) {
		test(`${id} matches assets/providers/${id}.svg`, () => {
			const svg = readFileSync(join(ASSETS, `${id}.svg`), "utf8");
			expect(svg.match(/viewBox="([^"]+)"/)?.[1]).toBe(logo.viewBox);
			expect([...svg.matchAll(/\bd="([^"]+)"/g)].map((m) => m[1])).toEqual([logo.d]);
			const fill = svg.match(/<svg[^>]*\bfill="([^"]+)"/)?.[1];
			expect(fill === "currentColor" ? null : fill).toBe(logo.fill);
		});
	}
});
