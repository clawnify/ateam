// When an agent's turn ends, let Jev re-file the card if the rule got it wrong.
//
// The rule files first, as it always has (engine.ts mapEventToColumn: Stop →
// Review). This runs after, only when an OpenRouter key is set, and can make
// exactly one move: Review → Needs you, when the agent's final message is sure
// to be waiting on the user (see jev.ts). Three guards keep it from doing harm:
//
//  • NEWER EVIDENCE WINS. A per-task token drops a verdict once another turn
//    has ended, and the card must still be where the rule put it with its agent
//    idle: a reply, a new turn or a hand move since the Stop all mean the
//    verdict is about a moment that has passed.
//  • LOOPS ARE LEFT ALONE. A loop's card in Needs you reads to its next tick
//    as "previous run still active" and wedges it (see notify.sh's comment);
//    a loop reports trouble its own way.
//  • EVERY MOVE IS AUDITED in board_changes, source "classifier", with the
//    reason, the same trail the organizer leaves.
import { type AteamDb, repo } from "@ateam/db";
import { openRouterApiKey } from "./credentials-file";
import { classifyTurn, type TurnVerdict } from "./jev";

export interface TurnClassifierDeps {
	db: AteamDb;
	notifyTaskUpdated: (taskId: string) => void;
	/** Injected for tests; defaults to the real key lookup and Jev call. */
	apiKey?: () => string | undefined;
	classify?: typeof classifyTurn;
	log?: (line: string) => void;
}

export interface TurnClassifier {
	/** A user reply: remembered as the question the next turn answers. */
	userReplied(taskId: string, prompt: string): void;
	/** A turn ended. Resolves once any move has been applied (tests await it). */
	turnEnded(taskId: string, finalMessage: string | undefined): Promise<TurnVerdict | null>;
}

export function createTurnClassifier(deps: TurnClassifierDeps): TurnClassifier {
	const apiKey = deps.apiKey ?? (() => openRouterApiKey());
	const classify = deps.classify ?? classifyTurn;
	const log = deps.log ?? ((line: string) => console.log(line));
	const lastPrompt = new Map<string, string>();
	const tokens = new Map<string, number>();

	return {
		userReplied(taskId, prompt) {
			lastPrompt.set(taskId, prompt);
		},

		async turnEnded(taskId, finalMessage) {
			const token = (tokens.get(taskId) ?? 0) + 1;
			tokens.set(taskId, token);
			const key = apiKey();
			if (!key || !finalMessage?.trim()) return null;
			const task = repo.getTask(deps.db, taskId);
			if (!task || task.column !== "review") return null;
			if (repo.loopForTask(deps.db, taskId) !== undefined) return null;

			const verdict = await classify({
				apiKey: key,
				finalMessage,
				// The latest reply this engine saw, else the task's own opening
				// prompt: what the first turn was asked to do.
				userMessage: lastPrompt.get(taskId) ?? task.description ?? task.name,
			});
			if (!verdict || verdict.step !== "needs_attention") return verdict;
			if (tokens.get(taskId) !== token) return null; // a newer turn ended meanwhile

			const now = repo.getTask(deps.db, taskId);
			if (!now || now.column !== "review" || now.agentStatus !== "idle") return null;
			repo.updateTask(deps.db, now.id, { column: "needs_attention" });
			repo.recordBoardChange(deps.db, {
				taskId: now.id,
				fromColumn: "review",
				toColumn: "needs_attention",
				reason: verdict.reason,
				source: "classifier",
			});
			// A move nobody clicked must be visible somewhere besides the audit table.
			log(
				`[ateam] classifier: "${now.name}" review → needs_attention (${verdict.reason}, ${verdict.confidence.toFixed(2)})`,
			);
			deps.notifyTaskUpdated(now.id);
			return verdict;
		},
	};
}
