import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { WebContents } from "electron";

import { guardPageFrames } from "./page-navigation";

// Preserve getters: Electron's exception comes from accessing e.frame itself,
// not only from accessing frame.url after a frame object was obtained.
function attempt(properties: PropertyDescriptorMap): boolean {
	const contents = new EventEmitter();
	guardPageFrames(contents as WebContents);
	let blocked = false;
	const event = {
		isMainFrame: false,
		url: "https://example.com/",
		preventDefault() {
			blocked = true;
		},
	};
	Object.defineProperties(event, properties);
	contents.emit("will-frame-navigate", event);
	return blocked;
}

test("disposed frame access and missing frames cancel navigation without crashing", () => {
	const disposed = () => {
		throw new Error("Render frame was disposed before WebFrameMain could be accessed");
	};
	expect(attempt({ frame: { get: disposed } })).toBe(true);
	expect(
		attempt({
			frame: {
				value: {
					get url() {
						return disposed();
					},
				},
			},
		}),
	).toBe(true);
	expect(attempt({ frame: { value: null } })).toBe(true);
});

test("page navigation remains blocked while browser and main-frame navigation still work", () => {
	expect(attempt({ frame: { value: { url: "ateam-page://page/task/id" } } })).toBe(true);
	expect(attempt({ frame: { value: { url: "http://127.0.0.1:6080/vnc.html" } } })).toBe(false);
	expect(
		attempt({
			frame: { value: { url: "ateam-page://page/task/id" } },
			url: { value: "ateam-page://page/task/id" },
		}),
	).toBe(false);
	expect(
		attempt({
			isMainFrame: { value: true },
			frame: {
				get() {
					throw new Error("must not access main frame");
				},
			},
		}),
	).toBe(false);
});
