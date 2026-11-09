#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createDesktopServer } from "./server";

// Independently runnable: Ateam only supplies this directory and the display.
const dir = process.env.DESKTOP_CONTROL_DIR ?? join(homedir(), ".desktop-control");
mkdirSync(dir, { recursive: true, mode: 0o700 });
function secret(name: string): string {
	const path = join(dir, name);
	try {
		writeFileSync(path, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
	}
	chmodSync(path, 0o600);
	const value = readFileSync(path, "utf8").trim();
	if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid credential file: ${path}`);
	return value;
}
const service = createDesktopServer({
	token: secret("desktop-token"),
	viewerToken: secret("desktop-viewer-token"),
	display: process.env.DISPLAY ?? ":99",
	noVncRoot: process.env.DESKTOP_NOVNC_ROOT,
});
const listen = [
	process.env.DESKTOP_LISTEN ?? "127.0.0.1:6080",
	process.env.DESKTOP_LISTEN_EXTRA,
].filter(Boolean) as string[];
for (const addr of listen) {
	const [host, portString] = addr.split(":");
	const port = Number(portString);
	if (!host || !Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error(`Invalid desktop listen address: ${addr}`);
	const server = service.server();
	server.on("error", (e) => {
		console.error(e.message);
		service.close();
		process.exitCode = 1;
	});
	server.listen(port, host, () =>
		console.error(`Desktop control: http://${addr} (MCP /mcp, viewer /vnc.html)`),
	);
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.on(signal, () => {
		service.close();
	});
