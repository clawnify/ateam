import { expect, test } from "bun:test";
import type { LeadItem, LeadSnapshot } from "./lead";
import { applyLeadEvent } from "./lead-view";

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
