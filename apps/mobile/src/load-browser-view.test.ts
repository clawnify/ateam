import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AteamApi } from "@ateam/protocol";
import { loadBrowserView } from "./load-browser-view";

// The browser view on the phone used to ask twice and then stay hidden. Just after
// a Sprite woke, both asks missed, and the view only came back when the terminal
// reopened.

const VIEW = "http://box:6080/vnc.html#autoconnect=true";

/** A box whose view misses `misses` times, then answers. */
function box(misses: number) {
	let asked = 0;
	const view = mock(async () => {
		if (++asked <= misses) throw new Error("The box's browser view isn't answering on port 6080.");
		return { url: VIEW };
	});
	return { api: { browser: { view } } as unknown as AteamApi, view };
}

/** Poll until `cond` holds, failing after `ms` rather than hanging the run. */
async function waitFor(cond: () => boolean, ms = 2_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error(`condition not met within ${ms} ms`);
		await new Promise((r) => setTimeout(r, 5));
	}
}

describe("a task's browser view", () => {
	let warn: ReturnType<typeof spyOn>;
	beforeEach(() => {
		warn = spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => warn.mockRestore());

	test("keeps asking past several misses, and warns once for them", async () => {
		const { api, view } = box(4);
		const urls: string[] = [];
		loadBrowserView(api, "task", (u) => urls.push(u), [1]);
		await waitFor(() => urls.length > 0);
		expect(urls).toEqual([VIEW]);
		expect(view).toHaveBeenCalledTimes(5);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	test("stops asking once the terminal closes", async () => {
		const { api, view } = box(Number.POSITIVE_INFINITY);
		const stop = loadBrowserView(api, "task", () => {}, [1]);
		await waitFor(() => view.mock.calls.length >= 3);
		stop();
		const asked = view.mock.calls.length;
		await new Promise((r) => setTimeout(r, 30));
		expect(view.mock.calls.length).toBe(asked);
	});

	test("drops a view that answers after the terminal closed", async () => {
		let answer: (v: { url: string }) => void = () => {};
		const view = mock(() => new Promise<{ url: string }>((r) => (answer = r)));
		const urls: string[] = [];
		const stop = loadBrowserView({ browser: { view } } as unknown as AteamApi, "task", (u) =>
			urls.push(u),
		);
		stop();
		answer({ url: VIEW });
		await new Promise((r) => setTimeout(r, 0));
		expect(urls).toEqual([]);
	});
});
