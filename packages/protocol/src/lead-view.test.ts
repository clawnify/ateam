import { expect, test } from "bun:test";
import type { TaskDTO } from "./index";
import type { LeadItem, LeadSnapshot } from "./lead";
import { applyLeadEvent, findLinkedTask } from "./lead-view";

const user = (id: string, at: number): LeadItem => ({ kind: "user", id, text: id, at });

test("a client holding the tail ignores updates to items it never loaded", () => {
	const s: LeadSnapshot = {
		items: [user("b", 20), user("c", 30)],
		draft: "",
		busy: false,
		auto: false,
		more: true,
	};
	// An old proposal's outcome: older than all it holds, so not at the bottom.
	expect(applyLeadEvent(s, { type: "item", item: user("a", 10) })).toBe(s);
	// Something new still lands.
	expect(applyLeadEvent(s, { type: "item", item: user("d", 40) }).items.map((i) => i.id)).toEqual([
		"b",
		"c",
		"d",
	]);
	// A client with the whole conversation appends whatever arrives, as before.
	const whole = { ...s, more: undefined };
	expect(applyLeadEvent(whole, { type: "item", item: user("a", 10) }).items).toHaveLength(3);
});

const task = (id: string, name: string): TaskDTO =>
	({ id, name, branch: name.toLowerCase().replace(/\W+/g, "-") }) as TaskDTO;

test("a link the Lead garbled or wrote before the task had an id still finds its task", () => {
	const fix = task("86e6964a-0a73-4815-b24a-ae5ce387a14b", "Fix the login redirect");
	const add = task("0625bea9-9f8f-4804-8609-38aa186a1a34", "Add a project button");
	const tasks = [fix, add];
	// The id as get_board gave it, and as the Lead sometimes garbles it.
	expect(findLinkedTask(tasks, fix.id, "login")).toBe(fix);
	expect(findLinkedTask(tasks, "86e6964a-a63c-4cb2-9576-38964bc45fdb", "login")).toBe(fix);
	// No id yet (a proposal): the link's text, when it is the task's name.
	expect(findLinkedTask(tasks, "proposed", "add a project button")).toBe(add);
	expect(findLinkedTask(tasks, "proposed", "the button task")).toBeUndefined();
	// Two tasks sharing the first eight characters or the name: neither.
	const twin = task("86e6964a-ffff-4815-b24a-ae5ce387a14b", "Add a project button");
	expect(
		findLinkedTask([...tasks, twin], "86e6964a-a63c-4cb2-9576-38964bc45fdb", "x"),
	).toBeUndefined();
	expect(findLinkedTask([...tasks, twin], "proposed", "Add a project button")).toBeUndefined();
});
