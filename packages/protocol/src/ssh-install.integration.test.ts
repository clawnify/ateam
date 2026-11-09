import { expect, test } from "bun:test";
import { SSH_INSTALL_STATUS } from "./provision";

// Opt in with a disposable Linux container containing bash, flock, and an ateam
// user. The label prevents accidentally running against an ordinary container.
const container = process.env.ATEAM_SSH_SETUP_CONTAINER;
test.skipIf(!container)(
	"SSH attach waits through installation and rejects interrupted setup",
	async () => {
		if (!container) throw new Error("Set ATEAM_SSH_SETUP_CONTAINER to a disposable fixture");
		const inspect = Bun.spawnSync([
			"docker",
			"inspect",
			"-f",
			'{{index .Config.Labels "ateam.test"}}',
			container,
		]);
		expect(inspect.exitCode).toBe(0);
		expect(inspect.stdout.toString().trim()).toBe("ssh-native");
		const run = (command: string) =>
			Bun.spawnSync(["docker", "exec", "-u", "ateam", container, "bash", "-lc", command]);
		// Refuse to overwrite a previous test or a real install, even in a labelled container.
		expect(
			run(
				"test ! -e ~/.ateam/install.lock && test ! -e ~/.ateam/install-state && test ! -e ~/.ateam-phone-install.lock && test ! -e ~/.ateam-phone-install-exit && test ! -e ~/ateam-install.log",
			).exitCode,
		).toBe(0);
		expect(run(SSH_INSTALL_STATUS).exitCode).toBe(0);
		try {
			expect(
				run("touch ~/.ateam-phone-install.lock; echo interrupted > ~/ateam-install.log").exitCode,
			).toBe(0);
			expect(run(SSH_INSTALL_STATUS).exitCode).toBe(74);
			expect(run("echo 1 > ~/.ateam-phone-install-exit").exitCode).toBe(0);
			expect(run(SSH_INSTALL_STATUS).exitCode).toBe(74);
			expect(run("echo 0 > ~/.ateam-phone-install-exit").exitCode).toBe(0);
			expect(run(SSH_INSTALL_STATUS).exitCode).toBe(0);
			// Even a success marker cannot allow attach until the installer releases its lock.
			const holder = Bun.spawn(
				[
					"docker",
					"exec",
					"-i",
					"-u",
					"ateam",
					container,
					"bash",
					"-lc",
					"flock -x ~/.ateam-phone-install.lock bash -c 'echo locked; read -r release'",
				],
				{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
			);
			const reader = holder.stdout.getReader();
			try {
				const ready = await reader.read();
				expect(new TextDecoder().decode(ready.value)).toContain("locked");
				expect(run(SSH_INSTALL_STATUS).exitCode).toBe(75);
			} finally {
				holder.stdin.write("release\n");
				holder.stdin.end();
				await holder.exited;
				reader.releaseLock();
			}
			expect(run(SSH_INSTALL_STATUS).exitCode).toBe(0);
		} finally {
			run("rm -f ~/.ateam-phone-install.lock ~/.ateam-phone-install-exit ~/ateam-install.log");
		}
	},
	15_000,
);
