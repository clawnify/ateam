// The GitHub accounts the phone has seen on any box: gh logins, and the owners of the
// boxes' repositories. A box with neither yet (no GitHub repositories, gh not signed
// in) still needs a token for the right owner, and the phone holds one box at a time,
// so these are its choices there. Names only, never tokens.

export interface GithubSeen {
	/** gh logins, newest first. */
	logins: string[];
	/** Repository owners (users and organizations), newest first. */
	owners: string[];
}

export const NO_GITHUB_SEEN: GithubSeen = { logins: [], owners: [] };

const KEEP = 20;

/** What storage held, read defensively: anything malformed reads as nothing seen. */
export function parseGithubSeen(raw: string | null): GithubSeen {
	if (!raw) return NO_GITHUB_SEEN;
	try {
		const v = JSON.parse(raw) as Partial<GithubSeen>;
		const names = (x: unknown) =>
			Array.isArray(x) ? x.filter((s): s is string => typeof s === "string" && s !== "") : [];
		return { logins: names(v.logins).slice(0, KEEP), owners: names(v.owners).slice(0, KEEP) };
	} catch {
		return NO_GITHUB_SEEN;
	}
}

/** Fold in what a box just showed, newest first, once each (GitHub names ignore case). */
export function rememberGithubSeen(
	seen: GithubSeen,
	login: string | null,
	owners: readonly string[],
): GithubSeen {
	const fold = (prev: string[], fresh: readonly string[]) => {
		const out: string[] = [];
		for (const name of [...fresh, ...prev]) {
			if (name && !out.some((o) => o.toLowerCase() === name.toLowerCase())) out.push(name);
		}
		return out.slice(0, KEEP);
	};
	return {
		logins: fold(seen.logins, login ? [login] : []),
		owners: fold(seen.owners, owners),
	};
}

/** Whether a fold changed anything worth writing back. */
export function sameGithubSeen(a: GithubSeen, b: GithubSeen): boolean {
	return a.logins.join("\n") === b.logins.join("\n") && a.owners.join("\n") === b.owners.join("\n");
}
