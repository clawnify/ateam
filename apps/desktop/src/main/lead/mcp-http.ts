// The Lead's MCP endpoint: Streamable HTTP on loopback, tools only, the same
// request/response shape the engine's board server speaks (hook-server.ts). It
// lives in desktop main rather than on an engine because only main holds every
// engine at once. A random token per app run is the only key: the Lead's agent
// gets it in its --mcp-config, and nothing else on the machine has it.
import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { dispatchMcpTools, type JsonRpcMessage, type McpToolServer } from "@ateam/server";

export interface LeadMcpServer {
	url: string;
	token: string;
	close(): void;
}

const MAX_BODY = 1_000_000;

function tokenMatches(header: string | undefined, token: string): boolean {
	const want = Buffer.from(`Bearer ${token}`);
	const got = Buffer.from(header ?? "");
	return got.length === want.length && timingSafeEqual(got, want);
}

export function startLeadMcpServer(tools: McpToolServer): Promise<LeadMcpServer> {
	const token = randomBytes(24).toString("hex");
	const server = http.createServer((req, res) => {
		const json = (status: number, body: unknown) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		};
		if (req.url !== "/mcp") {
			res.writeHead(404);
			res.end();
			return;
		}
		// No SSE stream to offer: every answer rides on its POST.
		if (req.method !== "POST") {
			res.writeHead(405);
			res.end();
			return;
		}
		// A browser page can reach loopback too; it can't send this header.
		if (!tokenMatches(req.headers.authorization, token)) {
			res.writeHead(401);
			res.end();
			return;
		}
		let body = "";
		req.on("data", (c) => {
			body += c;
			if (body.length > MAX_BODY) req.destroy();
		});
		req.on("end", () => {
			let msg: JsonRpcMessage;
			try {
				msg = JSON.parse(body) as JsonRpcMessage;
			} catch {
				return json(400, {
					jsonrpc: "2.0",
					id: null,
					error: { code: -32700, message: "parse error" },
				});
			}
			dispatchMcpTools(msg, tools)
				.then((reply) => {
					if (reply.kind === "accepted") {
						res.writeHead(202);
						res.end();
					} else json(200, reply.body);
				})
				.catch((e) =>
					json(500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: String(e) } }),
				);
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({ url: `http://127.0.0.1:${port}/mcp`, token, close: () => server.close() });
		});
	});
}
