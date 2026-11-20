import {
	type ProxyCheck,
	type ProxyPatch,
	type ProxyStatus,
	parseProxyUrl,
	proxyAddress,
} from "@ateam/protocol";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BoxProxy } from "../src/renderer/src/components/BoxProxy";
import type { AteamHost } from "../src/shared/host";

// A box's engine as the Proxy section sees it: what it saves, never the address back.
let saved: string | null = null;
const state: Omit<ProxyStatus, "address" | "auth"> = {
	browser: false,
	server: false,
	engineFollows: false,
	forwarder: true,
};
const sent: ProxyPatch[] = [];
let checks = 0;
let confirms = 0;
let updateFails: string | null = null;
const status = (): ProxyStatus => {
	const up = saved ? parseProxyUrl(saved) : null;
	return {
		...state,
		address: up ? proxyAddress(up) : null,
		auth: !!up && (up.username !== undefined || up.password !== undefined),
	};
};
window.ateamHost = {
	proxyStatus: async () => status(),
	updateProxy: async (alias: string, patch: ProxyPatch) => {
		if (alias !== "fixture-box") throw new Error("Wrong box");
		sent.push(structuredClone(patch));
		if (updateFails) throw new Error(updateFails);
		if (patch.url === null) {
			saved = null;
			state.browser = false;
			state.server = false;
		} else if (patch.url !== undefined) saved = patch.url;
		if (patch.browser !== undefined) state.browser = patch.browser;
		if (patch.server !== undefined) state.server = patch.server;
		return status();
	},
	checkProxy: async (): Promise<ProxyCheck> => {
		checks++;
		return { ok: true, ip: "203.0.113.7", country: "NL", ms: 80 };
	},
} as unknown as AteamHost;

let setVersion: (value: number) => void;
function Harness() {
	const [version, updateVersion] = useState(39);
	setVersion = updateVersion;
	return (
		<main style={{ padding: 20, maxWidth: 700, margin: "0 auto", display: "grid", gap: 20 }}>
			<section className="box-page">
				<div className="box-card-title">Fixture box</div>
				<BoxProxy
					alias="fixture-box"
					label="Fixture box"
					version={version}
					connected
					confirm={async () => {
						confirms++;
						return true;
					}}
				/>
			</section>
		</main>
	);
}
createRoot(document.getElementById("root")!).render(<Harness />);

const delay = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (ok: unknown, description: string) => {
	if (!ok) throw new Error(description);
};
const text = () => document.body.textContent ?? "";
const button = (label: string) =>
	[...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);
const click = async (label: string) => {
	const b = button(label);
	check(b && !b.disabled, `Button unavailable: ${label}`);
	b!.click();
	await delay();
};
const field = () => document.querySelector<HTMLInputElement>('input[type="password"]');
function type(value: string) {
	const el = field();
	check(el, "No address field");
	Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
	el!.dispatchEvent(new Event("input", { bubbles: true }));
}
const toggle = async (name: string) => {
	const box = [...document.querySelectorAll<HTMLLabelElement>(".box-proxy .check-row")].find((l) =>
		l.textContent?.startsWith(name),
	);
	check(box, `No ${name} switch`);
	box!.querySelector("input")!.click();
	await delay();
};
const fits = () => document.documentElement.scrollWidth <= window.innerWidth;

Object.assign(window, {
	runProxyTests: async () => {
		await delay();
		check(
			field() && !document.querySelector(".box-proxy .check-row"),
			"No address: form, no switches",
		);
		check(button("Save")?.disabled, "Save enabled with nothing typed");

		type("ftp://proxy.corp:21");
		await delay();
		check(text().includes("ftp:// isn't a proxy the box can use"), "Bad scheme not explained");
		check(button("Save")?.disabled, "Save enabled for a bad address");

		type("http://user-nl:s3cret@isp.example.com:10001");
		await delay();
		check(
			text().includes("http://isp.example.com:10001, with a username and password"),
			"Preview missing",
		);
		await click("Save");
		await delay(150);
		check(sent.at(-1)?.url === "http://user-nl:s3cret@isp.example.com:10001", "Address not sent");
		check(!field(), "Form still open after saving");
		check(!document.body.innerHTML.includes("s3cret"), "Password left in the page");
		check(checks === 1 && text().includes("Sites see 203.0.113.7 (NL)."), "No check after saving");
		check(fits(), "Overflows with an address set");

		await toggle("Browser");
		check(sent.at(-1)?.browser === true, "Browser switch not sent");
		check(text().includes("that traffic fails rather than leaving"), "Fail-closed note missing");

		await toggle("Server");
		check(sent.at(-1)?.server === true, "Server switch not sent");
		check(text().includes("older than 24.14"), "Old Node note missing");

		state.forwarder = false;
		updateFails = "Couldn't change the box's Chrome proxy policy: it needs passwordless sudo";
		await toggle("Browser");
		check(text().includes("passwordless sudo"), "Engine error not shown");
		const browserBox = document.querySelector<HTMLInputElement>(".box-proxy .check-row input");
		check(browserBox?.checked, "A failed switch looks changed");
		updateFails = null;
		await toggle("Server");
		check(text().includes("forwarder isn't answering"), "Dead forwarder not shown");
		state.forwarder = true;

		await click("Change");
		check(field() && button("Cancel"), "Change opens no form");
		await click("Cancel");
		check(!field(), "Cancel leaves the form open");

		await click("Remove");
		check(confirms === 1 && sent.at(-1)?.url === null, "Remove not confirmed or not sent");
		check(field() && !document.querySelector(".box-proxy .check-row"), "Removed proxy still shown");

		setVersion(38);
		await delay();
		check(!field() && text().includes("Update this box to set a proxy"), "Old box not gated");
		setVersion(39);
		await delay();
		// Left set up, as most boxes with a proxy will be, for the screenshot.
		type("http://user-nl:s3cret@isp.example.com:10001");
		await delay();
		await click("Save");
		await delay(150);
		await toggle("Browser");
		check(fits(), "Overflows");
		return { width: window.innerWidth, sent: sent.length, ok: true };
	},
});
