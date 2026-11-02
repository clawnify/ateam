// The dot on the header's Lead button for the connected box (lead-badge.ts
// says what lights it).
import type { LeadClient } from "@ateam/protocol";
import { useEffect, useState } from "react";
import { BADGE_TAIL, badgeOf, EMPTY_BADGE, foldBadge, type LeadBadge } from "./lead-badge";
import { loadLeadSeen, saveLeadSeen } from "./storage";

/** The badge for this box's Lead. `box`: where "seen" is kept. `looking`: the
 *  chat is on screen, so whatever arrives is seen. `lead` is null when the box
 *  has no Lead (older than v24), and there's no badge then. */
export function useLeadBadge(
	lead: LeadClient | null,
	box: string | null,
	looking: boolean,
): LeadBadge {
	const [state, setState] = useState(EMPTY_BADGE);
	const [seen, setSeen] = useState<number | null>(null);

	useEffect(() => {
		setState(EMPTY_BADGE);
		setSeen(null);
		if (!lead || !box) return;
		let live = true;
		const off = lead.onEvent((e) => {
			if (e.type === "item") setState((s) => foldBadge(s, [e.item]));
			else if (e.type === "reset") setState(foldBadge(EMPTY_BADGE, e.snapshot.items));
		});
		// The read is also what starts the box sending this connection its events.
		Promise.all([lead.snapshot({ tail: BADGE_TAIL }), loadLeadSeen(box)]).then(
			([snap, stored]) => {
				if (!live) return;
				// The box subscribes this connection when the read arrives and frames
				// keep their order, so the snapshot holds everything before it.
				const s = foldBadge(EMPTY_BADGE, snap.items);
				setState(s);
				// First time on this box: what's there already isn't news, but what
				// comes after it is, even if the app is closed in between.
				setSeen(stored ?? s.newest);
				if (stored === null) void saveLeadSeen(box, s.newest);
			},
			() => {},
		);
		return () => {
			live = false;
			off();
		};
	}, [lead, box]);

	// On screen: everything up to the newest item is seen.
	useEffect(() => {
		if (!looking || !box || seen === null || state.newest <= seen) return;
		setSeen(state.newest);
		void saveLeadSeen(box, state.newest);
	}, [looking, box, seen, state.newest]);

	return looking ? null : badgeOf(state, seen);
}
