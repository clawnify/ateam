import type { DesktopControl } from "./control";
import type { X11Desktop } from "./x11";

const instructions =
	"Desktop computer use on a shared Linux X11 display. Take a screenshot to inspect it. Call control acquire with a short task label, then pass its lease to every input call. Only one agent can control the desktop. A person can take over at any time; stop input if your lease is rejected. Release when done. Leases expire after 90 seconds without actions; renew during longer thinking. Coordinates are pixels in the full-resolution screenshot. Use TaskWindow for isolated browser tabs; this tool drives global focus and native apps. Never route this tool through the viewer.";
const tools = [
	{
		name: "control",
		description:
			"Acquire, renew, release or inspect exclusive desktop control. Agents cannot force takeover. Human viewer takeover cancels in-flight input.",
		inputSchema: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["status", "acquire", "renew", "release"] },
				label: { type: "string", minLength: 1, maxLength: 100 },
				lease: { type: "string" },
			},
			required: ["action"],
			additionalProperties: false,
		},
	},
	{
		name: "computer",
		description:
			"Screenshot or input on the Linux desktop. Inputs require an exclusive lease. Screenshots are full-resolution PNGs; clicks use their pixel coordinates. type sends real key events (max 4000 characters). key accepts Control+s, Return, Shift+Tab, etc. scroll amount is wheel steps (1–20) at the current pointer.",
		inputSchema: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"screenshot",
						"left_click",
						"right_click",
						"double_click",
						"mouse_move",
						"type",
						"key",
						"scroll",
					],
				},
				lease: { type: "string" },
				x: { type: "integer", minimum: 0 },
				y: { type: "integer", minimum: 0 },
				text: { type: "string", maxLength: 4000 },
				key: { type: "string" },
				direction: { type: "string", enum: ["up", "down", "left", "right"] },
				amount: { type: "integer", minimum: 1, maximum: 20 },
			},
			required: ["action"],
			additionalProperties: false,
		},
	},
];
const text = (value: unknown) => ({
	content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
});

/** Stateless Streamable HTTP, JSON responses only. No dependency on Ateam. */
export async function dispatchMcp(
	raw: unknown,
	control: DesktopControl,
	desktop: X11Desktop,
): Promise<unknown | null> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		return rpcError(null, -32600, "Invalid request");
	const m = raw as Record<string, unknown>;
	const id = typeof m.id === "string" || typeof m.id === "number" ? m.id : null;
	if (m.jsonrpc !== "2.0" || typeof m.method !== "string")
		return rpcError(id, -32600, "Invalid request");
	if (id === null && m.method.startsWith("notifications/")) return null;
	if (id === null) return rpcError(null, -32600, "Request id required");
	const p = m.params && typeof m.params === "object" ? (m.params as Record<string, unknown>) : {};
	let result: unknown;
	switch (m.method) {
		case "initialize":
			result = {
				protocolVersion: ["2024-11-05", "2025-03-26", "2025-06-18"].includes(
					String(p.protocolVersion),
				)
					? p.protocolVersion
					: "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "desktop-control", version: "0.1.0" },
				instructions,
			};
			break;
		case "ping":
			result = {};
			break;
		case "tools/list":
			result = { tools };
			break;
		case "tools/call": {
			if (p.name !== "control" && p.name !== "computer")
				return rpcError(id, -32602, "Unknown tool");
			try {
				const a = p.arguments as Record<string, unknown>;
				if (!a || typeof a !== "object" || Array.isArray(a))
					throw new Error("Tool arguments must be an object");
				const lease = typeof a.lease === "string" ? a.lease : "";
				if (p.name === "control") {
					switch (a.action) {
						case "status":
							result = text({ owner: control.status() });
							break;
						case "acquire":
							if (typeof a.label !== "string" || !a.label.trim() || a.label.length > 100)
								throw new Error("A task label of 1–100 characters is required");
							result = text(control.acquire(a.label.trim()));
							break;
						case "renew":
							result = text({ owner: control.renew(lease) });
							break;
						case "release":
							control.releaseAgent(lease);
							result = text("Control released");
							break;
						default:
							throw new Error("Unknown control action");
					}
				} else if (a.action === "screenshot") {
					const png = await desktop.screenshot();
					result = {
						content: [
							{ type: "image", mimeType: "image/png", data: png.toString("base64") },
							{
								type: "text",
								text: JSON.stringify({
									width: png.readUInt32BE(16),
									height: png.readUInt32BE(20),
									owner: control.status(),
								}),
							},
						],
					};
				} else {
					await control.act(lease, (signal) => desktop.action(a, signal));
					result = text("Input sent. Take a screenshot to verify the result.");
				}
			} catch (e) {
				result = { ...text(e instanceof Error ? e.message : String(e)), isError: true };
			}
			break;
		}
		default:
			return rpcError(id, -32601, "Method not found");
	}
	return { jsonrpc: "2.0", id, result };
}
function rpcError(id: string | number | null, code: number, message: string) {
	return { jsonrpc: "2.0", id, error: { code, message } };
}
