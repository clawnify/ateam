import { describe, expect, it } from "bun:test";
import { parseProxyUrl, proxyAddress } from "./proxy";

describe("parseProxyUrl", () => {
	it("reads a proxy with credentials, decoding them", () => {
		expect(parseProxyUrl(" http://user-nl:p%40ss%3Aword@isp.example.com:10001 ")).toEqual({
			scheme: "http",
			host: "isp.example.com",
			port: 10001,
			username: "user-nl",
			password: "p@ss:word",
		});
	});

	it("takes host:port alone as an http proxy, with each scheme's default port", () => {
		expect(parseProxyUrl("proxy.corp:3128")).toEqual({
			scheme: "http",
			host: "proxy.corp",
			port: 3128,
		});
		expect(parseProxyUrl("https://proxy.corp").port).toBe(443);
		expect(parseProxyUrl("socks5://proxy.corp").port).toBe(1080);
	});

	it("reads socks5h as socks5, since the box always lets the proxy resolve names", () => {
		expect(parseProxyUrl("socks5h://u:p@gate.example.com:7000")).toMatchObject({
			scheme: "socks5",
			host: "gate.example.com",
			port: 7000,
		});
	});

	it("keeps an IPv6 host without its brackets, and shows it with them", () => {
		const up = parseProxyUrl("http://[2001:db8::1]:8080");
		expect(up.host).toBe("2001:db8::1");
		expect(proxyAddress(up)).toBe("http://[2001:db8::1]:8080");
	});

	it("refuses what isn't a proxy address, saying what is", () => {
		expect(() => parseProxyUrl("")).toThrow("http://user:password@host:port");
		expect(() => parseProxyUrl("http://a b:1")).toThrow("http://user:password@host:port");
		expect(() => parseProxyUrl("ftp://proxy.corp:21")).toThrow(
			"ftp:// isn't a proxy the box can use",
		);
		expect(() => parseProxyUrl("socks4://proxy.corp:1080")).toThrow("socks4://");
	});

	it("shows where the proxy is, never who signs in to it", () => {
		const shown = proxyAddress(parseProxyUrl("http://alice:secret@isp.example.com:10001"));
		expect(shown).toBe("http://isp.example.com:10001");
	});
});
