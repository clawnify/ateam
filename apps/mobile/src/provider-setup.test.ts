import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { providerById } from "@ateam/protocol";
import { PROVIDER_LOGOS } from "./provider-logos";
import { PROVIDER_SETUPS } from "./provider-setup";

const DOCS = join(import.meta.dir, "..", "..", "..", "docs", "providers");

test("every provider on Create a box leads somewhere", () => {
	for (const p of PROVIDER_SETUPS) {
		// The app creates it, the phone reaches it over SSH, or it's set up on a computer.
		expect(Boolean(p.creates) || Boolean(p.ssh) || Boolean(p.computer)).toBe(true);
		expect(p.ssh?.user ?? "x").toMatch(/^[a-z_][a-z0-9_-]*$/);
		for (const s of p.steps ?? []) if (s.link) expect(s.link.url).toStartWith("https://");
	}
	// The way in for any server is last, with the server glyph rather than a mark.
	expect(PROVIDER_SETUPS.at(-1)?.ssh?.user).toBe("root");
	expect(PROVIDER_LOGOS[PROVIDER_SETUPS.at(-1)?.id ?? ""]).toBeUndefined();
	expect(PROVIDER_LOGOS.hetzner).toBeDefined();
	expect(PROVIDER_LOGOS.boxd).toBeDefined();
});

test("a boxd machine is reached as boxd, with its token as the password", () => {
	const boxd = PROVIDER_SETUPS.find((p) => p.id === "boxd");
	expect(boxd?.ssh).toMatchObject({ user: "boxd", password: { label: "boxd token" } });
});

test("a provider set up on a computer links to its guide in this repo, and wakes through a known provider", () => {
	const computer = PROVIDER_SETUPS.filter((p) => p.computer);
	expect(computer.map((p) => p.id)).toEqual(["sprites", "exe-dev"]);
	for (const p of computer) {
		const guide = p.computer?.guide ?? "";
		// The commands live in docs/providers/<page>.md under "## iOS": it must exist.
		const page = guide.match(
			/^https:\/\/github\.com\/clawnify\/ateam\/blob\/main\/docs\/providers\/([a-z-]+)\.md#ios$/,
		)?.[1];
		expect(page).toBeDefined();
		expect(readFileSync(join(DOCS, `${page}.md`), "utf8")).toContain("\n## iOS\n");
		const wake = p.computer?.wakeProvider;
		if (wake) expect(providerById(wake)?.wake).toBeDefined();
	}
	// Sprites sleep, and the phone wakes them; an exe.dev VM never sleeps.
	expect(PROVIDER_SETUPS.find((p) => p.id === "sprites")?.computer?.wakeProvider).toBe("sprites");
	expect(PROVIDER_SETUPS.find((p) => p.id === "exe-dev")?.computer?.wakeProvider).toBeUndefined();
});
