// One promise cap for the main process. An RPC has no per-call timeout of its own
// (packages/protocol/src/rpc.ts — deliberately: `projects:clone` and the installer
// legitimately run for minutes), so every place that CAN'T wait forever — a
// handshake, a health probe, a board read — caps itself here.

/** Reject (and clean up) if a promise doesn't settle in time. */
export function withTimeout<T>(p: Promise<T>, ms: number, what = "connection"): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
		p.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}
