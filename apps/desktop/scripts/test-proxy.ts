// Real renderer, CSS, inputs and clicks at two iframe viewport widths.
// No box is touched: a fake engine answers proxy:*; the engine's side has its own tests
// (packages/server/test/proxy.test.ts).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { createServer } from "vite";

const checks =
	"(async()=>{\n    const frames=[document.getElementById('narrow'),document.getElementById('wide')];\n    for(let i=0;i<150 && !frames.every(f=>f.contentWindow.runProxyTests);i++) await new Promise(r=>setTimeout(r,100));\n    const results=[];\n    for(const f of frames) {\n      if(f.contentWindow.innerWidth!==Number(f.width)) throw new Error('Wrong iframe viewport');\n      results.push(await f.contentWindow.runProxyTests());\n    }\n    return results;\n  })()";
const dir = await mkdtemp(join(tmpdir(), "ateam-proxy-ui-"));
// Where the screenshot of both widths lands.
const shot = process.env.ATEAM_UI_SHOT ?? join(tmpdir(), "ateam-proxy-ui.png");
const repo = resolve(import.meta.dir, "../../..");
const renderer = resolve(import.meta.dir, "../src/renderer");
const server = await createServer({
	configFile: false,
	root: renderer,
	cacheDir: join(dir, "cache"),
	resolve: { alias: { "@": resolve(import.meta.dir, "../src/renderer/src") } },
	plugins: [tailwindcss()],
	esbuild: { jsx: "automatic" },
	server: {
		host: "127.0.0.1",
		port: 0,
		hmr: false,
		watch: { ignored: ["**/profile/**"] },
		fs: { allow: [dir, repo] },
	},
});
try {
	await Bun.write(
		join(renderer, "_proxy-fixture.html"),
		`<link rel="stylesheet" href="/src/globals.css"><div id="root"></div><script type="module" src="/@fs/${join(import.meta.dir, "proxy.fixture.tsx")}"></script>`,
	);
	await Bun.write(
		join(renderer, "_proxy-viewports.html"),
		`<!doctype html><style>body{margin:0;background:#111;display:flex;gap:16px}iframe{border:0}</style><iframe id="narrow" src="/_proxy-fixture.html" width="390" height="1000"></iframe><iframe id="wide" src="/_proxy-fixture.html" width="1280" height="1000"></iframe>`,
	);
	await server.listen();
	const address = server.httpServer!.address() as { port: number };
	await Bun.write(
		join(dir, "main.cjs"),
		`const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(join(dir, "profile"))});
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1700,height:1020,webPreferences:{offscreen:true,backgroundThrottling:false}});
 win.webContents.on('console-message',(_e,_l,m)=>console.log(m));
 const timer=setTimeout(()=>{console.error('Proxy UI test timed out');app.exit(1)},45000);
 try {
  await win.loadURL('http://127.0.0.1:${address.port}/_proxy-viewports.html');
  console.log(await win.webContents.executeJavaScript(${JSON.stringify(checks)}));
  require('fs').writeFileSync(${JSON.stringify(shot)},(await win.webContents.capturePage()).toPNG());
  clearTimeout(timer);app.exit(0);
 } catch(e){console.error(e);app.exit(1)}
});`,
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
	await server.close();
	await rm(join(renderer, "_proxy-fixture.html"), { force: true });
	await rm(join(renderer, "_proxy-viewports.html"), { force: true });
	await rm(dir, { recursive: true, force: true });
}
