import type { WebContents } from "electron";
import { PAGE_SCHEME } from "../shared/pages";

/** A page's frame may not navigate away from its page (a link, a location
 *  change, another task's page): it would show something its agent did not
 *  write. Anchors within the page are not navigations and still work. */
export function guardPageFrames(contents: WebContents): void {
	contents.on("will-frame-navigate", (e) => {
		if (e.isMainFrame) return;
		let from: string;
		try {
			// Electron 34 can throw from the frame getter during teardown instead
			// of returning null. Neither a missing nor a disposed frame may navigate.
			const frame = e.frame;
			if (!frame) {
				e.preventDefault();
				return;
			}
			from = frame.url;
		} catch {
			e.preventDefault();
			return;
		}
		if (from.startsWith(`${PAGE_SCHEME}:`) && e.url !== from) e.preventDefault();
	});
}
