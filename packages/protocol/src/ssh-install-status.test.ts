import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SSH_INSTALL_STATUS } from "./provision";

test.skipIf(process.platform !== "linux")(
	"shared installer status uses actual locks and durable completion",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "ateam-install-status-"));
		const lock = join(dir, "install.lock");
		const state = join(dir, "install-state");
		// Always select the isolated modern path; never read or write the user's
		// legacy phone setup markers in their real home directory.
		writeFileSync(lock, "");
		const status = () =>
			Bun.spawnSync(["sh", "-c", SSH_INSTALL_STATUS.replace("$HOME/ateam-app", dir)], {}).exitCode;
		try {
			expect(status()).toBe(74);
			for (const phase of ["preparing", "activating", "starting", "failed:1"]) {
				writeFileSync(state, phase);
				expect(status()).toBe(74); // no holder: unfinished, even if it died without an EXIT trap
			}
			writeFileSync(state, "ready");
			expect(status()).toBe(0);
			const holder = Bun.spawn(
				["flock", "-x", "--close", lock, "sh", "-c", "echo locked; read -r release"],
				{
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const reader = holder.stdout.getReader();
			try {
				expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
				expect(status()).toBe(75); // a previous ready marker cannot outrank an active install
				holder.kill("SIGKILL");
				holder.stdin.end();
				await holder.exited;
			} finally {
				holder.stdin.end();
				reader.releaseLock();
			}
			expect(status()).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);
