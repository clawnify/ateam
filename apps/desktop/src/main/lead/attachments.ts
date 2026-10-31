// Files the user attaches in the Lead chat. Each is copied to
// <lead dir>/attachments/<id>/<its name>: inside the folder the Lead's agent
// runs in, so its Read opens one without a permission prompt (Claude Code asks
// before reading outside its working directory), and apart from the original,
// which may move or change. They are also the only files the Lead's tools hand
// to a task: those tools run without asking, and what the Lead reads from tasks
// could ask it to send something else.
import { randomUUID } from "node:crypto";
import {
	constants,
	copyFileSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, extname, join, sep } from "node:path";
import type { LeadAttachResult, LeadFile } from "../../shared/lead";

/** How long an attachment is kept. After that the chat shows it without a preview. */
export const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "heic", "avif"]);

/** A file name that stays one name: no separators, never "." or "..". */
function safeName(name: string): string {
	const n = basename(name)
		.replace(/[/\\:\0]/g, "_")
		.slice(0, 120);
	return n && n !== "." && n !== ".." ? n : "file";
}

export class LeadAttachments {
	private readonly root: string;

	constructor(leadDir: string) {
		const dir = join(leadDir, "attachments");
		mkdirSync(dir, { recursive: true });
		// Real path, so a check against it can't be fooled by a symlink on the way.
		this.root = realpathSync(dir);
	}

	/** Copy files from this Mac into the chat. On APFS the copy is a clone, so a
	 *  big file costs no space until one side changes. */
	addPaths(paths: string[]): LeadAttachResult {
		const files: LeadFile[] = [];
		const failed: string[] = [];
		for (const p of paths) {
			try {
				if (!statSync(p).isFile()) {
					failed.push(`${basename(p)} is a folder: attach the files in it instead.`);
					continue;
				}
				const dest = this.slot(basename(p));
				copyFileSync(p, dest, constants.COPYFILE_FICLONE);
				files.push(this.describe(dest));
			} catch (e) {
				failed.push(`${basename(p)} couldn't be attached: ${e instanceof Error ? e.message : e}`);
			}
		}
		return { files, failed };
	}

	/** A file with no path on this Mac (a pasted screenshot), from its bytes. */
	addBytes(name: string, data: Uint8Array): LeadFile {
		const dest = this.slot(name || "pasted.png");
		writeFileSync(dest, data);
		return this.describe(dest);
	}

	/** The attached files these paths name, or why one of them is not one. */
	resolve(paths: string[]): LeadFile[] | string {
		const out: LeadFile[] = [];
		for (const p of paths) {
			let real: string;
			try {
				real = realpathSync(p);
			} catch {
				return `${basename(p)} is no longer attached: attachments are kept for 30 days. Ask the user to attach it again.`;
			}
			if (!real.startsWith(this.root + sep) || !statSync(real).isFile())
				return `${p} is not a file the user attached in this chat, and only those can be sent. Ask the user to attach it here.`;
			out.push(this.describe(real));
		}
		return out;
	}

	/** Remove attachments older than `KEEP_MS`. */
	prune(now = Date.now()): void {
		for (const name of readdirSync(this.root)) {
			const dir = join(this.root, name);
			try {
				if (now - statSync(dir).mtimeMs > KEEP_MS) rmSync(dir, { recursive: true, force: true });
			} catch {
				/* raced or removed: nothing to do */
			}
		}
	}

	/** A fresh folder of its own, so the file keeps its exact name. */
	private slot(name: string): string {
		const dir = join(this.root, randomUUID());
		mkdirSync(dir);
		return join(dir, safeName(name));
	}

	private describe(path: string): LeadFile {
		const name = basename(path);
		return {
			path,
			name,
			size: statSync(path).size,
			image: IMAGE_EXTS.has(extname(name).slice(1).toLowerCase()),
		};
	}
}
