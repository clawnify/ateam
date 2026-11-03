import { expect, test } from "bun:test";
import {
	type BoxSnapshot,
	CH,
	type LoopDTO,
	OFFLINE_ERROR,
	type ProjectDTO,
	type RpcClient,
	type TaskDTO,
	unifyProjects,
} from "@ateam/protocol";
import { createFleet, pickProject } from "./fleet";

// A fake box: canned per-method results, a log of what it was asked, and a way to push.
function box(data: Record<string, (args: unknown[]) => unknown>) {
	const calls: string[] = [];
	const handlers = new Map<string, Set<(p: unknown) => void>>();
	const rpc: RpcClient = {
		call: async (method, args = []) => {
			calls.push(method);
			return data[method]?.(args);
		},
		on(event, handler) {
			let set = handlers.get(event);
			if (!set) {
				set = new Set();
				handlers.set(event, set);
			}
			set.add(handler);
			return () => set.delete(handler);
		},
	};
	const push = (event: string, payload: unknown) => {
		for (const h of handlers.get(event) ?? []) h(payload);
	};
	return { rpc, calls, push, listening: (event: string) => handlers.get(event)?.size ?? 0 };
}

const project = (id: string): ProjectDTO => ({
	id,
	repoPath: `/repo/${id}`,
	name: id,
	defaultBranch: "main",
	githubOwner: null,
	githubName: null,
	color: null,
});
const task = (id: string, projectId: string) => ({ id, projectId }) as TaskDTO;

function twoBoxes() {
	const a = box({
		[CH.projectsList]: () => [project("pA")],
		[CH.tasksList]: () => [task("tA", "pA")],
		[CH.loopsList]: () => [{ id: "loopA", projectId: "pA" }],
		[CH.ptyListForTask]: () => [{ terminalId: "termA" }],
		[CH.ptySpawnAgent]: () => ({ terminalId: "termA2" }),
	});
	const b = box({
		[CH.projectsList]: () => [project("pB")],
		[CH.tasksList]: () => [task("tB", "pB")],
		[CH.loopsList]: () => [],
		[CH.ptyListForTask]: () => [{ terminalId: "termB" }],
		[CH.tasksCreate]: () => task("tB-new", "pB"),
	});
	const fleet = createFleet();
	fleet.attach("a:8787", a.rpc);
	fleet.attach("b:8787", b.rpc);
	return { a, b, fleet };
}

test("projects from every box list together, and each call goes to the box that owns it", async () => {
	const { a, b, fleet } = twoBoxes();
	expect(await fleet.rpc.call(CH.projectsList, [])).toEqual([project("pA"), project("pB")]);
	expect(await fleet.rpc.call(CH.tasksList, ["pB"])).toEqual([task("tB", "pB")]);
	expect(b.calls).toContain(CH.tasksList);
	expect(a.calls).not.toContain(CH.tasksList);
	expect(fleet.ownerOf("tB")).toBe("b:8787");

	// A task made on B routes there from its first call.
	await fleet.rpc.call(CH.tasksCreate, [{ projectId: "pB", name: "x" }]);
	expect(fleet.ownerOf("tB-new")).toBe("b:8787");
});

test("a call about a whole box is refused: it has to go through that box's own connection", async () => {
	const { fleet } = twoBoxes();
	await expect(fleet.rpc.call(CH.githubAccessStatus, [])).rejects.toThrow("needs a box");
});

const snapshotOfB: BoxSnapshot = {
	at: 1,
	projects: [project("pB")],
	tasks: { pB: [task("tB", "pB")] },
	loops: [],
};

test("a box that drops keeps its projects and tasks listed from its last-seen board", async () => {
	const { b, fleet } = twoBoxes();
	await fleet.rpc.call(CH.projectsList, []);
	fleet.detach("b:8787", { snapshot: snapshotOfB, label: "box-b" });

	expect(fleet.isLive("b:8787")).toBe(false);
	expect(await fleet.rpc.call(CH.projectsList, [])).toEqual([project("pA"), project("pB")]);
	expect(await fleet.rpc.call(CH.tasksList, ["pB"])).toEqual([task("tB", "pB")]);
	// Mission Control asks every task for its sessions: an asleep box has none.
	expect(await fleet.rpc.call(CH.ptyListForTask, ["tB"])).toEqual([]);
	await expect(fleet.rpc.call(CH.ptySpawnAgent, [{ taskId: "tB" }])).rejects.toThrow(OFFLINE_ERROR);

	// Back up: the same ids reach the live engine again.
	fleet.attach("b:8787", b.rpc);
	expect(fleet.isLive("b:8787")).toBe(true);
	await fleet.rpc.call(CH.ptyListForTask, ["tB"]);
	expect(b.calls.filter((c) => c === CH.ptyListForTask)).toHaveLength(1);
});

test("a box that drops with no last-seen board leaves the board until it's back", async () => {
	const { fleet } = twoBoxes();
	fleet.detach("b:8787", null);
	expect(fleet.keys()).toEqual(["a:8787"]);
	expect(await fleet.rpc.call(CH.projectsList, [])).toEqual([project("pA")]);
});

test("pushes reach the board from every live box, including one that connects later", () => {
	const { a, b, fleet } = twoBoxes();
	const seen: unknown[] = [];
	fleet.rpc.on("taskUpdated", (t) => seen.push(t));
	const c = box({});
	fleet.attach("c:8787", c.rpc);

	a.push("taskUpdated", task("tA", "pA"));
	b.push("taskUpdated", task("tB", "pB"));
	c.push("taskUpdated", task("tC", "pC"));
	expect(seen).toEqual([task("tA", "pA"), task("tB", "pB"), task("tC", "pC")]);

	// A dropped box's socket stops being listened to.
	fleet.detach("b:8787", null);
	expect(b.listening("taskUpdated")).toBe(0);
});

test("a task first heard of through a push routes to the box that pushed it", async () => {
	const { b, fleet } = twoBoxes();
	fleet.rpc.on("taskUpdated", () => {});
	b.push("taskUpdated", task("started-by-a-loop", "pB"));
	await fleet.rpc.call(CH.ptyListForTask, ["started-by-a-loop"]);
	expect(b.calls).toContain(CH.ptyListForTask);
});

test("removing a box takes its ids off the board and leaves the others routing", async () => {
	const { a, fleet } = twoBoxes();
	await fleet.rpc.call(CH.projectsList, []);
	await fleet.rpc.call(CH.tasksList, ["pA"]);
	await fleet.rpc.call(CH.tasksList, ["pB"]);
	fleet.remove("b:8787");

	expect(await fleet.rpc.call(CH.projectsList, [])).toEqual([project("pA")]);
	await expect(fleet.rpc.call(CH.ptyListForTask, ["tB"])).rejects.toThrow("needs a box");
	await fleet.rpc.call(CH.ptyListForTask, ["tA"]);
	expect(a.calls).toContain(CH.ptyListForTask);
});

test("a box's share of the board is what gets kept as its last-seen board", async () => {
	const { fleet } = twoBoxes();
	const projects = (await fleet.rpc.call(CH.projectsList, [])) as ProjectDTO[];
	const loops = (await fleet.rpc.call(CH.loopsList, [])) as LoopDTO[];
	const tasks = [task("tA", "pA"), task("tB", "pB")];
	const snap = fleet.snapshotOf("a:8787", { projects, tasks, loops });
	expect(snap.projects).toEqual([project("pA")]);
	expect(snap.tasks).toEqual({ pA: [task("tA", "pA")] });
	expect(snap.loops).toEqual([{ id: "loopA", projectId: "pA" }] as unknown as LoopDTO[]);
});

test("one repo on two boxes is one project, and the pick survives the move to card keys", () => {
	const onA = { ...project("pA"), githubOwner: "acme", githubName: "site" };
	const onB = { ...project("pB"), githubOwner: "acme", githubName: "site" };
	const cards = unifyProjects([onA, onB, project("pOnlyB")], {
		pA: "a:8787",
		pB: "b:8787",
		pOnlyB: "b:8787",
	});
	expect(cards.map((c) => c.key)).toEqual(["gh:acme/site", "engine:b:8787:pOnlyB"]);
	expect(cards[0]?.members.map((m) => m.alias)).toEqual(["a:8787", "b:8787"]);

	expect(pickProject(cards, "engine:b:8787:pOnlyB", "gh:acme/site")).toBe("engine:b:8787:pOnlyB");
	expect(pickProject(cards, "gone", "gh:acme/site")).toBe("gh:acme/site");
	// Kept by an older build: a project id, from one box.
	expect(pickProject(cards, null, "pB")).toBe("gh:acme/site");
	expect(pickProject(cards, null, null)).toBe("gh:acme/site");
	expect(pickProject([], "x", "y")).toBeNull();
});
