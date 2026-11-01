import { describe, expect, it } from "bun:test";
import { mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CH } from "@ateam/protocol";
import { deliverFiles, type FileRoute, MAX_BOX_FILE_BYTES } from "./deliver-files";

const tmp = () => mkdtempSync(join(tmpdir(), "deliver-"));

function source(name: string, body = "hello") {
	const p = join(tmp(), name);
	writeFileSync(p, body);
	return p;
}

function fakeRoute() {
	const calls: { owner: string; method: string; args: unknown[] }[] = [];
	const route: FileRoute = {
		ownerKind: (id) => (id.startsWith("box") ? "remote" : "local"),
		handleFor: async (owner, method, args) => {
			calls.push({ owner, method, args });
			return `/tmp/ateam-attachments/${calls.length}.${args[1]}`;
		},
	};
	return { route, calls };
}

describe("deliverFiles", () => {
	it("hands a local agent the Mac's own paths", async () => {
		const { route, calls } = fakeRoute();
		const p = source("a.png");
		expect(await deliverFiles(route, "task-local", [p])).toEqual({ paths: [p] });
		expect(calls).toEqual([]);
	});

	it("sends each file's bytes to the box the owner is on and returns the box paths", async () => {
		const { route, calls } = fakeRoute();
		const a = source("shot.png", "png");
		const b = source("Makefile", "all:");
		const res = await deliverFiles(route, "box-task", [a, b]);
		expect(res).toEqual({
			paths: ["/tmp/ateam-attachments/1.png", "/tmp/ateam-attachments/2.bin"],
		});
		expect(calls[0]).toEqual({
			owner: "box-task",
			method: CH.utilWriteImageBytes,
			args: [Buffer.from("png").toString("base64"), "png"],
		});
	});

	it("sends nothing when one file is too big for a box or is a folder", async () => {
		const { route, calls } = fakeRoute();
		const big = source("video.mov");
		truncateSync(big, MAX_BOX_FILE_BYTES + 1);
		const small = source("a.txt");
		const res = await deliverFiles(route, "box-task", [small, big]);
		expect(res).toEqual({
			error: "video.mov is 10.1 MB, and a file sent to a box can be at most 10 MB.",
		});
		const folder = await deliverFiles(route, "box-task", [dirname(small)]);
		expect("error" in folder && folder.error).toContain("is a folder");
		expect(calls).toEqual([]);
	});
});
