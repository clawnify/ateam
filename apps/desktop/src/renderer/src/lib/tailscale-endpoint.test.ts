import { describe, expect, it } from "bun:test";
import { joinEndpoint, splitEndpoint } from "./tailscale-endpoint";

describe("joinEndpoint", () => {
	it("joins a host and port, with 8787 when the port is left empty", () => {
		expect(joinEndpoint("100.64.0.7", "9000")).toEqual({ endpoint: "100.64.0.7:9000" });
		expect(joinEndpoint(" mybox.tail1234.ts.net ", "")).toEqual({
			endpoint: "mybox.tail1234.ts.net:8787",
		});
	});

	it("brackets an IPv6 host", () => {
		expect(joinEndpoint("fd7a:115c:a1e0::1", "8787")).toEqual({
			endpoint: "[fd7a:115c:a1e0::1]:8787",
		});
		expect(joinEndpoint("[fd7a::1]", "")).toEqual({ endpoint: "[fd7a::1]:8787" });
	});

	it("says what to fix", () => {
		for (const [host, port] of [
			["", "8787"],
			["100.64.0.7", "http"],
			["100.64.0.7", "70000"],
			["100.64.0.7", "0"],
			["root@100.64.0.7", ""],
			["ws://100.64.0.7", ""],
		]) {
			expect("problem" in joinEndpoint(host, port)).toBe(true);
		}
	});
});

describe("splitEndpoint", () => {
	it("splits an endpoint into its fields, the inverse of joinEndpoint", () => {
		expect(splitEndpoint("100.64.0.7:8787")).toEqual({ host: "100.64.0.7", port: "8787" });
		expect(splitEndpoint("[fd7a::1]:9000")).toEqual({ host: "fd7a::1", port: "9000" });
	});

	it("leaves a host without a port as it is", () => {
		expect(splitEndpoint("100.64.0.7")).toEqual({ host: "100.64.0.7", port: "" });
		expect(splitEndpoint("fd7a::1")).toEqual({ host: "fd7a::1", port: "" });
	});
});
