import { describe, expect, test } from "bun:test";
import { DEFAULT_BROWSER_VIEW_PORT, DEFAULT_EDITOR_PORT } from "@ateam/protocol";
import { boxForwardFlags, browserLocalPort, editorLocalPort } from "./box-tunnel";

describe("box tunnels", () => {
	test("local ports are deterministic and inside their reserved ranges", () => {
		const p1 = editorLocalPort("hetzner-devbox");
		expect(editorLocalPort("hetzner-devbox")).toBe(p1);
		expect(p1).toBeGreaterThanOrEqual(8391);
		expect(p1).toBeLessThan(8391 + 500);
		const b1 = browserLocalPort("hetzner-devbox");
		expect(b1).toBeGreaterThanOrEqual(6081);
		expect(b1).toBeLessThan(6081 + 500);
	});

	test("different aliases usually get different ports", () => {
		expect(editorLocalPort("hetzner-devbox")).not.toBe(editorLocalPort("hetzner-ateam"));
	});

	test("forward flags target the box's loopback editor and browser ports", () => {
		expect(boxForwardFlags("box")).toEqual([
			"-L",
			`${editorLocalPort("box")}:127.0.0.1:${DEFAULT_EDITOR_PORT}`,
			"-L",
			`${browserLocalPort("box")}:127.0.0.1:${DEFAULT_BROWSER_VIEW_PORT}`,
		]);
	});
});
