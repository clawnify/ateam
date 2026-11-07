// Run with: bun apps/desktop/scripts/test-task-workspace.ts
// Real TaskPanel, question cards and xterm in an isolated Electron window.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "ateam-task-workspace-"));
try {
	const build = await Bun.build({
		entrypoints: [join(import.meta.dir, "task-workspace.fixture.tsx")],
		outdir: dir,
		target: "browser",
		plugins: [
			{
				name: "renderer-alias",
				setup(builder) {
					builder.onResolve({ filter: /^@\// }, ({ path }) => ({
						path: Bun.resolveSync(
							join(import.meta.dir, "../src/renderer/src", path.slice(2)),
							import.meta.dir,
						),
					}));
				},
			},
		],
	});
	if (!build.success) throw new AggregateError(build.logs, "Fixture build failed");
	await Bun.write(
		join(dir, "index.html"),
		'<link rel="stylesheet" href="task-workspace.fixture.css"><div id="root"></div><script type="module" src="task-workspace.fixture.js"></script>',
	);
	await Bun.write(
		join(dir, "main.cjs"),
		`
const {app,BrowserWindow,protocol}=require('electron');
app.setPath('userData',${JSON.stringify(join(dir, "profile"))});
protocol.registerSchemesAsPrivileged([{scheme:'ateam-page',privileges:{standard:true,secure:true}}]);
app.whenReady().then(async()=>{
protocol.handle('ateam-page',()=>new Response('<h1>Saved artifact</h1>'));
const win=new BrowserWindow({show:false,width:1450,height:950,webPreferences:{offscreen:true,backgroundThrottling:false}});
win.webContents.on('console-message',(_e,_level,message)=>console.log(message));
const timer=setTimeout(()=>{console.error('Task workspace test timed out');app.exit(1)},30000);
try{await win.loadFile(${JSON.stringify(join(dir, "index.html"))});
console.log(await win.webContents.executeJavaScript('window.runTaskWorkspaceTests()'));
clearTimeout(timer);app.exit(0)}catch(e){console.error(e);app.exit(1)}});
`,
	);
	const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" };
	delete env.ELECTRON_RUN_AS_NODE;
	const child = Bun.spawn([require("electron"), join(dir, "main.cjs")], {
		env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const timeout = setTimeout(() => child.kill(), 40_000);
	try {
		process.exitCode = await child.exited;
	} finally {
		clearTimeout(timeout);
	}
} finally {
	await rm(dir, { recursive: true, force: true });
}
