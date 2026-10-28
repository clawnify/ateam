// The Lead chat: one coordinator conversation over every engine the desktop
// holds. Its agent runs here in main (session.ts) and reaches the board through
// an MCP server that routes like the renderer does (tools.ts, mcp-http.ts).
import { ipcMain } from "electron";
import { LEAD_CH, type LeadEvent } from "../../shared/lead";
import type { Router } from "../backend";
import { startLeadMcpServer } from "./mcp-http";
import { LeadSession } from "./session";
import { createLeadTools, LEAD_TOOL_NAMES } from "./tools";

export interface LeadDeps {
	router: Router;
	/** The box an entity lives on, or null for this Mac (host.origins). */
	machineOf(id: string): string | null;
	/** userData/lead: transcript, session id, MCP config. */
	dir: string;
	broadcast(channel: string, e: LeadEvent): void;
}

export async function startLead(deps: LeadDeps): Promise<{ dispose(): void }> {
	const tools = createLeadTools({
		handle: async (method, args) => deps.router.handle(method, args),
		machineOf: deps.machineOf,
	});
	const mcp = await startLeadMcpServer(tools);
	const session = new LeadSession({
		dir: deps.dir,
		mcp,
		allowedTools: LEAD_TOOL_NAMES,
		emit: (e) => deps.broadcast(LEAD_CH.evtEvent, e),
	});
	ipcMain.handle(LEAD_CH.snapshot, () => session.snapshot());
	ipcMain.handle(LEAD_CH.send, (_e, text: string) => session.send(String(text)));
	ipcMain.handle(LEAD_CH.interrupt, () => session.interrupt());
	ipcMain.handle(LEAD_CH.reset, () => session.reset());
	return {
		dispose() {
			session.dispose();
			mcp.close();
		},
	};
}
