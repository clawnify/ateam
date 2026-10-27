// The URL a client loads for a box's browser view (noVNC), shared by the desktop
// and the phone so both open it the same way. Plain string building, no URL or
// URLSearchParams: React Native's are incomplete.

/**
 * `base` is where this client reaches the box's noVNC (`http://host:port`). The
 * settings ride in the fragment, which noVNC reads as well as the query
 * (app/webutil.js getConfigVar) and which never reaches the server, so the
 * password stays out of websockify's request log.
 */
export function browserViewUrl(base: string, password: string): string {
	const opts: [string, string][] = [
		["autoconnect", "true"],
		["resize", "scale"],
		["reconnect", "true"],
		["password", password],
	];
	return `${base}/vnc.html#${opts.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
}
