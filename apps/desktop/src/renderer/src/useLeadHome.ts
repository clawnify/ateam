import type { LeadHome } from "@ateam/protocol";
import { useEffect, useState } from "react";

const MAC: LeadHome = { box: null, connected: true, canReact: true };

/** Where this window's Lead chat lives: this Mac, or a box (`client.leadBox`,
 *  chosen in Settings → Boxes), and whether that box is held right now. */
export function useLeadHome(): LeadHome {
	const [home, setHome] = useState<LeadHome>(MAC);
	useEffect(() => {
		let live = true;
		const off = window.ateamLead.onHome((h) => setHome(h));
		void window.ateamLead.home().then(
			(h) => live && setHome(h),
			() => {},
		);
		return () => {
			live = false;
			off();
		};
	}, []);
	return home;
}
