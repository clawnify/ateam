import { describe, expect, test } from "bun:test";
import { DEFAULT_EDITOR_PORT } from "@ateam/protocol";
import { editorForwardFlags, editorLocalPort } from "./editor-tunnel";

describe("editor tunnel", () => {
	test("local port is deterministic and inside the reserved range", () => {
		const p1 = editorLocalPort("hetzner-devbox");
		expect(editorLocalPort("hetzner-devbox")).toBe(p1);
		expect(p1).toBeGreaterThanOrEqual(8391);
		expect(p1).toBeLessThan(8391 + 500);
	});

	test("different aliases usually get different ports", () => {
		expect(editorLocalPort("hetzner-devbox")).not.toBe(editorLocalPort("hetzner-ateam"));
	});

	test("forward flags target the shared default editor port", () => {
		const flags = editorForwardFlags("box");
		expect(flags[0]).toBe("-L");
		expect(flags[1]).toBe(`${editorLocalPort("box")}:127.0.0.1:${DEFAULT_EDITOR_PORT}`);
	});
});
