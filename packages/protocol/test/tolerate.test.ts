import { describe, expect, test } from "bun:test";
import { NO_TRIAGE, PROTOCOL_VERSION, type RpcClient, tolerantRpc } from "../src/index";

/** A TaskDTO as a PRE-v5 engine sends it: no `triage` at all. */
const oldCard = { id: "t1", projectId: "p1", worktreePath: "/w/t1", column: "doing" };

function stubRpc(result: unknown): RpcClient & { emit: (e: string, p: unknown) => void } {
	const handlers = new Map<string, (p: unknown) => void>();
	return {
		call: async () => result,
		on: (event, handler) => {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		emit: (event, payload) => handlers.get(event)?.(payload),
	};
}

describe("tolerantRpc", () => {
	test("fills the triage an older engine never sent", async () => {
		const rpc = tolerantRpc(stubRpc([oldCard]), PROTOCOL_VERSION - 1);
		const [card] = (await rpc.call("tasks:list")) as { triage: unknown }[];
		expect(card.triage).toEqual(NO_TRIAGE);
	});

	test("fills a single card too, not just lists", async () => {
		const rpc = tolerantRpc(stubRpc(oldCard), PROTOCOL_VERSION - 1);
		expect((await rpc.call("tasks:create")) as { triage: unknown }).toHaveProperty(
			"triage",
			NO_TRIAGE,
		);
	});

	test("fills cards arriving on events, not only on calls", () => {
		const stub = stubRpc(null);
		let seen: { triage?: unknown } | undefined;
		tolerantRpc(stub, PROTOCOL_VERSION - 1).on("taskUpdated", (p) => {
			seen = p as { triage?: unknown };
		});
		stub.emit("taskUpdated", oldCard);
		expect(seen?.triage).toEqual(NO_TRIAGE);
	});

	test("leaves a real verdict alone", async () => {
		const real = { ...oldCard, triage: { bucket: "stalled", done: false, reason: "idle 3d" } };
		const rpc = tolerantRpc(stubRpc([real]), PROTOCOL_VERSION - 1);
		const [card] = (await rpc.call("tasks:list")) as { triage: { bucket: string } }[];
		expect(card.triage.bucket).toBe("stalled");
	});

	test("is a pass-through when the engine is level or ahead", async () => {
		const stub = stubRpc([oldCard]);
		expect(tolerantRpc(stub, PROTOCOL_VERSION)).toBe(stub);
		expect(tolerantRpc(stub, PROTOCOL_VERSION + 1)).toBe(stub);
	});

	// The bug this keys off: the pre-v6 CleanupCandidate was a flat row that also
	// carried `worktreePath`, so duck-typing on that alone stamped a fabricated
	// verdict onto rows that are not tasks.
	test("does not mistake a pre-v6 cleanup row for a task", async () => {
		const v5Row = {
			id: "t1",
			name: "fix",
			branch: "b",
			worktreePath: "/w/t1",
			reason: "merged",
			terminalId: null,
			agentStatus: null,
		};
		const rpc = tolerantRpc(stubRpc([v5Row]), PROTOCOL_VERSION - 1);
		const [row] = (await rpc.call("tasks:cleanupCandidates")) as Record<string, unknown>[];
		expect(row).not.toHaveProperty("triage");
	});

	test("passes non-task payloads through untouched", async () => {
		const rpc = tolerantRpc(stubRpc({ id: "p1", name: "repo" }), PROTOCOL_VERSION - 1);
		expect(await rpc.call("projects:list")).toEqual({ id: "p1", name: "repo" });
	});
});
