import { expect, test } from "bun:test";
import { PROVIDER_LOGOS } from "./provider-logos";
import { PROVIDER_SETUPS } from "./provider-setup";

test("every provider on Create a box leads somewhere", () => {
	for (const p of PROVIDER_SETUPS) {
		// The app creates it, or the phone reaches it over SSH afterwards.
		expect(Boolean(p.creates) || Boolean(p.ssh)).toBe(true);
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
