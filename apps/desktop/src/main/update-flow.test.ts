import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { MessageBoxOptions } from "electron";
import { createUpdateFlow, type UpdateFlowDeps } from "./update-flow";

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * electron-updater's surface as the flow uses it. Like the real one, a failed
 * download emits `error` and then rejects the downloadUpdate() promise.
 */
function harness(opts: { autoDownload: boolean; skipped?: string; answers?: number[] }) {
	const updater = new EventEmitter() as EventEmitter & {
		checkForUpdates: () => Promise<unknown>;
		downloadUpdate: () => Promise<unknown>;
		quitAndInstall: () => void;
	};
	const calls = { checks: 0, downloads: 0, installs: 0 };
	let finishDownload: { resolve: () => void; reject: (e: Error) => void } | null = null;
	updater.checkForUpdates = async () => {
		calls.checks++;
		return null;
	};
	updater.downloadUpdate = () => {
		calls.downloads++;
		return new Promise<unknown>((resolve, reject) => {
			finishDownload = { resolve: () => resolve([]), reject };
		});
	};
	updater.quitAndInstall = () => {
		calls.installs++;
	};
	const dialogs: MessageBoxOptions[] = [];
	const answers = [...(opts.answers ?? [])];
	const progress: number[] = [];
	let skipped = opts.skipped ?? "";
	const flow = createUpdateFlow({
		updater: updater as unknown as UpdateFlowDeps["updater"],
		ask: async (o) => {
			dialogs.push(o);
			return { response: answers.shift() ?? 1 };
		},
		setProgress: (f) => progress.push(f),
		autoDownload: () => opts.autoDownload,
		currentVersion: "0.1.72",
		skipped: { read: () => skipped, write: (v) => (skipped = v) },
	});
	return {
		flow,
		updater,
		calls,
		dialogs,
		progress,
		messages: () => dialogs.map((d) => d.message),
		skipped: () => skipped,
		/** The library finishing the zip: progress done, then update-downloaded. */
		downloaded(version = "0.1.73") {
			updater.emit("update-downloaded", { version });
			finishDownload?.resolve();
		},
		failDownload(message: string) {
			const err = new Error(message);
			updater.emit("error", err);
			finishDownload?.reject(err);
		},
	};
}

describe("a manual check with automatic downloads on", () => {
	it("says the download started instead of staying silent, and shows Dock progress", async () => {
		const h = harness({ autoDownload: true });
		h.flow.check(true);
		h.updater.emit("update-available", { version: "0.1.73" });
		await tick();
		expect(h.calls.downloads).toBe(1);
		expect(h.messages()).toEqual(["Downloading Ateam 0.1.73…"]);
		expect(h.dialogs[0].detail).toContain("You have 0.1.72.");
		expect(h.progress).toEqual([0]);

		h.updater.emit("download-progress", { percent: 42.7 });
		expect(h.progress.at(-1)).toBeCloseTo(0.427);
	});

	it("clicked again mid-download, says how far it is without checking or downloading again", async () => {
		const h = harness({ autoDownload: true });
		h.flow.check(true);
		h.updater.emit("update-available", { version: "0.1.73" });
		h.updater.emit("download-progress", { percent: 42.7 });
		h.flow.check(true);
		await tick();
		expect(h.calls.checks).toBe(1);
		expect(h.calls.downloads).toBe(1);
		expect(h.dialogs[1].detail).toContain("42% done.");
	});

	it("offers Restart Now when done, clears the Dock bar, and installs on Restart", async () => {
		const h = harness({ autoDownload: true, answers: [0, 0] });
		h.flow.check(true);
		h.updater.emit("update-available", { version: "0.1.73" });
		h.downloaded();
		await tick();
		expect(h.messages()).toEqual([
			"Downloading Ateam 0.1.73…",
			"Ateam 0.1.73 has been downloaded.",
		]);
		expect(h.progress.at(-1)).toBe(-1);
		expect(h.calls.installs).toBe(1);
	});

	it("reports a failed download, clears the Dock bar, and the next click checks afresh", async () => {
		const h = harness({ autoDownload: true });
		h.flow.check(true);
		h.updater.emit("update-available", { version: "0.1.73" });
		h.failDownload("net::ERR_INTERNET_DISCONNECTED");
		await tick();
		expect(h.messages()).toEqual(["Downloading Ateam 0.1.73…", "Couldn't download Ateam 0.1.73."]);
		expect(h.dialogs[1].detail).toContain("net::ERR_INTERNET_DISCONNECTED");
		expect(h.progress.at(-1)).toBe(-1);
		h.flow.check(true);
		expect(h.calls.checks).toBe(2);
	});
});

describe("a background check with automatic downloads on", () => {
	it("downloads quietly with Dock progress, then offers Restart Now", async () => {
		const h = harness({ autoDownload: true });
		h.flow.check(false);
		h.updater.emit("update-available", { version: "0.1.73" });
		await tick();
		expect(h.dialogs).toEqual([]);
		expect(h.progress).toEqual([0]);
		h.downloaded();
		await tick();
		expect(h.messages()).toEqual(["Ateam 0.1.73 has been downloaded."]);
	});

	it("fails quietly (the next check retries), unless the user asked about it meanwhile", async () => {
		const quiet = harness({ autoDownload: true });
		quiet.flow.check(false);
		quiet.updater.emit("update-available", { version: "0.1.73" });
		quiet.failDownload("timeout");
		await tick();
		expect(quiet.dialogs).toEqual([]);
		expect(quiet.progress.at(-1)).toBe(-1);

		const asked = harness({ autoDownload: true });
		asked.flow.check(false);
		asked.updater.emit("update-available", { version: "0.1.73" });
		asked.flow.check(true);
		asked.failDownload("timeout");
		await tick();
		expect(asked.messages()).toEqual([
			"Downloading Ateam 0.1.73…",
			"Couldn't download Ateam 0.1.73.",
		]);
	});

	it("does not offer or fetch the same version again while it downloads or waits for a restart", async () => {
		const h = harness({ autoDownload: false, answers: [0, 1] });
		h.flow.check(false);
		h.updater.emit("update-available", { version: "0.1.73" });
		await tick();
		h.flow.check(false);
		h.updater.emit("update-available", { version: "0.1.73" });
		await tick();
		expect(h.calls.downloads).toBe(1);
		h.downloaded();
		await tick();
		h.flow.check(false);
		h.updater.emit("update-available", { version: "0.1.73" });
		await tick();
		expect(h.messages()).toEqual([
			"A new version of Ateam is available!",
			"Ateam 0.1.73 has been downloaded.",
		]);
	});
});

describe("with automatic downloads off", () => {
	it("asks first; Install Update downloads with Dock progress and reports a failure", async () => {
		const h = harness({ autoDownload: false, answers: [0] });
		h.flow.check(false);
		h.updater.emit("update-available", { version: "0.1.73" });
		await tick();
		expect(h.messages()).toEqual(["A new version of Ateam is available!"]);
		expect(h.calls.downloads).toBe(1);
		expect(h.progress).toEqual([0]);
		h.failDownload("disk full");
		await tick();
		expect(h.messages().at(-1)).toBe("Couldn't download Ateam 0.1.73.");
	});

	it("keeps Skip This Version quiet for background checks but not for a manual one", async () => {
		const h = harness({ autoDownload: false, skipped: "0.1.73" });
		h.flow.check(false);
		h.updater.emit("update-available", { version: "0.1.73" });
		await tick();
		expect(h.dialogs).toEqual([]);
		h.flow.check(true);
		h.updater.emit("update-available", { version: "0.1.73" });
		await tick();
		expect(h.messages()).toEqual(["A new version of Ateam is available!"]);
	});
});

describe("a manual check with nothing to download", () => {
	it("says up to date, while a background check says nothing", async () => {
		const h = harness({ autoDownload: true });
		h.flow.check(false);
		h.updater.emit("update-not-available");
		h.flow.check(true);
		h.updater.emit("update-not-available");
		await tick();
		expect(h.messages()).toEqual(["You're up to date!"]);
	});

	it("reports a failed check", async () => {
		const h = harness({ autoDownload: true });
		h.flow.check(true);
		h.updater.emit("error", new Error("getaddrinfo ENOTFOUND github.com"));
		await tick();
		expect(h.messages()).toEqual(["Couldn't check for updates."]);
	});

	it("after a download the user put off, offers Restart Now again instead of re-checking", async () => {
		const h = harness({ autoDownload: true, answers: [1, 0] });
		h.flow.check(false);
		h.updater.emit("update-available", { version: "0.1.73" });
		h.downloaded();
		await tick();
		h.flow.check(true);
		await tick();
		expect(h.calls.checks).toBe(1);
		expect(h.messages()).toEqual([
			"Ateam 0.1.73 has been downloaded.",
			"Ateam 0.1.73 has been downloaded.",
		]);
		expect(h.calls.installs).toBe(1);
	});
});
