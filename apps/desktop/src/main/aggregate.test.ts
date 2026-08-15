import { expect, test } from "bun:test";
import { CH } from "@ateam/protocol";
import { candidateId, createAggregate } from "./aggregate";
import type { Backend } from "./backend";

// A fake engine: canned per-method results + a log of which methods it was asked.
function fake(
	kind: "local" | "remote",
	data: Record<string, (args: unknown[]) => unknown>,
): Backend & { calls: string[] } {
	const calls: string[] = [];
	return {
		kind,
		methods: [],
		calls,
		handle(method, args) {
			calls.push(method);
			return data[method]?.(args);
		},
		on: () => () => {},
		dispose: () => {},
	};
}

function fixtures() {
	const local = fake("local", {
		[CH.projectsList]: () => [{ id: "pA" }],
		[CH.agentsList]: () => [{ id: "claude" }],
		[CH.tasksList]: () => [{ id: "tA" }],
		[CH.ptySpawnShell]: () => ({ terminalId: "termA" }),
		[CH.ptyWrite]: () => undefined,
		[CH.tasksCreate]: () => ({ id: "tA-new" }),
		[CH.projectsRegister]: () => ({ id: "pA-new" }),
	});
	const remote = fake("remote", {
		[CH.projectsList]: () => [{ id: "pB" }],
		[CH.agentsList]: () => [{ id: "claude" }, { id: "codex" }],
		[CH.tasksList]: () => [{ id: "tB" }],
		[CH.ptySpawnShell]: () => ({ terminalId: "termB" }),
		[CH.ptyWrite]: () => undefined,
		[CH.tasksCreate]: () => ({ id: "tB-new" }),
		[CH.projectsRemoteUrl]: () => "git@github.com:acme/on-the-box.git",
	});
	return { local, remote, agg: createAggregate([local, remote], local) };
}

test("candidateId pulls the id from a string arg or an id-ish field", () => {
	expect(candidateId(["term-1"])).toBe("term-1");
	expect(candidateId([{ taskId: "t-1" }])).toBe("t-1");
	expect(candidateId([{ projectId: "p-1" }])).toBe("p-1");
	expect(candidateId([{ nope: 1 }])).toBeUndefined();
});

test("collection reads merge across backends (agents dedupe by id)", async () => {
	const { agg } = fixtures();
	expect(await agg.handle(CH.projectsList, [])).toEqual([{ id: "pA" }, { id: "pB" }]);
	// claude appears on both engines → deduped; codex only on remote.
	expect(await agg.handle(CH.agentsList, [])).toEqual([{ id: "claude" }, { id: "codex" }]);
});

test("entity calls route to the owning backend, learned from prior reads", async () => {
	const { local, remote, agg } = fixtures();
	await agg.handle(CH.projectsList, []); // learns pA→local, pB→remote

	await agg.handle(CH.tasksList, ["pB"]);
	expect(remote.calls).toContain(CH.tasksList);
	expect(local.calls).not.toContain(CH.tasksList);

	await agg.handle(CH.tasksList, ["pA"]);
	expect(local.calls).toContain(CH.tasksList);
});

test("a spawned terminal is learned, so later pty calls route to its engine", async () => {
	const { local, remote, agg } = fixtures();
	await agg.handle(CH.projectsList, []);
	await agg.handle(CH.tasksList, ["pB"]); // learns tB→remote
	await agg.handle(CH.ptySpawnShell, [{ taskId: "tB" }]); // routes to remote, learns termB→remote
	await agg.handle(CH.ptyWrite, ["termB", "ls\n"]);
	expect(remote.calls.filter((m) => m === CH.ptyWrite)).toHaveLength(1);
	expect(local.calls).not.toContain(CH.ptyWrite);
});

test("tasksCreate routes by projectId and the new task is owned by that engine", async () => {
	const { remote, agg } = fixtures();
	await agg.handle(CH.projectsList, []); // learns pB→remote
	const created = (await agg.handle(CH.tasksCreate, [{ projectId: "pB", name: "x" }])) as {
		id: string;
	};
	expect(created.id).toBe("tB-new");
	expect(agg.ownerOf.get("tB-new")).toBe(remote);
});

// Regression: projectsRemoteUrl takes a projectId but was missing from ENTITY, so
// every remote project's remote-URL lookup asked the LOCAL engine, which doesn't
// have that project — "Project not found: <id>". Invisible while boxes were only
// connected by hand mid-session; on every launch once we reconnect known boxes.
test("projectsRemoteUrl routes to the engine that owns the project", async () => {
	const { local, remote, agg } = fixtures();
	await agg.handle(CH.projectsList, []); // learns pB→remote
	expect(await agg.handle(CH.projectsRemoteUrl, ["pB"])).toBe("git@github.com:acme/on-the-box.git");
	expect(remote.calls).toContain(CH.projectsRemoteUrl);
	expect(local.calls).not.toContain(CH.projectsRemoteUrl);
});

test("un-routable calls fall back to the local engine", async () => {
	const { local, agg } = fixtures();
	await agg.handle(CH.projectsRegister, ["/repo", {}]);
	expect(local.calls).toContain(CH.projectsRegister);
});

test("an entity call with an unknown id falls back rather than throwing", async () => {
	const { local, agg } = fixtures();
	await agg.handle(CH.gitStatus, ["unknown-task"]);
	expect(local.calls).toContain(CH.gitStatus);
});
