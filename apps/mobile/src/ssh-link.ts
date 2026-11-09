// `ateamgo://ssh?host=…&port=…&user=…&provider=…`: the link a provider shares so its
// page opens Ateam Go with Add a box filled in for one of its machines, the way boxd's
// phone page opens Termius. The format for providers is in docs/providers/README.md.
// Never a password or a token: a link is read by whatever opens it and lands in
// histories, so the user pastes that themselves (a provider copies it for them, as
// boxd does). Any page can open one, so it's parsed strictly, and it only fills the
// form: nothing connects until the user checks the host and taps Connect.
import { HOST, linkParams } from "./pair-link";
import { PROVIDER_SETUPS, type SSHSetup } from "./provider-setup";

/** A login name, as the SSH form takes one. */
const USER = /^[a-zA-Z_][a-zA-Z0-9_.-]{0,31}$/;

export interface SSHLink {
	host: string;
	/** Null where the link leaves it out: 22, or typed for a provider with its own. */
	port: string | null;
	/** The login, with a known provider's hints (what its password is called). */
	setup: SSHSetup;
}

/** The machine an SSH link names, or null for another link or anything malformed. */
export function parseSSHLink(url: string): SSHLink | null {
	const params = linkParams(url, "ssh");
	if (!params) return null;
	const param = (name: string) => params.find(([k]) => k === name)?.[1] ?? "";
	const host = param("host");
	if (!host || !HOST.test(host)) return null;
	const port = param("port") || null;
	if (port !== null && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535))
		return null;
	// A provider Ateam Go doesn't know yet is any server: its hints are only labels.
	const known = PROVIDER_SETUPS.find((p) => p.id === param("provider"))?.ssh;
	const user = param("user") || known?.user || "root";
	if (!USER.test(user)) return null;
	return { host, port, setup: { ...known, user } };
}
