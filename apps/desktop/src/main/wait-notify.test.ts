import { describe, expect, it, mock } from "bun:test";
import type { TaskDTO } from "@ateam/protocol";

// The pure half needs no Electron; stub the import so the module loads under bun.
mock.module("electron", () => ({ Notification: class {} }));
const {
	createWaitNotifier,
	FRESH_MS,
	plainText,
	proposalNotice,
	questionNotice,
	stillDue,
	waitNotice,
} = await import("./wait-notify");

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
		expect(n).toEqual({
			key: `t1:q:${NOW - 1000}`,
			title: "permission rollout",
			body: "Deploy to prod?",
		});
		expect(questionNotice(t, new Set([n?.key as string]), NOW)).toBeNull();
	});

	it("stays quiet for no question and for an old one", () => {
		expect(questionNotice(task({ question: null }), new Set(), NOW)).toBeNull();
		const old = task({ question: { ...q, askedAt: NOW - FRESH_MS - 1 } });
		expect(questionNotice(old, new Set(), NOW)).toBeNull();
	});

	// The server gives every card of one AskUserQuestion call the call's askedAt.
	it("gives one banner for a whole AskUserQuestion call, not one per card", () => {
		const card = (id: string, text: string) =>
			task({
				waitingFiredAt: null,
				question: { ...q, id, text, kind: "askUserQuestion" as const },
			});
		const first = questionNotice(card("q1", "*Color · 1 of 2*\n\nWhich color?"), new Set(), NOW);
		expect(first?.body).toBe("Color · 1 of 2\nWhich color?");
		const shown = new Set([first?.key as string]);
		expect(questionNotice(card("q2", "*Toppings · 2 of 2*\n\nWhich?"), shown, NOW)).toBeNull();
	});

	it("shows a permission prompt as plain text, command included", () => {
		const text =
			"**Run a command?**\n\n```sh\nrm -rf build/**/*.tmp\n```\nClean the build\n\n**Edit `src/__init__.py`?**";
		const n = questionNotice(
			task({ waitingFiredAt: null, question: { ...q, text } }),
			new Set(),
			NOW,
		);
		expect(n?.body).toBe(
			"Run a command?\nrm -rf build/**/*.tmp\nClean the build\nEdit src/__init__.py?",
		);
	});

	it("leaves an AskUserQuestion card's option previews out of the banner", () => {
		const text =
			"Which layout?\n\n**Grid**\n\n```\n+--+--+\n|  |  |\n```\n\n**List**\n\n```\n----\n```";
		const n = questionNotice(
			task({ waitingFiredAt: null, question: { ...q, text, kind: "askUserQuestion" } }),
			new Set(),
			NOW,
		);
		expect(n?.body).toBe("Which layout?");
	});
});

describe("proposalNotice", () => {
	const proposal = (id: string, proposedAt: number) => ({
		id,
		kind: "task" as const,
		name: "Fix the flaky login test",
		prompt: "x",
		reason: "It fails one run in five",
		proposedAt,
	});

	it("announces the newest proposal once, with its reason", () => {
		const t = task({ proposals: [proposal("a", NOW - 5000), proposal("b", NOW - 1000)] });
		expect(proposalNotice(t, new Set(), NOW)).toEqual({
			key: "t1:p:b",
			title: "permission rollout",
			body: "Proposes a task: Fix the flaky login test\nIt fails one run in five",
		});
		expect(proposalNotice(t, new Set(["t1:p:b"]), NOW)).toBeNull();
	});

	it("stays quiet for a stale proposal, and for none", () => {
		expect(
			proposalNotice(task({ proposals: [proposal("a", NOW - FRESH_MS - 1)] }), new Set(), NOW),
		).toBeNull();
		expect(proposalNotice(task({ proposals: null }), new Set(), NOW)).toBeNull();
	});
});

describe("plainText", () => {
	it("drops heading marks, emphasis and link syntax, and leaves names alone", () => {
		expect(
			plainText("# Ship it?\nSee [PR #12](https://x.test/12) and *read* `mcp__gh__merge`"),
		).toBe("Ship it?\nSee PR #12 and read mcp__gh__merge");
		expect(plainText("rm *.tmp and *.log, keep snake_case_name")).toBe(
			"rm *.tmp and *.log, keep snake_case_name",
		);
	});
});

// While a project's own window is in front, other projects' banners wait until
// the user leaves it; its own project's show as usual.
describe("banners while a project window is in front", () => {
	const asked = (id: string, projectId: string, askedAt = Date.now()) =>
		task({
			id,
			projectId,
			name: id,
			waitingFiredAt: null,
			question: { id: `${id}-q`, text: `${id} asks`, options: [], allowText: true, askedAt },
		} as Partial<TaskDTO>);

	function setup() {
		let focused: string | null = "web";
		const shown: string[] = [];
		const n = createWaitNotifier(() => {}, {
			focusedProject: () => focused,
			show: (notice) => shown.push(notice.title),
		});
		return { n, shown, focus: (p: string | null) => (focused = p) };
	}

	it("shows its own project's banners and holds the rest until the user leaves", () => {
		const { n, shown } = setup();
		const api = asked("api-task", "api");
		n.notify(asked("web-task", "web"));
		n.notify(api);
		expect(shown).toEqual(["web-task"]);
		n.release();
		expect(shown).toEqual(["web-task", "api-task"]);
		// Once each: a later update of the same question (a rename) shows nothing more.
		n.notify({ ...api, name: "renamed" } as TaskDTO);
		n.release();
		expect(shown).toEqual(["web-task", "api-task"]);
	});

	it("drops a held banner whose question was answered meanwhile", () => {
		const { n, shown } = setup();
		const t = asked("api-task", "api");
		n.notify(t);
		n.notify({ ...t, question: null } as TaskDTO);
		n.release();
		expect(shown).toEqual([]);
	});

	it("holds nothing from the main window or another app, and lets held ones go then", () => {
		const { n, shown, focus } = setup();
		n.notify(asked("api-task", "api"));
		expect(shown).toEqual([]);
		// The window closed without a blur: the next update lets them go.
		focus(null);
		n.notify(asked("docs-task", "docs"));
		expect(shown).toEqual(["api-task", "docs-task"]);
	});

	it("still shows a banner held longer than the freshness window", () => {
		const at = Date.now();
		const t = asked("api-task", "api", at);
		const key = questionNotice(t, new Set(), at)?.key ?? "";
		// Judged from when it was held, not from now.
		expect(stillDue(key, t, at)).toBe(true);
		expect(stillDue(key, { ...t, question: null } as TaskDTO, at)).toBe(false);
		expect(questionNotice(t, new Set(), at + FRESH_MS + 1)).toBeNull();
	});
});
