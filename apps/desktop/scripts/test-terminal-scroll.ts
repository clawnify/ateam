// Run with: bun apps/desktop/scripts/test-terminal-scroll.ts
// Uses the shipped Electron/xterm versions, an invisible window and synthetic
// PTY output. Never connects to the user's daemon or launches an agent.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "ateam-terminal-scroll-"));
try {
	const build = await Bun.build({
		entrypoints: [join(import.meta.dir, "terminal-scroll.fixture.tsx")],
		outdir: dir,
		target: "browser",
	});
	if (!build.success) throw new AggregateError(build.logs, "Fixture build failed");
	await Bun.write(
		join(dir, "index.html"),
		`<link rel="stylesheet" href="terminal-scroll.fixture.css">
<style>body{margin:0}#root{display:flex;width:700px;height:500px}</style>
<div id="root"></div><script src="terminal-scroll.fixture.js"></script>`,
	);
	await Bun.write(
		join(dir, "main.cjs"),
		`const {app, BrowserWindow} = require('electron');
app.setPath('userData', ${JSON.stringify(join(dir, "profile"))});
app.whenReady().then(async () => {
  const win = new BrowserWindow({show:false, width:1000, height:800,
    webPreferences:{offscreen:true, backgroundThrottling:false}});
  const timeout = setTimeout(() => {console.error('Terminal test timed out'); app.exit(1)}, 30000);
  try {
    await win.loadFile(${JSON.stringify(join(dir, "index.html"))});
    console.log(await win.webContents.executeJavaScript('window.runTerminalScrollTests()'));
    clearTimeout(timeout);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});`,
	);
	const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" };
	delete env.ELECTRON_RUN_AS_NODE;
	const child = Bun.spawn([require("electron"), join(dir, "main.cjs")], {
		env,
		stdout: "inherit",
		stderr: "inherit",
	});
	process.exitCode = await child.exited;
} finally {
	await rm(dir, { recursive: true, force: true });
}
