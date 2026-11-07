import { expect, test } from "bun:test";
import type { ProviderOptions } from "@ateam/protocol";
import {
	boxNameOf,
	defaultBoxName,
	defaultsOf,
	newDeviceToken,
	phoneCloudInit,
	priceLine,
} from "./create-box";

const bytes =
	(...b: number[]) =>
	() =>
		Uint8Array.from(b);

const options: ProviderOptions = {
	locations: [
		{ slug: "sin", label: "Singapore (SG)" },
		{ slug: "nbg1", label: "Nuremberg (DE)" },
	],
	serverTypes: [
		{ slug: "cx23", label: "CX23", locations: ["nbg1"], memory: 4, monthly: { nbg1: 4.1531 } },
		{ slug: "cpx12", label: "CPX12", locations: ["sin", "nbg1"], memory: 2, monthly: {} },
		{ slug: "cx33", label: "CX33", locations: ["nbg1"], memory: 8, monthly: { nbg1: 7.1281 } },
	],
	currency: "EUR",
	ipv4Monthly: { nbg1: 0.6069 },
};

test("names a new box with a fresh suffix, and turns a typed name into a DNS label", () => {
	expect(defaultBoxName(bytes(0, 1, 2, 30))).toBe("ateam-abc9");
	expect(boxNameOf("  My Box!! ")).toBe("my-box");
	expect(boxNameOf("---")).toBeNull();
});

test("starts where a 4 GB size is sold, at the smallest of those", () => {
	// Singapore only sells the 2 GB size here, so it isn't where a box starts.
	expect(defaultsOf(options)).toEqual({ location: "nbg1", size: "cx23" });
	// Unless nowhere sells 4 GB.
	const small = { ...options, serverTypes: options.serverTypes.filter((t) => t.memory < 4) };
	expect(defaultsOf(small)).toEqual({ location: "sin", size: "cpx12" });
});

test("says what the box costs a month, its IPv4 address included", () => {
	expect(priceLine(options, "cx23", "nbg1")).toBe(
		"4.76 EUR a month: 4.15 EUR for the server and 0.61 EUR for its IPv4 address",
	);
	expect(priceLine({ ...options, ipv4Monthly: {} }, "cx23", "nbg1")).toBe(
		"4.15 EUR a month, plus Hetzner's fee for its IPv4 address",
	);
	expect(priceLine(options, "cpx12", "sin")).toBeNull();
});

test("pairs the phone by a hash of a token the box never sees", () => {
	const token = newDeviceToken(() => new Uint8Array(32).fill(171));
	expect(token).toBe("ab".repeat(32));
	const yaml = phoneCloudInit({
		name: "ateam-abc9",
		tailscaleAuthKey: "tskey-auth-abc123DEF-ghi",
		tokenHash: "c".repeat(64),
		label: "iPhone",
		agents: ["claude"],
	});
	expect(yaml).toContain("claude.ai/install.sh");
	expect(yaml).toContain(`ATEAM_PAIR_DEVICE=${"c".repeat(64)}`);
	expect(yaml).not.toContain(token);
	expect(yaml).toContain("--hostname=ateam-abc9");
});
