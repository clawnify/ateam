import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { resolve, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { DesktopControl } from "./control";
import { dispatchMcp } from "./mcp";
import { RfbInputGate } from "./rfb";
import { viewerHtml, viewerScript } from "./viewer";
import { viewerInputScript } from "./viewer-input";
import { X11Desktop } from "./x11";

function matches(got: string | undefined, expected: string): boolean {
	const a = Buffer.from(got ?? "");
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}
function json(res: ServerResponse, status: number, value?: unknown): void {
	res.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	res.end(value === undefined ? undefined : JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<unknown> {
	let data = "";
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > 64_000) throw new Error("Request too large");
		data += chunk;
	}
	return JSON.parse(data);
}

export function createDesktopServer(opts: {
	token: string;
	viewerToken: string;
	display?: string;
	vncPort?: number;
	noVncRoot?: string;
	control?: DesktopControl;
	desktop?: X11Desktop;
}) {
	const control = opts.control ?? new DesktopControl();
	const desktop = opts.desktop ?? new X11Desktop(opts.display);
	const viewers = new Map<string, { gate: RfbInputGate; socket: WebSocket }>();
	control.onRevoke = () => {
		for (const viewer of viewers.values()) viewer.gate.revoke();
	};
	const wss = new WebSocketServer({
		noServer: true,
		maxPayload: 1_100_000,
		handleProtocols: () => "binary",
	});
	const handler = async (req: IncomingMessage, res: ServerResponse) => {
		try {
			const url = new URL(req.url ?? "/", "http://localhost");
			// No CORS. A cross-origin web page must not exercise local control.
			if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)
				return json(res, 403, { error: "Origin denied" });
			if (url.pathname === "/health" && req.method === "GET")
				return json(res, 200, { name: "desktop-control", version: "0.1.0" });
			if (url.pathname === "/mcp" || url.pathname === "/viewer/control") {
				const mcp = url.pathname === "/mcp";
				if (!matches(req.headers.authorization, `Bearer ${mcp ? opts.token : opts.viewerToken}`))
					return json(res, 401, { error: "Unauthorized" });
				if (req.method !== "POST") return json(res, 405, { error: "POST required" });
				if (!req.headers["content-type"]?.startsWith("application/json"))
					return json(res, 415, { error: "application/json required" });
				const data = await body(req);
				if (mcp) {
					const reply = await dispatchMcp(data, control, desktop);
					return json(res, reply === null ? 202 : 200, reply ?? undefined);
				}
				const a = data as { action?: string; clientId?: string };
				if (!a || typeof a.clientId !== "string" || !viewers.has(a.clientId))
					return json(res, 409, { error: "Viewer is disconnected" });
				if (a.action === "take") {
					await control.takeOver(a.clientId);
					// The socket can close while a cancelled input is being cleaned up.
					if (!viewers.has(a.clientId)) control.releaseViewer(a.clientId);
				} else if (a.action === "release") control.releaseViewer(a.clientId);
				else if (a.action !== "status") return json(res, 400, { error: "Unknown action" });
				return json(res, 200, {
					owner: control.status(),
					controlling: control.canInput(a.clientId),
				});
			}
			if (req.method !== "GET") return json(res, 405);
			let content: string | Buffer;
			let mime: string;
			if (url.pathname === "/" || url.pathname === "/vnc.html") {
				content = viewerHtml;
				mime = "text/html";
			} else if (url.pathname === "/viewer.js") {
				content = viewerScript;
				mime = "text/javascript";
			} else if (url.pathname === "/viewer-input.js") {
				content = viewerInputScript;
				mime = "text/javascript";
			} else {
				const path = decodeURIComponent(url.pathname);
				if (!/^\/(core|vendor)\/[a-zA-Z0-9_./-]+\.js$/.test(path)) return json(res, 404);
				const root = resolve(opts.noVncRoot ?? "/usr/share/novnc");
				const file = resolve(root, `.${path}`);
				if (!file.startsWith(root + sep)) return json(res, 403);
				try {
					content = await readFile(file);
				} catch {
					return json(res, 404);
				}
				mime = "text/javascript";
			}
			res.writeHead(200, {
				"x-ateam-viewer-auth": "bundle-v1",
				"content-type": mime,
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
				"referrer-policy": "no-referrer",
				"content-security-policy":
					"default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'",
			});
			res.end(content);
		} catch (e) {
			if (!res.headersSent) json(res, 400, { error: e instanceof Error ? e.message : String(e) });
		}
	};
	const servers: http.Server[] = [];
	function server(): http.Server {
		const s = http.createServer((req, res) => {
			void handler(req, res);
		});
		s.requestTimeout = 20_000;
		s.on("upgrade", (req, socket, head) => {
			const reject = () => {
				socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			};
			try {
				const url = new URL(req.url ?? "/", "http://localhost");
				const id = url.searchParams.get("viewer") ?? "";
				const protocols = (req.headers["sec-websocket-protocol"] ?? "")
					.split(",")
					.map((p) => p.trim());
				if (
					url.pathname !== "/websockify" ||
					!/^[a-f0-9-]{32,36}$/.test(id) ||
					viewers.has(id) ||
					viewers.size >= 32 ||
					!protocols.includes("binary") ||
					!protocols.some((p) => matches(p, `desktop-view.${opts.viewerToken}`))
				)
					return reject();
				if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)
					return reject();
				wss.handleUpgrade(req, socket, head, (ws) => {
					const tcp = connect({ host: "127.0.0.1", port: opts.vncPort ?? 5900 });
					const gate = new RfbInputGate(
						(data) => {
							if (!tcp.destroyed) tcp.write(data);
						},
						() => control.canInput(id),
						() => control.viewerInput(id),
					);
					viewers.set(id, { gate, socket: ws });
					let alive = true;
					const heartbeat = setInterval(() => {
						if (!alive) return ws.terminate();
						alive = false;
						ws.ping();
					}, 10_000);
					heartbeat.unref();
					ws.on("pong", () => {
						alive = true;
					});
					ws.on("message", (data, binary) => {
						try {
							if (!binary || tcp.writableLength > 1_100_000)
								throw new Error("Invalid or excessive VNC input");
							gate.feed(Buffer.from(data as Buffer));
						} catch {
							ws.close(1008, "Unsupported VNC input");
						}
					});
					tcp.on("data", (data) => {
						if (ws.bufferedAmount > 8_000_000) return ws.terminate();
						if (ws.readyState === WebSocket.OPEN) ws.send(data);
					});
					tcp.on("error", () => ws.close(1011, "Desktop unavailable"));
					tcp.on("close", () => ws.close());
					ws.on("error", () => tcp.destroy());
					ws.on("close", () => {
						clearInterval(heartbeat);
						control.releaseViewer(id);
						gate.revoke();
						viewers.delete(id);
						tcp.end();
					});
				});
			} catch {
				reject();
			}
		});
		servers.push(s);
		return s;
	}
	return {
		control,
		server,
		close() {
			control.close();
			for (const v of viewers.values()) v.socket.terminate();
			wss.close();
			for (const s of servers) s.close();
		},
	};
}
