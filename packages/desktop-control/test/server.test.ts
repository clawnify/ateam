import { afterEach, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { createDesktopServer } from "../src/server";
import { keySequence } from "../src/x11";

const services: ReturnType<typeof createDesktopServer>[] = [];
afterEach(() => {
	for (const s of services.splice(0)) s.close();
});
async function setup() {
	const service = createDesktopServer({ token: "agent-secret", viewerToken: "viewer-secret" });
	services.push(service);
	const http = service.server();
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
	const call = async (name: string, args: unknown) => {
		const response = await fetch(`${url}/mcp`, {
			method: "POST",
			headers: { Authorization: "Bearer agent-secret", "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name, arguments: args },
			}),
		});
		return (await response.json()) as {
			result: { isError?: boolean; content: { text: string }[] };
		};
	};
	return { url, call };
}
test("HTTP MCP authenticates, exposes tools, and enforces ownership across clients", async () => {
	const { url, call } = await setup();
	expect((await fetch(`${url}/mcp`, { method: "POST" })).status).toBe(401);
	expect(
		(await fetch(`${url}/mcp`, { headers: { Authorization: "Bearer viewer-secret" } })).status,
	).toBe(401);
	const a = await call("control", { action: "acquire", label: "task A" });
	const { lease } = JSON.parse(a.result.content[0]?.text ?? "{}");
	expect((await call("control", { action: "acquire", label: "task B" })).result.isError).toBe(true);
	expect(
		(await call("computer", { action: "type", text: "must never reach X", lease: "wrong" })).result
			.isError,
	).toBe(true);
	await call("control", { action: "release", lease });
	expect((await call("control", { action: "acquire", label: "task B" })).result.isError).not.toBe(
		true,
	);
});
test("cross-origin requests and agent attempts to claim viewer control are refused", async () => {
	const { url } = await setup();
	expect(
		(
			await fetch(`${url}/mcp`, {
				method: "POST",
				headers: { Authorization: "Bearer agent-secret", Origin: "https://evil.example" },
			})
		).status,
	).toBe(403);
	expect(
		(
			await fetch(`${url}/viewer/control`, {
				method: "POST",
				headers: { Authorization: "Bearer agent-secret" },
			})
		).status,
	).toBe(401);
	expect(
		(
			await fetch(`${url}/viewer/control`, {
				method: "POST",
				headers: { Authorization: "Bearer viewer-secret", "Content-Type": "application/json" },
				body: JSON.stringify({ action: "take", clientId: "disconnected" }),
			})
		).status,
	).toBe(409);
});
test("key syntax cannot inject xdotool commands or shell input", () => {
	expect(keySequence("Control+s")).toBe("ctrl+s");
	expect(keySequence("Shift+Tab")).toBe("shift+Tab");
	for (const key of ["--window", "a exec sh", "$(touch /tmp/unsafe)", "a;rm", "a\nb"])
		expect(() => keySequence(key)).toThrow();
});
