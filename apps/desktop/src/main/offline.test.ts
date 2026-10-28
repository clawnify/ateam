import { expect, test } from "bun:test";
import { CH } from "@ateam/protocol";
import { createAggregate } from "./aggregate";
import type { Backend } from "./backend";
import {
	asSnapshot,
	type BoxSnapshot,
	OFFLINE_ERROR,
	offlineBackend,
	reconnectDelay,
	takeSnapshot,
} from "./offline";

function engine(
	kind: "local" | "remote",
	data: Record<string, (args: unknown[]) => unknown>,
): Backend {
	return {
		kind,
		methods: [],
		handle: (method, args) => data[method]?.(args),
		on: () => () => {},
		dispose: () => {},
	};
}

const snap: BoxSnapshot = {
	at: 1,
	projects: [{ id: "pBox" }],
	tasks: { pBox: [{ id: "tBox", projectId: "pBox" }] },
	loops: [{ id: "loopBox" }],
};

test("takeSnapshot reads projects, each project's tasks, and loops", async () => {
	const box = engine("remote", {
		[CH.projectsList]: () => [{ id: "p1" }, { id: "p2" }],
		[CH.tasksList]: ([pid]) => [{ id: `t-${pid}` }],
		[CH.loopsList]: () => [{ id: "l1" }],
	});
	const s = await takeSnapshot(box);
	expect(s.projects).toEqual([{ id: "p1" }, { id: "p2" }]);
	expect(s.tasks).toEqual({ p1: [{ id: "t-p1" }], p2: [{ id: "t-p2" }] });
	expect(s.loops).toEqual([{ id: "l1" }]);
	expect(asSnapshot(s)).toBe(s);
});

test("asSnapshot rejects what isn't one", () => {
	expect(asSnapshot(null)).toBeNull();
	expect(asSnapshot({})).toBeNull();
	expect(asSnapshot({ at: 1, projects: [], loops: [] })).toBeNull();
	expect(asSnapshot(snap)).toBe(snap);
});

test("an offline box's cards merge into the board and route back to it", async () => {
	const local = engine("local", {
		[CH.projectsList]: () => [{ id: "pA" }],
		[CH.tasksList]: () => [{ id: "tA" }],
		[CH.loopsList]: () => [],
		[CH.ptyListForTask]: () => [{ terminalId: "x" }],
	});
	const off = offlineBackend(snap, "mybox");
	const agg = createAggregate([local, off], local);

	expect(await agg.handle(CH.projectsList, [])).toEqual([{ id: "pA" }, { id: "pBox" }]);
	expect(await agg.handle(CH.loopsList, [])).toEqual([{ id: "loopBox" }]);
	expect(await agg.handle(CH.tasksList, ["pBox"])).toEqual(snap.tasks.pBox);
	expect(agg.ownerOf.get("tBox")).toBe(off);
	// Mission Control asks every visible task for sessions in one Promise.all.
	expect(await agg.handle(CH.ptyListForTask, ["tBox"])).toEqual([]);
	// Anything that would reach the engine is refused, recognisably.
	await expect(agg.handle(CH.ptySpawnAgent, [{ taskId: "tBox" }])).rejects.toThrow(OFFLINE_ERROR);
});

test("rehome hands an offline box's ids to the live engine that replaces it", async () => {
	const local = engine("local", { [CH.projectsList]: () => [] });
	const off = offlineBackend(snap, "mybox");
	const list: Backend[] = [local, off];
	const agg = createAggregate(list, local);
	await agg.handle(CH.projectsList, []);
	await agg.handle(CH.tasksList, ["pBox"]);

	const live = engine("remote", { [CH.ptySpawnAgent]: () => ({ terminalId: "t1" }) });
	list.splice(list.indexOf(off), 1, live);
	agg.rehome(off, live);
	expect(agg.ownerOf.get("tBox")).toBe(live);
	expect(agg.ownerOf.get("pBox")).toBe(live);
	expect(await agg.handle(CH.ptySpawnAgent, [{ taskId: "tBox" }])).toEqual({ terminalId: "t1" });
});

test("reconnect backs off, then holds at its cap", () => {
	expect(reconnectDelay(0)).toBe(5_000);
	expect(reconnectDelay(1)).toBe(15_000);
	expect(reconnectDelay(4)).toBe(120_000);
	expect(reconnectDelay(50)).toBe(120_000);
});
