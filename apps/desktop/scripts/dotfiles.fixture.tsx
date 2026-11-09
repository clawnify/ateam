import type { AteamApi, DotfilesConfig, DotfilesPlan, DotfilesStatus } from "@ateam/protocol";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BoxDotfiles, DotfilesDefault } from "../src/renderer/src/components/Dotfiles";
import type { AteamHost } from "../src/shared/host";

const config: DotfilesConfig = { repository: "https://github.com/fixture/dotfiles", script: "" };
const state: DotfilesStatus = { defaultConfig: config, prepared: null, run: null };
let prepares = 0;
let applies = 0;
let saves = 0;
let script: string | null = "install.sh";
let failure = false;
let applyFailure = false;
window.ateam = {
	settings: {
		get: async () => ({ settings: { engine: { dotfiles: config } } }),
		update: async () => {
			saves++;
		},
	},
} as unknown as AteamApi;
window.ateamHost = {
	dotfilesStatus: async () => structuredClone(state),
	prepareDotfiles: async (alias: string, value: DotfilesConfig) => {
		if (alias !== "fixture-box") throw new Error("Wrong box");
		prepares++;
		if (failure) throw new Error("Connect GitHub on this box, then retry Preview.");
		const plan: DotfilesPlan = {
			id: String(prepares),
			config: value,
			commit: "abc123456789abcdef",
			directory: "/home/fixture/.ateam/dotfiles/123456789012345678901234",
			script,
		};
		state.prepared = plan;
		return structuredClone(plan);
	},
	applyDotfiles: async (alias: string, id: string) => {
		if (alias !== "fixture-box" || id !== state.prepared?.id) throw new Error("Wrong preview");
		if (applyFailure) {
			state.prepared = null;
			throw new Error("The checkout changed since preview. Preview again before applying.");
		}
		applies++;
		state.run = {
			plan: state.prepared,
			state: "running",
			startedAt: 1,
			finishedAt: null,
			exitCode: null,
			message: null,
			log: "Installing shell configuration…\n",
		};
		state.prepared = null;
		return structuredClone(state);
	},
} as unknown as AteamHost;
let setVersion: (value: number) => void;
function Harness() {
	const [version, updateVersion] = useState(35);
	setVersion = updateVersion;
	return (
		<main style={{ padding: 20, maxWidth: 700, margin: "0 auto", display: "grid", gap: 20 }}>
			<DotfilesDefault />
			<section className="box-card">
				<div className="box-card-title">Fixture box</div>
				<BoxDotfiles alias="fixture-box" label="Fixture box" version={version} connected />
			</section>
		</main>
	);
}
createRoot(document.getElementById("root")!).render(<Harness />);
const delay = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (ok: unknown, description: string) => {
	if (!ok) throw new Error(description);
};
const button = (text: string) =>
	[...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);
const click = async (text: string) => {
	const b = button(text);
	check(b && !b.disabled, `Button unavailable: ${text}`);
	b!.click();
	await delay();
};
function input(value: string) {
	const el = document.querySelectorAll<HTMLInputElement>("input")[2];
	Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
	el.dispatchEvent(new Event("input", { bubbles: true }));
}

Object.assign(window, {
	runDotfilesTests: async () => {
		await delay();
		check(
			document.querySelector("input")!.getBoundingClientRect().height >= 32,
			"Real Tailwind input styles missing",
		);
		await click("Save default");
		check(saves === 1 && prepares === 0 && applies === 0, "Saving ran dotfiles");
		setVersion(34);
		await delay();
		check(
			!button("Preview") && document.body.textContent?.includes("Update this box"),
			"Old box not gated",
		);
		setVersion(35);
		await delay();
		await click("Preview");
		check(applies === 0 && button("Apply to Fixture box"), "Preview must not apply");
		input("https://github.com/fixture/changed");
		await delay();
		check(!button("Apply to Fixture box"), "Edited form retained approval");
		script = null;
		await click("Preview");
		check(
			!button("Apply to Fixture box") &&
				document.body.textContent?.includes("No install script found"),
			"Missing script must not apply",
		);
		failure = true;
		await click("Preview");
		check(document.body.textContent?.includes("Connect GitHub"), "Clone error missing");
		failure = false;
		script = "install.sh";
		await click("Preview");
		applyFailure = true;
		await click("Apply to Fixture box");
		check(!button("Apply to Fixture box"), "Failed apply retained approval");
		applyFailure = false;
		await click("Preview");
		await click("Apply to Fixture box");
		check(applies === 1 && button("Preview")?.disabled, "Run not exclusive");
		state.run = {
			...state.run!,
			state: "succeeded",
			finishedAt: 2,
			exitCode: 0,
			log: "Shell configuration installed.\n",
		};
		await delay(1700);
		check(document.body.textContent?.includes("Last apply: succeeded"), "Result polling failed");
		check(!button("Apply to Fixture box"), "Consumed approval was reused");
		check(document.documentElement.scrollWidth <= innerWidth, "Horizontal overflow");
		return { width: innerWidth, prepares, applies, saves, result: "passed" };
	},
});
