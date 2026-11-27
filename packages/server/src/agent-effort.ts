import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { type AgentEffort, isEffort } from "@ateam/protocol";
import { shell } from "./headless";
import { JsonProcess } from "./lead/runtime";

const PROBE_TIMEOUT_MS = 4_000;
const pendingProbes = new Map<string, Promise<AgentEffort | null>>();
const CLAUDE_EFFORT_ENV = "ateam-claude-effort-env";

async function codexEffort(cwd: string): Promise<AgentEffort | null> {
	const peer = new JsonProcess(
		"codex",
		["app-server"],
		cwd,
		{},
		() => {},
		() => {},
	);
	const timeout = setTimeout(() => peer.close(), PROBE_TIMEOUT_MS);
	try {
		await peer.request("initialize", {
			clientInfo: { name: "ateam_effort", version: "1.0.0" },
			capabilities: { experimentalApi: true },
		});
		peer.notify("initialized");
		const { config } = await peer.request("config/read", { cwd, includeLayers: false });
		let cursor: string | undefined;
		do {
			const page = await peer.request("model/list", {
				cursor,
				includeHidden: true,
				modelProvider: config?.model_provider ?? undefined,
			});
			const model = page.data.find((entry: { model: string; id: string; isDefault: boolean }) =>
				config?.model ? entry.model === config.model || entry.id === config.model : entry.isDefault,
			);
			if (model && Array.isArray(model.supportedReasoningEfforts)) {
				const levels = model.supportedReasoningEfforts
					.map((entry: { reasoningEffort: unknown }) => entry.reasoningEffort)
					.filter(isEffort);
				return { model: model.model, levels };
			}
			cursor = page.nextCursor;
		} while (cursor);
		return null;
	} finally {
		clearTimeout(timeout);
		peer.close();
	}
}

type ClaudeModel = {
	value: string;
	resolvedModel?: string;
	supportsEffort?: boolean;
	supportedEffortLevels?: unknown[];
};

type ClaudeControlResponse = {
	type?: string;
	response?: {
		subtype: string;
		request_id: string;
		response?: {
			models?: ClaudeModel[];
			applied?: { model?: string };
			effective?: { env?: Record<string, string> };
		};
	};
};

async function claudeEffort(cwd: string): Promise<AgentEffort | null> {
	// Send only SDK control requests. Safe mode retains the configured model
	// while skipping project hooks, plugins, skills, and MCP servers.
	const child = spawn(
		shell,
		[
			"-lc",
			`test -n "$CLAUDE_CODE_EFFORT_LEVEL" && echo ${CLAUDE_EFFORT_ENV}; ` +
				"exec claude -p --safe-mode --no-session-persistence --input-format stream-json --output-format stream-json --verbose",
		],
		{ cwd, stdio: ["pipe", "pipe", "ignore"] },
	);
	const lines = createInterface({ input: child.stdout });
	const stop = () => {
		lines.close();
		child.kill("SIGKILL");
	};
	const timeout = setTimeout(stop, PROBE_TIMEOUT_MS);
	child.on("error", stop);
	child.stdin.on("error", stop);
	const request = (subtype: string) =>
		child.stdin.write(
			`${JSON.stringify({ type: "control_request", request_id: subtype, request: { subtype } })}\n`,
		);
	try {
		let models: ClaudeModel[] = [];
		let effortFromEnv = false;
		request("initialize");
		for await (const line of lines) {
			if (line === CLAUDE_EFFORT_ENV) {
				effortFromEnv = true;
				continue;
			}
			let message: ClaudeControlResponse | null;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			if (message?.type !== "control_response") continue;
			const response = message.response;
			if (response?.subtype !== "success") return null;
			if (response.request_id === "initialize") {
				models = response.response?.models ?? [];
				request("get_settings");
			} else if (response.request_id === "get_settings") {
				const settings = response.response;
				const model = settings?.applied?.model;
				const entry = models.find(
					(entry) => entry.resolvedModel === model || entry.value === model,
				);
				if (!entry || typeof model !== "string") return null;
				// Claude's environment wins over --effort. Its returned model levels
				// already account for organization and local effort caps.
				if (
					effortFromEnv ||
					settings?.effective?.env?.CLAUDE_CODE_EFFORT_LEVEL ||
					entry.supportsEffort === false
				)
					return { model, levels: [] };
				return Array.isArray(entry.supportedEffortLevels)
					? { model, levels: entry.supportedEffortLevels.filter(isEffort) }
					: null;
			}
		}
		return null;
	} finally {
		clearTimeout(timeout);
		stop();
	}
}

/** Null means the CLI could not tell us what this worktree supports. */
export function readAgentEffort(agentId: string, cwd: string): Promise<AgentEffort | null> {
	const probe = agentId === "codex" ? codexEffort : agentId === "claude" ? claudeEffort : null;
	if (!probe) return Promise.resolve(null);
	const key = `${agentId}:${cwd}`;
	const pending = pendingProbes.get(key);
	if (pending) return pending;
	const next = probe(cwd)
		.catch(() => null)
		.finally(() => pendingProbes.delete(key));
	pendingProbes.set(key, next);
	return next;
}
