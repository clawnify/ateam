import { describe, expect, it, mock } from "bun:test";
import type { TaskDTO } from "@ateam/protocol";

// The pure half needs no Electron; stub the import so the module loads under bun.
mock.module("electron", () => ({ Notification: class {} }));
const { FRESH_MS, questionNotice, waitNotice } = await import("./wait-notify");

const NOW = 1_700_000_000_000;

function task(over: Partial<TaskDTO> = {}): TaskDTO {
	return {
		id: "t1",
		name: "permission rollout",
		waitingReason: "Pedro's nightly run",
		waitingUntil: NOW - 1000,
		waitingFiredAt: NOW - 1000,
		...over,
	} as TaskDTO;
}

describe("waitNotice", () => {
	it("announces a wait that just fired, naming the task and what to check", () => {
		expect(waitNotice(task(), new Set(), NOW)).toEqual({
			key: `t1:${NOW - 1000}`,
			title: "permission rollout",
			body: "Check on Pedro's nightly run",
		});
	});

	it("stays quiet for a pending wait, and for no wait at all", () => {
		expect(
			waitNotice(task({ waitingFiredAt: null, waitingUntil: NOW + 1000 }), new Set(), NOW),
		).toBeNull();
		expect(
			waitNotice(
				task({ waitingFiredAt: null, waitingUntil: null, waitingReason: null }),
				new Set(),
				NOW,
			),
		).toBeNull();
	});

	it("shows each firing once, but a re-set wait that fires again is new", () => {
		const first = waitNotice(task(), new Set(), NOW);
		const shown = new Set([first?.key ?? ""]);
		expect(waitNotice(task(), shown, NOW)).toBeNull();
		expect(waitNotice(task({ waitingFiredAt: NOW }), shown, NOW)).not.toBeNull();
	});

	// After a restart the shown set is empty, and a task whose wait fired hours
	// ago still carries the stamp on every later update: that is the card's job.
	it("does not replay an old firing", () => {
		expect(waitNotice(task({ waitingFiredAt: NOW - FRESH_MS - 1 }), new Set(), NOW)).toBeNull();
	});
});

describe("questionNotice", () => {
	const q = {
		id: "q1",
		text: "Deploy to prod?",
		options: [],
		allowText: true,
		askedAt: NOW - 1000,
	};

	it("announces a fresh question once, with the question as the body", () => {
		const t = task({ waitingFiredAt: null, question: q });
		const n = questionNotice(t, new Set(), NOW);
		expect(n).toEqual({ key: "t1:q:q1", title: "permission rollout", body: "Deploy to prod?" });
		expect(questionNotice(t, new Set([n?.key as string]), NOW)).toBeNull();
	});

	it("stays quiet for no question and for an old one", () => {
		expect(questionNotice(task({ question: null }), new Set(), NOW)).toBeNull();
		const old = task({ question: { ...q, askedAt: NOW - FRESH_MS - 1 } });
		expect(questionNotice(old, new Set(), NOW)).toBeNull();
	});
});
