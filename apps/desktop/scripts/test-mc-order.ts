// Run with: bun apps/desktop/scripts/test-mc-order.ts
// Real MissionControl and xterm in an isolated Electron window; no daemon.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "ateam-mc-order-"));
try {
	const build = await Bun.build({
		entrypoints: [join(import.meta.dir, "mc-order.fixture.tsx")],
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
		`<link rel="stylesheet" href="mc-order.fixture.css"><style>
body{margin:0}#root{width:1488px;height:989px;display:flex}.mc-wrap{flex:1;display:flex;position:relative;min-height:0;overflow:hidden}.mc{flex:1;display:grid;overflow:hidden}.tile{display:flex;flex-direction:column;min-height:0;min-width:0;border:1px solid gray}.bar{height:26px;display:flex}.term-wrap{flex:1;min-height:0;display:flex}.terminal{flex:1;min-height:0;display:flex;flex-direction:column}.terminal-view{flex:1;min-height:0}.mcpager{position:absolute;bottom:0;right:0}
</style><div id="root"></div><script type="module" src="mc-order.fixture.js"></script>`,
	);
	await Bun.write(
		join(dir, "main.cjs"),
		`const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(join(dir, "profile"))});
app.whenReady().then(async()=>{
const win=new BrowserWindow({show:false,width:1550,height:1100,webPreferences:{offscreen:true,backgroundThrottling:false}});
win.webContents.on('console-message',(_e,_level,message)=>console.log(message));
const timer=setTimeout(()=>{console.error('Mission Control test timed out');app.exit(1)},90000);
try{await win.loadFile(${JSON.stringify(join(dir, "index.html"))});
console.log(await win.webContents.executeJavaScript('window.runMcOrderTests()'));
clearTimeout(timer);app.exit(0)}catch(e){console.error(e);app.exit(1)}});`,
	);
	const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" };
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
