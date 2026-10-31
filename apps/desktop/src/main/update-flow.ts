// What the user sees of an update, on top of electron-updater: Sparkle-style,
// ask before downloading (with release notes; "Skip This Version" is
// remembered), then offer "Restart Now" once downloaded, otherwise it installs
// on quit.
//
// A download is never silent. It takes a minute (the zip is over 100 MB), and
// with automatic downloads on, a manual check used to show nothing at all until
// it finished, which reads as a dead menu item. So a download in flight shows
// its progress on the Dock icon, a manual check says it started (and, clicked
// again, how far it is), and a download the user asked for reports its failure.
// Kept free of Electron so the flow is testable; index.ts wires the real
// updater, dialogs and windows in.
import type { MessageBoxOptions } from "electron";
import type { AppUpdater, ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from "electron-updater";

export interface UpdateFlowDeps {
	updater: Pick<AppUpdater, "on" | "checkForUpdates" | "downloadUpdate" | "quitAndInstall">;
	ask: (opts: MessageBoxOptions) => Promise<{ response: number }>;
	/** Progress on the Dock icon: 0 to 1, or -1 to remove it. */
	setProgress: (fraction: number) => void;
	/** The user's setting, read on each update so a change applies without a relaunch. */
	autoDownload: () => boolean;
	currentVersion: string;
	/** The version the user chose to skip ("Skip This Version"), or "". */
	skipped: { read: () => string; write: (version: string) => void };
}

export function createUpdateFlow(d: UpdateFlowDeps): { check: (manual: boolean) => void } {
	// "Remind Me Later" = stay quiet until the next app launch.
	let snoozed = false;
	// A user-initiated check reports its result (incl. "up to date") and ignores
	// snooze/skip; background checks stay silent unless there's a fresh update.
	let manualCheck = false;
	// The download in flight. `asked`: the user started it or asked about it, so
	// its failure is theirs to hear about. A background auto-download that fails
	// stays quiet and is retried by the next check.
	let download: { version: string; asked: boolean; percent: number } | null = null;
	// Downloaded and waiting for a restart (the user picked Later).
	let ready: string | null = null;

	const info = (message: string, detail: string) =>
		void d.ask({ type: "info", title: "Software Update", message, detail, buttons: ["OK"] });

	const showDownloading = (dl: { version: string; percent: number }) =>
		info(
			`Downloading Ateam ${dl.version}…`,
			`You have ${d.currentVersion}.${dl.percent > 0 ? ` ${Math.floor(dl.percent)}% done.` : ""} It downloads in the background, with its progress on the Dock icon, and Ateam asks you to restart once it's ready.`,
		);

	const showReady = (version: string) =>
		void d
			.ask({
				type: "info",
				title: "Update Ready",
				message: `Ateam ${version} has been downloaded.`,
				detail:
					"Restart now to apply it, or keep working and it will install when you quit. Agent terminals survive the restart.",
				buttons: ["Restart Now", "Later"],
				defaultId: 0,
				cancelId: 1,
			})
			.then(({ response }) => {
				if (response === 0) d.updater.quitAndInstall();
			});

	// Idempotent: the library emits `error` and then rejects the same download.
	const downloadFailed = (err: unknown) => {
		if (!download) return;
		const { version, asked } = download;
		download = null;
		manualCheck = false;
		d.setProgress(-1);
		if (!asked) return;
		void d.ask({
			type: "warning",
			title: "Software Update",
			message: `Couldn't download Ateam ${version}.`,
			detail: `${String((err as Error)?.message ?? err)}\n\nCheck for Updates… tries again.`,
			buttons: ["OK"],
		});
	};

	const startDownload = (version: string, asked: boolean) => {
		if (download) {
			download.asked ||= asked;
			return;
		}
		download = { version, asked, percent: 0 };
		d.setProgress(0);
		void d.updater.downloadUpdate().catch((err) => {
			console.warn("[ateam] update download failed:", err);
			downloadFailed(err);
		});
	};

	d.updater.on("update-available", (u: UpdateInfo) => {
		// Already on its way, or downloaded and waiting: a background re-check
		// must not offer it again.
		if (download?.version === u.version || ready === u.version) return;
		if (!manualCheck && (snoozed || u.version === d.skipped.read())) return;
		// Your call, in ~/.ateam/settings.json (client.autoDownloadUpdates): fetch
		// it in the background and only ask at the end, when "Restart Now" is a
		// real choice. Skip / snooze above still win. A manual check still hears
		// that the download started.
		if (d.autoDownload()) {
			startDownload(u.version, manualCheck);
			if (manualCheck && download) showDownloading(download);
			return;
		}
		const notes =
			typeof u.releaseNotes === "string" ? u.releaseNotes.replace(/<[^>]+>/g, "").trim() : "";
		void d
			.ask({
				type: "info",
				title: "Software Update",
				message: `A new version of Ateam is available!`,
				detail: `Ateam ${u.version} is now available, and you have ${d.currentVersion}. Would you like to download it now?${notes ? `\n\n${notes.slice(0, 1500)}` : ""}`,
				buttons: ["Install Update", "Remind Me Later", "Skip This Version"],
				defaultId: 0,
				cancelId: 1,
			})
			.then(({ response }) => {
				if (response === 0) startDownload(u.version, true);
				else if (response === 1) snoozed = true;
				else d.skipped.write(u.version);
			});
	});

	d.updater.on("download-progress", (p: ProgressInfo) => {
		if (download) download.percent = p.percent;
		d.setProgress(p.percent / 100);
	});

	d.updater.on("update-downloaded", (e: UpdateDownloadedEvent) => {
		download = null;
		ready = e.version;
		manualCheck = false;
		d.setProgress(-1);
		showReady(e.version);
	});

	d.updater.on("update-not-available", () => {
		if (!manualCheck) return;
		manualCheck = false;
		info("You're up to date!", `Ateam ${d.currentVersion} is the latest version.`);
	});

	d.updater.on("error", (err: Error) => {
		console.warn("[ateam] updater error:", err);
		if (download) return downloadFailed(err);
		if (!manualCheck) return;
		manualCheck = false;
		void d.ask({
			type: "warning",
			title: "Software Update",
			message: "Couldn't check for updates.",
			detail: String(err?.message ?? err),
			buttons: ["OK"],
		});
	});

	return {
		check(manual) {
			// Nothing to fetch: say where the update already is instead.
			if (manual && ready) return showReady(ready);
			if (manual && download) {
				download.asked = true;
				return showDownloading(download);
			}
			manualCheck = manual;
			void d.updater
				.checkForUpdates()
				.catch((err) => console.warn("[ateam] update check failed:", err));
		},
	};
}
