import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

/** Dedicated SQLite files provide OS-backed ownership without another native
 * dependency. Never unlink them: replacing a locked inode would split ownership.
 * These are NOT the application database. Process death releases their locks,
 * including SIGKILL, and SQLite's descriptors do not survive child execs. */
export function ownDaemon(dataDir: string, socket: string): (() => void) | null {
	const held: Database.Database[] = [];
	try {
		// Both resources are exclusive: two sockets must not open the same engine,
		// and two engines must not steal the same socket pathname.
		for (const path of [join(dataDir, "daemon-owner.sqlite"), `${socket}.owner.sqlite`]) {
			mkdirSync(dirname(path), { recursive: true });
			const db = new Database(path, { timeout: 0 });
			held.push(db);
			db.exec("BEGIN EXCLUSIVE");
		}
		return () => {
			for (const db of held) db.close();
		};
	} catch (e) {
		for (const db of held) db.close();
		if ((e as { code?: string }).code === "SQLITE_BUSY") return null;
		throw e;
	}
}

/** Linux installer takes this gate exclusively during activation. Startup holds
 * it only until listening, never for an SSH session or the daemon's lifetime.
 * --close keeps the lock out of the child; closing stdin releases its holder,
 * even if this process is killed. Non-Linux hosts do not run the Linux installer. */
export async function startupGate(dataDir: string): Promise<() => void> {
	if (process.platform !== "linux") return () => {};
	mkdirSync(dataDir, { recursive: true });
	const holder = spawn(
		"flock",
		[
			"-s",
			"-w",
			"30",
			"-E",
			"75",
			"--close",
			join(dataDir, "startup.lock"),
			"sh",
			"-c",
			"printf 'locked\\n'; read -r release",
		],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
	let ready = false;
	let released = false;
	let error = "";
	holder.stderr.on("data", (data) => {
		error += data;
	});
	await new Promise<void>((resolve, reject) => {
		holder.once("error", reject);
		holder.stdout.once("data", () => {
			ready = true;
			resolve();
		});
		holder.once("exit", () => {
			if (!ready) reject(new Error(error || "Ateam installation is activating; retry shortly"));
			else if (!released) {
				console.error("[ateam] startup gate was lost during initialization");
				process.exit(1);
			}
		});
	});
	return () => {
		if (released) return;
		released = true;
		holder.stdin.end("release\n");
	};
}
