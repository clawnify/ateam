// Adding a box, the same from New task's Run on picker and from Settings → Boxes.
import type { BoxWake } from "@ateam/protocol";
import type { HostStatus } from "../../../shared/host";

/**
 * Connect a Tailscale box by address. Connecting is what registers it: it resolves the
 * endpoint, gates the protocol version, and saves the box only once it answers, so a
 * typo or an unreachable box leaves nothing behind. Adding is the user's action, so a
 * box a provider puts to sleep is woken for it, and `wake` (null for none) is saved
 * along with it; adding a box that is already listed is how its provider is changed.
 * A box locked to its paired devices takes a `code`, which connecting redeems.
 */
export async function addTailscaleBox(
	endpoint: string,
	wake: BoxWake | null,
	code?: string,
): Promise<void> {
	await window.ateamHost.connect(endpoint, {
		wake: true,
		binding: wake,
		...(code ? { code } : {}),
	});
}

/**
 * Set a box up over SSH: install() runs the (idempotent) installer on the box,
 * streaming its output to `onLog`, and connects on success; the connections-changed
 * broadcast then brings the box into every list. Resolves with the box's status, for
 * the readiness checklist.
 */
export async function installBox(
	dest: string,
	onLog: (chunk: string) => void,
): Promise<HostStatus> {
	const off = window.ateamHost.onInstallLog((e) => {
		if (e.dest === dest) onLog(e.chunk);
	});
	try {
		return await window.ateamHost.install(dest);
	} finally {
		off();
	}
}
