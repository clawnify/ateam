import { describe, expect, test } from "bun:test";
import { browserViewUrl } from "./browser-view";

// noVNC's own reader (app/webutil.js getHashVar, v1.0 through v1.3).
const hashVar = (url: string, name: string): string | null => {
	const v = url.slice(url.indexOf("#")).match(new RegExp(`.*[&#]${name}=([^&]*)`))?.[1];
	return v == null ? null : decodeURIComponent(v);
};

describe("browserViewUrl", () => {
	test("opens vnc.html with every setting in the fragment, none in the query", () => {
		const url = browserViewUrl("http://127.0.0.1:6445", "Ab3dE6gH");
		expect(url.startsWith("http://127.0.0.1:6445/vnc.html#")).toBe(true);
		expect(url).not.toContain("?");
		expect(hashVar(url, "autoconnect")).toBe("true");
		expect(hashVar(url, "resize")).toBe("scale");
		expect(hashVar(url, "reconnect")).toBe("true");
		expect(hashVar(url, "password")).toBe("Ab3dE6gH");
	});

	test("a password with reserved characters survives noVNC's reader", () => {
		expect(hashVar(browserViewUrl("http://h:6080", "a&b=c#d"), "password")).toBe("a&b=c#d");
	});
});

test("desktop takeover credential stays in the fragment alongside the VNC password", () => {
	const url = browserViewUrl("http://box:6080", "password", "viewer-token");
	expect(hashVar(url, "controlToken")).toBe("viewer-token");
	expect(url.split("#")[0]).toBe("http://box:6080/vnc.html");
	expect(browserViewUrl("http://box:6080", "password")).not.toContain("controlToken");
});
