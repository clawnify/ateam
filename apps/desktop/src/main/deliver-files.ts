// Files picked on this Mac, made readable by the agent that is handed them. A
// local agent opens the Mac's own paths. An agent on a box can't see this Mac,
// so each file's bytes go to that box over its engine connection
// (util:writeImageBytes writes a temp file there) and the agent gets the
// box-side paths. All or nothing: an agent should not start without a file it
// was told it has.
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { CH } from "@ateam/protocol";
import type { Router } from "./backend";

/** The most one file may weigh on its way to a box. The engine connection
 *  carries each message as one line, and a box older than this commit rescans
 *  that line on every chunk it reads (packages/server/src/transport/stream.ts,
 *  now linear), with every terminal on it waiting: measured, 10 MB held it
 *  ~0.2 s, 25 MB ~1.5 s. Raise this once every box has the linear framing.
 *  shortcut: a cap, not a chunked transfer; chunk it if bigger files matter. */
export const MAX_BOX_FILE_BYTES = 10 * 1024 * 1024;

export type FileRoute = Pick<Router, "handleFor" | "ownerKind">;

export type Delivery = { paths: string[] } | { error: string };

// Rounded up, so a file just over the cap never reads as the cap itself.
const mb = (bytes: number) => `${Math.ceil((bytes / 1024 / 1024) * 10) / 10} MB`;

/** Why these files can't reach the machine `ownerId` lives on, or null when they can. */
export function checkFiles(route: FileRoute, ownerId: string, paths: string[]): string | null {
	if (route.ownerKind(ownerId) === "local") return null;
	for (const p of paths) {
		let size: number;
		try {
			const st = statSync(p);
			if (!st.isFile()) return `${basename(p)} is a folder, and only files can be sent to a box.`;
			size = st.size;
		} catch {
			return `${basename(p)} isn't on this Mac any more.`;
		}
		if (size > MAX_BOX_FILE_BYTES)
			return `${basename(p)} is ${mb(size)}, and a file sent to a box can be at most ${mb(MAX_BOX_FILE_BYTES)}.`;
	}
	return null;
}

/** The paths the agent on `ownerId`'s machine should be given for these files. */
export async function deliverFiles(
	route: FileRoute,
	ownerId: string,
	paths: string[],
): Promise<Delivery> {
	if (route.ownerKind(ownerId) === "local") return { paths };
	const why = checkFiles(route, ownerId, paths);
	if (why) return { error: why };
	const out: string[] = [];
	for (const p of paths) {
		try {
			const base64 = readFileSync(p).toString("base64");
			// The box names the copy by its extension alone; with none, "bin"
			// rather than the method's image default.
			const ext = extname(p).slice(1) || "bin";
			out.push((await route.handleFor(ownerId, CH.utilWriteImageBytes, [base64, ext])) as string);
		} catch (e) {
			const why = e instanceof Error ? e.message : String(e);
			return { error: `Sending ${basename(p)} to the box failed: ${why}` };
		}
	}
	return { paths: out };
}
