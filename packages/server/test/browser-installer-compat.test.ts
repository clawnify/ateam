import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("main's browser installer delegates before mutations on an old engine and propagates download failure", () => {
	const dir = mkdtempSync(join(tmpdir(), "ateam-installer-compat-"));
	const bin = join(dir, "bin");
	mkdirSync(bin);
	const commands: Record<string, string> = {
		id: "echo 501",
		"sprite-env": "exit 0",
		sudo: '[ "$*" = "-n true" ] || exit 90',
		"apt-get": 'touch "$ATEAM_DATA_DIR/mutated"; exit 91',
		node: "exit 0",
		npm: "exit 0",
		sed: `case "$2" in *cli.js*) echo "$FIXTURE_BIN";; *) echo "$FIXTURE_BIN/node";; esac`,
		readlink: 'echo "$2"',
		curl: `printf '%s' "$*" > "$ATEAM_DATA_DIR/download-url"
if [ "\${FAIL_DOWNLOAD:-}" = 1 ]; then exit 22; fi
printf '%s\\n' 'printf compatible > "$ATEAM_DATA_DIR/compat-ran"'`,
	};
	try {
		for (const [name, source] of Object.entries(commands))
			writeFileSync(join(bin, name), `#!/bin/bash\n${source}\n`, { mode: 0o755 });
		const run = (extra: Record<string, string> = {}) =>
			spawnSync("bash", [join(import.meta.dir, "../scripts/install-browser.sh")], {
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					ATEAM_DATA_DIR: dir,
					FIXTURE_BIN: bin,
					...extra,
				},
				encoding: "utf8",
			});
		expect(run().status).toBe(0);
		expect(readFileSync(join(dir, "compat-ran"), "utf8")).toBe("compatible");
		expect(readFileSync(join(dir, "download-url"), "utf8")).toContain(
			"/e880aa5cc109d145fd251ed129f4ece38ec59bad/packages/server/scripts/install-browser.sh",
		);
		expect(existsSync(join(dir, "mutated"))).toBe(false);
		rmSync(join(dir, "compat-ran"));
		expect(run({ FAIL_DOWNLOAD: "1" }).status).toBe(22);
		expect(existsSync(join(dir, "compat-ran"))).toBe(false);
		expect(existsSync(join(dir, "mutated"))).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
