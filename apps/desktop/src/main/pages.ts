// Agent pages (the show_page board tool, ask_user's `page`): HTML an agent
// wrote, served to the renderer's sandboxed frames from a scheme of their own.
//
// Not srcdoc: a srcdoc frame inherits the window's Content-Security-Policy
// (script-src 'self'), so the page's scripts would never run. A page served
// here gets its own policy instead, and the frame's sandbox (allow-scripts
// only, no same origin) keeps it away from Ateam: it cannot read the window,
// call window.ateam, submit forms, open popups or navigate anything but
// itself, and that last one is stopped below. Its scripts may load libraries
// from https CDNs but cannot fetch (no connect-src), so a page shows what the
// agent put in it and nothing more.
//
// The page talks to the window by postMessage only: its height, so the frame
// fits it, and an answer to the question it was drawn with (ateam.answer).
// An answer must come from the user, not from the page answering itself, and
// the page's scripts are the agent's: they can post anything, and they can
// give the frame focus. So the prelude below, which runs before any of them,
// opens a MessageChannel to the window and keeps its end in a closure; the
// window takes the first port a frame sends (the prelude's) and answers only
// from it. ateam.answer sends on it only while the frame has transient user
// activation, which only a real click or key press in the frame gives. Every
// built-in it calls is captured before the page's scripts can replace it.
import { CH, type TaskPageContentDTO } from "@ateam/protocol";
import { protocol, type WebContents } from "electron";
import { PAGE_SCHEME } from "../shared/pages";
import type { Router } from "./backend";

const CSP = [
	"default-src 'none'",
	"script-src 'unsafe-inline' 'unsafe-eval' https:",
	"style-src 'unsafe-inline' https:",
	"img-src data: blob: https:",
	"font-src data: https:",
	"media-src data: blob:",
	"worker-src blob:",
].join("; ");

// Before the agent's own markup, so its styles win and its scripts can call
// ateam.answer from the start.
const PRELUDE = `<!doctype html><meta charset="utf-8">
<style>:root{color-scheme:dark}body{margin:0;padding:12px 14px;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e6e6e9;background:transparent}</style>
<script>(()=>{const up=window.parent,apply=Reflect.apply,isArray=Array.isArray,send=MessagePort.prototype.postMessage;
const active=Object.getOwnPropertyDescriptor(UserActivation.prototype,"isActive").get,ua=navigator.userActivation;
const ch=new MessageChannel(),port=ch.port1;up.postMessage({ateamPage:1,type:"port"},"*",[ch.port2]);
window.ateam=Object.freeze({answer:(value)=>{if(typeof value!=="string"&&!isArray(value))return false;if(!apply(active,ua,[]))return false;apply(send,port,[{type:"answer",value}]);return true}});
const size=()=>up.postMessage({ateamPage:1,type:"height",height:Math.ceil(document.documentElement.getBoundingClientRect().height)},"*");
new ResizeObserver(size).observe(document.documentElement);addEventListener("load",size);})();</script>
`;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const note = (text: string) =>
	`${PRELUDE}<p style="color:#8b8b92;margin:0">${escapeHtml(text)}</p>`;

/** Before app ready: the scheme is a secure, standard one, so https libraries load in it. */
export function registerPageScheme(): void {
	protocol.registerSchemesAsPrivileged([
		{ scheme: PAGE_SCHEME, privileges: { standard: true, secure: true } },
	]);
}

/** After app ready: serve each page from the engine that owns its task. */
export function servePages(router: Router): void {
	protocol.handle(PAGE_SCHEME, async (req) => {
		const [taskId = "", pageId = ""] = new URL(req.url).pathname
			.split("/")
			.filter(Boolean)
			.map(decodeURIComponent);
		let body: string;
		try {
			const page = (await router.handle(CH.tasksPage, [taskId])) as TaskPageContentDTO | null;
			body =
				page && page.id === pageId
					? PRELUDE + page.html
					: note("This page was replaced by a newer one, or removed.");
		} catch (e) {
			body = note(`Could not load this page: ${e instanceof Error ? e.message : String(e)}`);
		}
		return new Response(body, {
			headers: {
				"content-type": "text/html; charset=utf-8",
				"content-security-policy": CSP,
				"x-content-type-options": "nosniff",
				"cache-control": "no-store",
			},
		});
	});
}

/** A page's frame may not navigate away from its page (a link, a location
 *  change, another task's page): it would show something its agent did not
 *  write. Anchors within the page are not navigations and still work. */
export function guardPageFrames(contents: WebContents): void {
	contents.on("will-frame-navigate", (e) => {
		if (e.isMainFrame) return;
		const from = e.frame?.url ?? "";
		if (from.startsWith(`${PAGE_SCHEME}:`) && e.url !== from) e.preventDefault();
	});
}
