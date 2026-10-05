import type { GithubIssuesDTO } from "@ateam/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

const empty: GithubIssuesDTO = { issues: [], syncedAt: null, error: null };

export function useGithubIssues(repository: string | null) {
	const [state, setState] = useState({ repository, data: empty, loading: false });
	const generation = useRef(0);
	const refresh = useCallback(
		async (force = false) => {
			const current = ++generation.current;
			if (!repository) {
				setState({ repository, data: empty, loading: false });
				return;
			}
			setState((prev) => ({
				repository,
				data: prev.repository === repository ? prev.data : empty,
				loading: true,
			}));
			try {
				const data = await window.ateam.projects.issues(repository, force);
				if (generation.current === current) setState({ repository, data, loading: false });
			} catch {
				if (generation.current === current)
					setState((prev) => ({
						repository,
						loading: false,
						data: { ...prev.data, error: "Could not sync GitHub issues. Try refreshing." },
					}));
			}
		},
		[repository],
	);
	useEffect(() => {
		void refresh();
		const onFocus = () => {
			if (!document.hidden) void refresh();
		};
		const timer = window.setInterval(onFocus, 60_000);
		window.addEventListener("focus", onFocus);
		return () => {
			++generation.current;
			window.clearInterval(timer);
			window.removeEventListener("focus", onFocus);
		};
	}, [refresh]);
	return {
		...(state.repository === repository ? state.data : empty),
		loading: state.repository !== repository || state.loading,
		refresh,
	};
}
