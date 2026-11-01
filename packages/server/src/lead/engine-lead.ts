// A box's own Lead, for the phone (protocol v24). The phone holds one box and
// never reaches the Mac, whose Lead lives in the desktop, so the box's engine
// runs one too: the same core (index.ts) over this engine's dispatcher alone,
// served beside the dispatcher on the engine's RPC (LEAD_RPC, LEAD_EVENT).
//
// It costs nothing until used: the core starts on the first call (its MCP
// listener, its transcript), and its agent on the first message. A box whose
// Lead was used before starts the core with the engine, so the tasks the user
// followed from the chat keep reporting back while no phone is connected.
//
// The desktop's own engine never serves this: the desktop's Lead already covers
// every engine, and cli.ts is the only place that adds it.
import { existsSync } from "node:fs";
import { LEAD_CH, LEAD_EVENT, LEAD_RPC, type LeadEvent } from "@ateam/protocol";
import type { Dispatcher } from "../dispatcher";
import type { Engine } from "../engine";
import type { RpcExtension } from "../rpc";
import { type Lead, type LeadDeps, startLead } from "./index";

/** The largest file the phone can attach (decoded), the desktop's cap for a box. */
export const MAX_LEAD_ATTACH_BYTES = 10 * 1024 * 1024;

const ANSWERS = new Set(["allow", "always", "deny"]);

export interface EngineLeadOptions {
	engine: Pick<Engine, "on">;
	dispatcher: Pick<Dispatcher, "handle">;
	/** <data dir>/lead */
	dir: string;
	log?: (line: string) => void;
	/** Tests: how to start `claude`. */
	spawnClaude?: LeadDeps["spawnClaude"];
}

export function engineLead(opts: EngineLeadOptions): RpcExtension & { dispose(): void } {
	const listeners = new Set<(e: LeadEvent) => void>();
	let started: Promise<Lead> | null = null;
	let stopTasks: (() => void) | null = null;

	const lead = (): Promise<Lead> => {
		started ??= startLead({
			place: "box",
			dir: opts.dir,
			handle: (method, args) => opts.dispatcher.handle(method, args),
			// Everything this Lead reaches is on this box.
			machineOf: () => null,
			// The agents read the attachments where they are.
			deliver: async (_owner, paths) => ({ paths }),
			emit: (e) => {
				for (const l of listeners) l(e);
			},
			...(opts.spawnClaude ? { spawnClaude: opts.spawnClaude } : {}),
		}).then(
			(l) => {
				stopTasks = opts.engine.on("taskUpdated", (task) => l.onTaskUpdated(task));
				return l;
			},
			(e) => {
				// Let the next call try again rather than fail forever.
				started = null;
				throw e;
			},
		);
		return started;
	};

	// Used before on this box: follow its tasks from the start.
	if (existsSync(opts.dir))
		void lead().catch((e) => opts.log?.(`[ateam] Lead didn't start: ${(e as Error).message}`));

	const str = (v: unknown, what: string): string => {
		if (typeof v !== "string") throw new Error(`${what} must be text.`);
		return v;
	};

	return {
		methods: LEAD_RPC,
		subscribe(send) {
			const l = (e: LeadEvent) => send(LEAD_EVENT, e);
			listeners.add(l);
			return () => listeners.delete(l);
		},
		async handle(method, args) {
			const l = await lead();
			switch (method) {
				case LEAD_CH.snapshot:
					return l.snapshot();
				case LEAD_CH.send: {
					const paths = Array.isArray(args[1]) ? args[1].map(String) : [];
					return l.send(str(args[0] ?? "", "The message"), paths);
				}
				case LEAD_CH.interrupt:
					return l.interrupt();
				case LEAD_CH.reset:
					return l.reset();
				case LEAD_CH.reply:
					return l.reply(str(args[0], "The task"), str(args[1], "The reply"));
				case LEAD_CH.answer: {
					const input = (args[0] ?? {}) as Record<string, unknown>;
					const a = input.answer;
					const answer = a == null ? null : Array.isArray(a) ? a.map(String) : str(a, "The answer");
					return l.answer({
						taskId: str(input.taskId, "The task"),
						questionId: str(input.questionId, "The question"),
						answer,
					});
				}
				case LEAD_CH.permission: {
					const answer = str(args[1], "The answer");
					if (!ANSWERS.has(answer)) throw new Error(`Unknown answer: ${answer}`);
					return l.permission(str(args[0], "The request"), answer as "allow" | "always" | "deny");
				}
				case LEAD_CH.setAuto:
					return l.setAuto(args[0] === true);
				case LEAD_CH.attachBytes: {
					const name = str(args[0], "The file name");
					const base64 = str(args[1], "The file");
					// base64 is 4 characters for every 3 bytes: refuse before decoding.
					if (Math.floor((base64.length * 3) / 4) > MAX_LEAD_ATTACH_BYTES + 2)
						throw new Error(`${name} is over 10 MB, too big to attach.`);
					return l.attachBytes(name, new Uint8Array(Buffer.from(base64, "base64")));
				}
				case LEAD_CH.proposal: {
					const outcome = args[1] === "created" ? "created" : "dismissed";
					const taskId = typeof args[2] === "string" ? args[2] : undefined;
					return l.proposal(str(args[0], "The proposal"), outcome, taskId);
				}
				default:
					throw new Error(`Unknown method: ${method}`);
			}
		},
		dispose() {
			stopTasks?.();
			void started?.then((l) => l.dispose()).catch(() => {});
		},
	};
}
