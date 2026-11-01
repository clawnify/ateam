import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { KEEP_MS, LeadAttachments } from "./attachments";

const tmp = () => mkdtempSync(join(tmpdir(), "lead-att-"));

function source(name: string, body = "hello") {
	const p = join(tmp(), name);
	writeFileSync(p, body);
	return p;
}

describe("LeadAttachments", () => {
	it("copies a file in under its own name and resolves only what it holds", () => {
		const att = new LeadAttachments(tmp());
		const src = source("spec.pdf", "pdf bytes");
		const { files, failed } = att.addPaths([src]);
		expect(failed).toEqual([]);
		const [f] = files;
		expect(f?.name).toBe("spec.pdf");
		expect(f?.image).toBe(false);
		expect(f?.size).toBe(9);
		expect(readFileSync(f?.path ?? "", "utf8")).toBe("pdf bytes");
		expect(f?.path).not.toBe(src);

		expect(att.resolve([f?.path ?? ""])).toEqual([f as never]);
		// The original on this Mac is not an attachment: the Lead can't send it.
		expect(att.resolve([src])).toContain("not a file the user attached");
	});

	it("refuses a link out of its folder, and folders", () => {
		const leadDir = tmp();
		const att = new LeadAttachments(leadDir);
		const secret = source("id_ed25519", "key");
		const sneaky = join(leadDir, "attachments", "x");
		mkdirSync(sneaky);
		symlinkSync(secret, join(sneaky, "key.png"));
		expect(att.resolve([join(sneaky, "key.png")])).toContain("not a file the user attached");

		const { files, failed } = att.addPaths([dirname(secret)]);
		expect(files).toEqual([]);
		expect(failed[0]).toContain("is a folder");
	});

	it("keeps a pasted file's name to one safe name", () => {
		const att = new LeadAttachments(tmp());
		const shot = att.addBytes("image.png", new Uint8Array([1, 2, 3]));
		expect(shot.name).toBe("image.png");
		expect(shot.image).toBe(true);
		expect(att.addBytes("..", new Uint8Array([1])).name).toBe("file");
		const up = att.addBytes("../../outside.txt", new Uint8Array([1]));
		expect(up.name).toBe("outside.txt");
		expect(att.resolve([up.path])).toEqual([up]);
	});

	it("drops attachments older than 30 days", () => {
		const att = new LeadAttachments(tmp());
		const { files } = att.addPaths([source("a.txt")]);
		att.prune(Date.now());
		expect(att.resolve([files[0]?.path ?? ""])).toHaveLength(1);
		att.prune(Date.now() + KEEP_MS + 60_000);
		expect(att.resolve([files[0]?.path ?? ""])).toContain("no longer attached");
	});
});
