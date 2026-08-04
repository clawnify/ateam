import { expect, test } from "bun:test";
import type { ProjectDTO } from "@ateam/protocol";
import { aliasLabel, unifyProjects } from "./unify";

function project(id: string, over: Partial<ProjectDTO> = {}): ProjectDTO {
	return {
		id,
		repoPath: `/repo/${id}`,
		name: id,
		defaultBranch: "main",
		githubOwner: null,
		githubName: null,
		color: "#fff",
		...over,
	};
}

test("same GitHub repo across engines merges into one card with both members", () => {
	const local = project("pLocal", { name: "ateam", githubOwner: "clawnify", githubName: "ateam" });
	const remote = project("pRemote", {
		name: "ateam",
		githubOwner: "clawnify",
		githubName: "ateam",
	});
	const cards = unifyProjects([local, remote], { pLocal: null, pRemote: "hetzner" });

	expect(cards).toHaveLength(1);
	expect(cards[0].key).toBe("gh:clawnify/ateam");
	expect(cards[0].members.map((m) => m.alias)).toEqual([null, "hetzner"]); // local first
	expect(cards[0].members.map((m) => m.projectId)).toEqual(["pLocal", "pRemote"]);
});

test("non-GitHub repos never merge — each stays its own card", () => {
	const a = project("pA", { name: "scratch" });
	const b = project("pB", { name: "scratch" }); // same name, no gh identity
	const cards = unifyProjects([a, b], { pA: null, pB: "hetzner" });

	expect(cards).toHaveLength(2);
	expect(cards.every((c) => c.members.length === 1)).toBe(true);
});

test("a projectId missing from origins defaults to local", () => {
	const cards = unifyProjects([project("pA")], {});
	expect(cards[0].members[0].alias).toBeNull();
});

test("partial availability: a repo on only one engine is a one-member card", () => {
	const local = project("pLocal", { githubOwner: "o", githubName: "r" });
	const cards = unifyProjects([local], { pLocal: null });
	expect(cards).toHaveLength(1);
	expect(cards[0].members).toHaveLength(1);
	expect(cards[0].members[0].alias).toBeNull();
});

test("aliasLabel renders local as Local and a box as its alias", () => {
	expect(aliasLabel(null)).toBe("Local");
	expect(aliasLabel("hetzner")).toBe("hetzner");
});
