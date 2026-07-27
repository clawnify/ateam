// Demo mode: a fully-offline Connection backed by canned data — no box, no WS, no
// Tailscale. It exists for two reasons: (1) App Review — Ateam is local-first with
// no shared backend a reviewer could sign into, so per App Store guideline 2.1 we
// offer a built-in demo instead of demo credentials; (2) onboarding — let someone
// see the app before they stand up a box.
//
// The trick: we don't fork the UI. We fake the *transport* (the RPC wire), run it
// through the real createRpcClient + buildAteamApi, and hand back a normal
// Connection. Every screen — board, composer, terminal, image attach — then renders
// against canned responses exactly as it would against a live daemon.
import {
	type AgentDTO,
	buildAteamApi,
	CH,
	type ClientTransport,
	createRpcClient,
	type DirListingDTO,
	PROTOCOL_VERSION,
	type ProjectDTO,
	type PtySnapshot,
	type ServerFrame,
	type SessionDTO,
	type SystemInfo,
	type TaskDTO,
} from "@ateam/protocol";
import { type Connection, mobileNative } from "./connection";

const INFO: SystemInfo = { protocolVersion: PROTOCOL_VERSION, agents: ["claude", "codex"] };

const AGENTS: AgentDTO[] = [
	{ id: "claude", label: "Claude Code", description: "Anthropic's coding agent", available: true },
	{ id: "codex", label: "Codex", description: "OpenAI's coding agent", available: true },
];

const PROJECT: ProjectDTO = {
	id: "demo-project",
	repoPath: "/home/demo/ateam",
	name: "ateam",
	defaultBranch: "main",
	githubOwner: "clawnify",
	githubName: "ateam",
	color: "#7c5cff",
};

const T0 = Date.now();
function task(
	id: string,
	name: string,
	column: TaskDTO["column"],
	agentStatus: TaskDTO["agentStatus"],
	extra: Partial<TaskDTO> = {},
): TaskDTO {
	return {
		id,
		projectId: PROJECT.id,
		name,
		description: null,
		slug: id,
		branch: `ateam/${id}`,
		baseBranch: "main",
		worktreePath: `/home/demo/ateam/.ateam/worktrees/${id}`,
		column,
		agentStatus,
		agentId: "claude",
		mergeStatus: null,
		prNumber: null,
		prUrl: null,
		gitStatus: null,
		lastEventAt: T0,
		isUnread: false,
		...extra,
	};
}

const TASKS: TaskDTO[] = [
	task("onboarding-copy", "Rewrite the onboarding copy", "needs_attention", "awaiting_input", {
		lastEventAt: T0 - 30_000,
	}),
	task("dark-mode", "Add a dark-mode toggle to settings", "running", "running", {
		lastEventAt: T0 - 5_000,
	}),
	task("stripe-webhooks", "Wire up the Stripe webhooks", "running", "running", {
		agentId: "codex",
		lastEventAt: T0 - 12_000,
	}),
	task("flaky-test", "Fix the flaky checkout test", "review", "idle", {
		prNumber: 128,
		prUrl: "https://github.com/clawnify/ateam/pull/128",
		gitStatus: { ahead: 3, behind: 0, dirty: 0, updatedAt: T0 },
	}),
	task("empty-states", "Design the empty states", "todo", null),
	task("bump-deps", "Bump dependencies to latest", "merged", "stopped", {
		prNumber: 121,
		mergeStatus: null,
	}),
];

// A believable Claude Code session, as an ANSI transcript. Static (not streamed) so
// it's deterministic — good for App Store screenshots and a stable review.
const TRANSCRIPT =
	"\x1b[38;5;213m✻ Claude Code\x1b[0m \x1b[2m· ateam/dark-mode · claude-opus\x1b[0m\r\n\r\n" +
	"\x1b[1m>\x1b[0m add a dark-mode toggle to Settings, wired to the theme store\r\n\r\n" +
	"\x1b[2m● Reading\x1b[0m src/screens/Settings.tsx\r\n" +
	"\x1b[2m● Reading\x1b[0m src/theme/store.ts\r\n\r\n" +
	"\x1b[32m● Edited\x1b[0m src/screens/Settings.tsx \x1b[2m(+22 −1)\x1b[0m\r\n" +
	"  \x1b[2m added a <Toggle> bound to theme.mode, persisted via the store\x1b[0m\r\n" +
	"\x1b[32m● Edited\x1b[0m src/theme/store.ts \x1b[2m(+9 −0)\x1b[0m\r\n\r\n" +
	"\x1b[2m● Running\x1b[0m \x1b[36mnpm test -- theme\x1b[0m\r\n" +
	"  \x1b[32m✓\x1b[0m theme toggle persists across reloads\r\n" +
	"  \x1b[32m✓\x1b[0m respects the system preference on first launch\r\n\r\n" +
	"\x1b[32m●\x1b[0m Done. The toggle lives in Settings → Appearance and updates the\r\n" +
	"  theme immediately. Want me to open a PR?\r\n\r\n" +
	"\x1b[1m>\x1b[0m \x1b[7m \x1b[0m\r\n";

function sessionFor(taskId: string): SessionDTO {
	const t = TASKS.find((x) => x.id === taskId);
	return {
		id: `sess-${taskId}`,
		taskId,
		agentId: t?.agentId ?? "claude",
		terminalId: `demo-term-${taskId}`,
		status: "running",
		cwd: "/home/demo/ateam",
	};
}

const LISTING: DirListingDTO = {
	path: "/home/demo",
	parent: "/home",
	entries: [
		{ name: "ateam", path: "/home/demo/ateam", isRepo: true },
		{ name: "website", path: "/home/demo/website", isRepo: true },
		{ name: "scratch", path: "/home/demo/scratch", isRepo: false },
	],
};

/** Map an RPC method to its canned result. Unmapped methods resolve to undefined —
 *  the mobile UI only calls the handful covered here. */
function handle(method: string, args: unknown[]): unknown {
	switch (method) {
		case CH.systemHello:
			return INFO;
		case CH.agentsList:
			return AGENTS;
		case CH.projectsList:
			return [PROJECT];
		case CH.tasksList:
			return TASKS;
		case CH.tasksCreate: {
			const input = args[0] as { projectId: string; name: string };
			return task(`new-${T0}`, input.name || "New task", "running", "running");
		}
		case CH.ptyListForTask:
			return [sessionFor(String(args[0]))];
		case CH.ptySpawnShell:
			return { terminalId: `demo-term-${(args[0] as { taskId: string }).taskId}` };
		case CH.ptySpawnAgent:
			return { terminalId: "demo-term-new" };
		case CH.ptySnapshot:
			return { data: TRANSCRIPT, seq: 0 } satisfies PtySnapshot;
		case CH.utilWriteImageBytes:
			return "/tmp/ateam-attachments/demo.png";
		case CH.fsListDir:
			return LISTING;
		default:
			// pty:write, pty:resize, pty:kill and anything else → a bare ack.
			return undefined;
	}
}

/** A Connection whose api is served entirely from the canned data above. */
export function demoConnection(): Connection {
	let onFrame: ((f: ServerFrame) => void) | null = null;
	const transport: ClientTransport = {
		send: (frame) => {
			const result = handle(frame.method, frame.args);
			// Resolve on a later tick so it behaves like a real async round-trip.
			setTimeout(() => onFrame?.({ t: "res", id: frame.id, ok: true, result }), 0);
		},
		onFrame: (h) => {
			onFrame = h;
		},
		onClose: () => {},
	};
	const rpc = createRpcClient(transport);
	return {
		api: buildAteamApi(rpc, mobileNative),
		info: INFO,
		ping: async () => true,
		close: () => {
			onFrame = null;
		},
	};
}
