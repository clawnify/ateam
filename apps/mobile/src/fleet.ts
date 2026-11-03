// Every saved box at once, as one board: the phone's counterpart to the desktop's
// main/host.ts. The phone used to hold one box and switch between them; now each
// box it has saved is on the board together, the way the desktop shows its boxes.
//
// A box is on the board in one of two ways:
//   live     its engine answers over the box's own WebSocket (src/connection.ts)
//   offline  it is asleep or out of reach, and its last-seen board stands in for
//            it (@ateam/protocol board-snapshot.ts), so its projects and tasks stay
//            listed. Anything that would reach the engine is refused until it's live.
//
// One merged RpcClient serves the board: collection reads (projects, agents, loops)
// union every box, and a call about a project, task, terminal or loop goes to the
// box that owns that id. The routing table is the desktop's own (@ateam/protocol
// aggregate.ts), so the two can't drift. A call that addresses a whole box rather
// than something on it (its GitHub access, its shell, adding a project, an
// attachment's bytes) carries no id to route by: it is refused here, and goes
// through that box's own Connection instead.
//
// Pure TS, no React Native imports, so it runs under bun test.
import {
	type BoxSnapshot,
	createAggregate,
	type LoopDTO,
	offlineHandle,
	type ProjectDTO,
	type RpcClient,
	type TaskDTO,
	type UnifiedProject,
} from "@ateam/protocol";

/** One box on the board, as the aggregate routes to it. */
interface Member {
	readonly kind: "remote";
	/** The box's address (src/boxes.ts boxKey). Empty for the refusing fallback. */
	readonly key: string;
	readonly live: boolean;
	handle(method: string, args: unknown[]): unknown;
}

// Pushes that name a task or a loop no read has returned yet (an agent, a loop or
// the Lead started it): learned, so opening it reaches the box that sent it.
const LEARN_FROM = new Set(["taskUpdated", "loopsUpdated"]);

export interface Fleet {
	/** The merged board's RPC. Build the board's AteamApi over this. */
	readonly rpc: RpcClient;
	/** A box's engine answers: it serves its own ids from now on, in place of its
	 *  last-seen board if that was standing in. */
	attach(key: string, rpc: RpcClient): void;
	/** A box went out of reach: its last-seen board stands in for it, labelled for
	 *  the refusals. Without one, it leaves the board until it comes back. */
	detach(key: string, last: { snapshot: BoxSnapshot; label: string } | null): void;
	/** Off the board entirely (removed from the list, or the demo ending). */
	remove(key: string): void;
	/** The box that owns a project, task, terminal or loop id, once a read or a push
	 *  has named it; null before that. */
	ownerOf(id: string): string | null;
	isLive(key: string): boolean;
	/** The boxes on the board, live or standing in. */
	keys(): string[];
	/** `key`'s share of the merged board, for keeping it as its last-seen board. */
	snapshotOf(key: string, board: Board): BoxSnapshot;
}

/** The merged board as the app holds it. */
export interface Board {
	projects: ProjectDTO[];
	tasks: TaskDTO[];
	loops: LoopDTO[];
}

export function createFleet(opts: { mergeTimeoutMs?: number } = {}): Fleet {
	// The aggregate reads this array on every merge, so attaching edits it in place.
	const members: Member[] = [];
	const byKey = new Map<string, Member>();
	const refuse: Member = {
		kind: "remote",
		key: "",
		live: false,
		handle: (method) =>
			Promise.reject(new Error(`${method} needs a box: it isn't about anything on one.`)),
	};
	const agg = createAggregate<Member>(members, refuse, opts);

	// Pushes, fanned in from every live box to whoever listens on the board.
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	const rpcs = new Map<string, RpcClient>();
	const subs = new Map<string, Map<string, () => void>>();

	function subscribe(key: string, rpc: RpcClient, event: string): void {
		let mine = subs.get(key);
		if (!mine) {
			mine = new Map();
			subs.set(key, mine);
		}
		if (mine.has(event)) return;
		mine.set(
			event,
			rpc.on(event, (payload) => {
				const owner = byKey.get(key);
				if (owner && LEARN_FROM.has(event)) agg.learn(owner, payload);
				for (const l of [...(listeners.get(event) ?? [])]) l(payload);
			}),
		);
	}

	function unsubscribeAll(key: string): void {
		for (const off of subs.get(key)?.values() ?? []) off();
		subs.delete(key);
	}

	function place(key: string, next: Member): void {
		const prev = byKey.get(key);
		byKey.set(key, next);
		const at = prev ? members.indexOf(prev) : -1;
		if (prev && at >= 0) {
			members.splice(at, 1, next);
			agg.rehome(prev, next);
		} else {
			members.push(next);
		}
	}

	function remove(key: string): void {
		unsubscribeAll(key);
		rpcs.delete(key);
		const prev = byKey.get(key);
		if (!prev) return;
		byKey.delete(key);
		const at = members.indexOf(prev);
		if (at >= 0) members.splice(at, 1);
		// Its ids now meet the refusal, while every other box keeps what it taught.
		agg.rehome(prev, refuse);
	}

	const rpc: RpcClient = {
		call: (method, args = []) => agg.handle(method, args),
		on(event, handler) {
			let set = listeners.get(event);
			if (!set) {
				set = new Set();
				listeners.set(event, set);
				for (const [key, boxRpc] of rpcs) subscribe(key, boxRpc, event);
			}
			set.add(handler);
			return () => {
				set.delete(handler);
			};
		},
	};

	return {
		rpc,
		attach(key, boxRpc) {
			unsubscribeAll(key);
			rpcs.set(key, boxRpc);
			place(key, {
				kind: "remote",
				key,
				live: true,
				handle: (method, args) => boxRpc.call(method, args),
			});
			for (const event of listeners.keys()) subscribe(key, boxRpc, event);
		},
		detach(key, last) {
			unsubscribeAll(key);
			rpcs.delete(key);
			if (!last) return remove(key);
			place(key, {
				kind: "remote",
				key,
				live: false,
				handle: offlineHandle(last.snapshot, last.label),
			});
		},
		remove,
		ownerOf(id) {
			return agg.ownerOf.get(id)?.key || null;
		},
		isLive(key) {
			return byKey.get(key)?.live === true;
		},
		keys() {
			return [...byKey.keys()];
		},
		snapshotOf(key, board) {
			const mine = (id: string) => agg.ownerOf.get(id)?.key === key;
			const projects = board.projects.filter((p) => mine(p.id));
			const tasks: Record<string, unknown[]> = {};
			for (const p of projects) tasks[p.id] = [];
			for (const t of board.tasks) tasks[t.projectId]?.push(t);
			return {
				at: Date.now(),
				projects,
				tasks,
				loops: board.loops.filter((l) => mine(l.id)),
			};
		},
	};
}

/** The project to show, as its card key: the one showing while it's still there,
 *  else the one picked last, else the first. The pick is kept as a card key; from
 *  before projects spanned boxes it is a project id, which finds its card too. */
export function pickProject(
	cards: UnifiedProject[],
	current: string | null,
	picked: string | null,
): string | null {
	if (current && cards.some((c) => c.key === current)) return current;
	if (picked) {
		const card =
			cards.find((c) => c.key === picked) ??
			cards.find((c) => c.members.some((m) => m.projectId === picked));
		if (card) return card.key;
	}
	return cards[0]?.key ?? null;
}
