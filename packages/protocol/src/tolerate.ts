// Reading an engine that is BEHIND this client.
//
// PROTOCOL_VERSION used to be a gate: a skewed box was refused at the handshake.
// Refusing is safe but total. A box one release old became unusable rather than
// partly useful, and on the phone there was no way to fix it from where the user
// stood. So the version is advisory now, which is what this contract's own doc
// always described ("refuses/warns on mismatch") and which moves the burden here:
// whatever an older engine omits, the client has to survive reading.
//
// Only ONE field actually breaks. `triage` is the sole addition that is REQUIRED
// rather than `| null`, and the board reads `triage.bucket` on every card and in
// every sort comparator, so a pre-v5 engine takes the whole board down with
// "Cannot read properties of undefined". Everything a newer client wants beyond
// that is nullable and every read already spells `?? …`, so it degrades on its
// own. Unknown METHODS need nothing here either: they reject per call, which
// fails the one feature the box lacks instead of the session.
//
// Duck-typed on `worktreePath` (unique to TaskDTO across the wire contract)
// rather than keyed by method name, because TaskDTOs arrive from calls AND from
// taskUpdated events, and a method table would rot the next time one is added.
import { PROTOCOL_VERSION, type RpcClient, type TaskTriage } from "./index";

/**
 * Stands in for the verdict an older engine never computed. `reason` is rendered
 * on the card, so the degradation explains itself exactly where it shows up
 * rather than looking like a card with a blank field.
 */
export const NO_TRIAGE: TaskTriage = {
	bucket: "not_started",
	done: false,
	reason: "older box: no triage verdict",
};

/**
 * Arrays and the top level only. A nested TaskDTO can only reach us from an
 * engine new enough to have filled it in already, so recursing into every object
 * would walk big payloads (git-status snapshots) to find nothing.
 */
function fill(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(fill);
	if (!value || typeof value !== "object") return value;
	const o = value as Record<string, unknown>;
	if (typeof o.worktreePath === "string" && o.triage === undefined) {
		return { ...o, triage: NO_TRIAGE };
	}
	return value;
}

/**
 * Wrap an engine's RPC so this client can read replies from an older one. Both
 * halves are covered because a card arrives either way: `call` for a list, `on`
 * for the taskUpdated that follows it.
 *
 * Returns the rpc untouched when the engine is level or ahead. Ahead needs
 * nothing: extra fields a newer engine sends are simply ignored by this client,
 * which is the direction that was always safe.
 */
export function tolerantRpc(rpc: RpcClient, engineVersion: number): RpcClient {
	if (engineVersion >= PROTOCOL_VERSION) return rpc;
	return {
		call: (method, args) => rpc.call(method, args).then(fill),
		on: (event, handler) => rpc.on(event, (payload) => handler(fill(payload))),
	};
}
