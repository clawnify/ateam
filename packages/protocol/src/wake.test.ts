// The phone's provider registry: what it offers, and what it asks for.
import { describe, expect, test } from "bun:test";
import { PROVIDERS, providerById } from "./providers";
import {
	filled,
	inputsAt,
	reportedWake,
	WAKE_PROVIDERS,
	wakeAdapter,
	wakeMachineName,
} from "./wake";

describe("wake providers", () => {
	test("every provider defined with wake has an adapter", () => {
		// A definition alone can't wake anything, so shipping one without its adapter
		// would offer a provider the phone then silently never wakes.
		const defined = PROVIDERS.filter((p) => p.wake).map((p) => p.id);
		expect(WAKE_PROVIDERS.map((p) => p.id)).toEqual(defined);
	});

	test("boxd asks for a machine per box and a key per account", () => {
		const boxd = providerById("boxd");
		if (!boxd) throw new Error("boxd is defined");
		expect(inputsAt(boxd, "box").map((i) => i.key)).toEqual(["machine"]);
		expect(inputsAt(boxd, "account").map((i) => [i.key, i.secret])).toEqual([["apiKey", true]]);
	});

	test("Sprites asks for the Sprite per box and a token per account", () => {
		const sprites = providerById("sprites");
		if (!sprites) throw new Error("sprites is defined");
		expect(inputsAt(sprites, "box").map((i) => i.key)).toEqual(["machine"]);
		expect(inputsAt(sprites, "account").map((i) => [i.key, i.secret])).toEqual([["token", true]]);
		expect(wakeAdapter(sprites, { token: "my-org/1/2/t" })).not.toBeNull();
	});

	test("an input counts as filled only with something other than spaces", () => {
		const boxd = providerById("boxd");
		if (!boxd) throw new Error("boxd is defined");
		expect(filled(boxd, "box", { machine: "mybox" })).toBe(true);
		expect(filled(boxd, "box", { machine: "  " })).toBe(false);
		expect(filled(boxd, "account", {})).toBe(false);
	});

	test("no adapter for a provider the phone can't wake", () => {
		expect(wakeAdapter({ id: "hetzner", label: "Hetzner" }, { apiKey: "k" })).toBeNull();
		const boxd = providerById("boxd");
		if (!boxd) throw new Error("boxd is defined");
		expect(wakeAdapter(boxd, { apiKey: "bxd_k" })).not.toBeNull();
	});
});

describe("wakeMachineName", () => {
	test("a box a provider wakes goes by its machine name there", () => {
		expect(wakeMachineName({ id: "boxd", box: { machine: "ateam-probe" } })).toBe("ateam-probe");
		expect(wakeMachineName({ id: "sprites", box: { machine: " ateam-box " } })).toBe("ateam-box");
	});
	test("no provider, an unknown one, or a blank name leaves the address to do", () => {
		expect(wakeMachineName(null)).toBeNull();
		expect(wakeMachineName(undefined)).toBeNull();
		expect(wakeMachineName({ id: "nope", box: { machine: "x" } })).toBeNull();
		expect(wakeMachineName({ id: "boxd", box: { machine: "  " } })).toBeNull();
	});
});

describe("reportedWake", () => {
	test("a box that names itself at a provider the client can wake through is woken there", () => {
		expect(reportedWake({ id: "sprites", box: { machine: " ateam-box " } })).toEqual({
			id: "sprites",
			box: { machine: "ateam-box" },
		});
		expect(reportedWake({ id: "boxd", box: { machine: "probe" } })).toEqual({
			id: "boxd",
			box: { machine: "probe" },
		});
	});
	test("nothing said, an unknown provider, or no name there wakes nothing", () => {
		expect(reportedWake(undefined)).toBeNull();
		expect(reportedWake(null)).toBeNull();
		expect(reportedWake({ id: "fly-machines", box: { machine: "x" } })).toBeNull();
		expect(reportedWake({ id: "sprites", box: { machine: "  " } })).toBeNull();
		expect(reportedWake({ id: "sprites", box: {} })).toBeNull();
		expect(reportedWake({ id: "sprites", box: null as never })).toBeNull();
	});
	test("only the provider's box inputs are kept, never an account value", () => {
		expect(reportedWake({ id: "sprites", box: { machine: "b", token: "secret" } })).toEqual({
			id: "sprites",
			box: { machine: "b" },
		});
	});
});
