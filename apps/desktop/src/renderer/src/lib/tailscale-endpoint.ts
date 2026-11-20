// The Tailscale form's host and port fields, and the `host:port` endpoint a box is
// added and listed under (its alias). Pure, so it is tested on its own.

/** A box's network port when the form's port field is left empty (install.sh's default). */
export const DEFAULT_WS_PORT = "8787";

/** Split `host:port` (or `[v6]:port`) into its fields; a bare host keeps no port. */
export function splitEndpoint(endpoint: string): { host: string; port: string } {
	const m = /^(\[[0-9A-Fa-f:.]+\]|[^\s/:[\]]+):(\d+)$/.exec(endpoint.trim());
	if (!m?.[1] || !m[2]) return { host: endpoint.trim(), port: "" };
	return { host: m[1].replace(/^\[(.*)\]$/, "$1"), port: m[2] };
}

/** The endpoint for a host and port as typed, or what to fix. */
export function joinEndpoint(
	host: string,
	port: string,
): { endpoint: string } | { problem: string } {
	const h = host.trim().replace(/^\[(.*)\]$/, "$1");
	if (!h) return { problem: "Enter the box's Tailscale IP or host." };
	if (/[\s/@]/.test(h) || (h.includes(":") && !/^[0-9A-Fa-f:.]+$/.test(h)))
		return { problem: "Enter just the host, like 100.x.y.z, and its port on its own." };
	const p = port.trim() || DEFAULT_WS_PORT;
	if (!/^\d+$/.test(p) || Number(p) < 1 || Number(p) > 65535)
		return { problem: "Enter a port from 1 to 65535." };
	return { endpoint: `${h.includes(":") ? `[${h}]` : h}:${p}` };
}
