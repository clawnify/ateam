// Drive the running desktop app's renderer over the Chrome DevTools Protocol.
// CDP's synthetic mouse is what makes CSS :hover fire in Blink, so this can
// verify hover-only styling that a plain screenshot never reaches.
//
//   bun .claude/skills/run-desktop/drive.ts --out <dir> [--port 9333] <step>...
//
// Steps run in order:
//   reload              reload the renderer (after seeding the database)
//   rest                park the pointer off in the far corner (no hover)
//   hover:<selector>    move the pointer to the element's centre
//   click:<selector>    hover, then press and release
//   shot:<name>         screenshot the whole window
//   shot:<name>@<sel>   screenshot cropped to that element, 3x, for fine detail
//   eval:<expression>   evaluate in the page and print the JSON result
const args = process.argv.slice(2);
const opt = (flag: string, fallback?: string) => {
	const i = args.indexOf(flag);
	return i === -1 ? fallback : args[i + 1];
};
const PORT = Number(opt("--port", "9333"));
const OUT = opt("--out", ".") as string;
const steps = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));

const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as Array<{
	type: string;
	title: string;
	webSocketDebuggerUrl: string;
}>;
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error(`no page target on :${PORT} — is the app up? ${JSON.stringify(targets)}`);
console.log("target:", page.title);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map<number, (v: any) => void>();
ws.addEventListener("message", (e) => {
	const msg = JSON.parse(String(e.data));
	if (msg.id && pending.has(msg.id)) {
		pending.get(msg.id)?.(msg);
		pending.delete(msg.id);
	}
});
const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
	const myId = ++id;
	return new Promise((resolve) => {
		pending.set(myId, resolve);
		ws.send(JSON.stringify({ id: myId, method, params }));
	});
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function evaluate(expression: string) {
	const r = await send("Runtime.evaluate", { expression, returnByValue: true });
	if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
	return r.result?.result?.value;
}
async function rect(selector: string) {
	const r = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  })()`);
	if (!r) throw new Error(`no element matches ${selector}`);
	return r as { x: number; y: number; w: number; h: number };
}
const mouse = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
	send("Input.dispatchMouseEvent", { type, x, y, buttons: 0, ...extra });

for (const step of steps) {
	const split = step.indexOf(":");
	const verb = split === -1 ? step : step.slice(0, split);
	const rest = split === -1 ? "" : step.slice(split + 1);
	if (step === "reload") {
		await send("Page.reload");
		await wait(3000);
	} else if (step === "rest") {
		// Far corner of the viewport: nothing under the pointer, so no :hover.
		const vp = await evaluate("({ w: innerWidth, h: innerHeight })");
		await mouse("mouseMoved", vp.w - 2, vp.h - 2);
		await wait(300);
	} else if (verb === "hover" || verb === "click") {
		const b = await rect(rest);
		const [x, y] = [b.x + b.w / 2, b.y + b.h / 2];
		await mouse("mouseMoved", x, y);
		await wait(300);
		if (verb === "click") {
			await mouse("mousePressed", x, y, { button: "left", clickCount: 1, buttons: 1 });
			await mouse("mouseReleased", x, y, { button: "left", clickCount: 1 });
			await wait(500);
		}
	} else if (verb === "shot") {
		const [name, selector] = rest.split("@");
		let clip: Record<string, number> | undefined;
		if (selector) {
			const b = await rect(selector);
			clip = { x: b.x, y: b.y, width: b.w, height: b.h, scale: 3 };
		}
		const r = await send("Page.captureScreenshot", {
			format: "png",
			...(clip ? { clip, captureBeyondViewport: false } : {}),
		});
		if (!r.result?.data) throw new Error(`screenshot failed: ${JSON.stringify(r)}`);
		await Bun.write(`${OUT}/${name}.png`, Buffer.from(r.result.data, "base64"));
		console.log("wrote", `${OUT}/${name}.png`);
	} else if (verb === "eval") {
		console.log(step, "=>", JSON.stringify(await evaluate(rest)));
	} else {
		throw new Error(`unknown step: ${step}`);
	}
}
ws.close();
