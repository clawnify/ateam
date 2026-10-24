// The phone's way to wake a paused Sprite (Fly.io Sprites) before connecting.
//
// A paused Sprite doesn't answer over Tailscale, and once woken it pauses again
// within seconds unless something holds it: sooner than Tailscale finds it again
// (about 6s, measured). So the wake is one call to Sprites' exec API running a
// short task hold inside the Sprite. Running the command wakes it, the hold keeps
// it up while the phone connects, and the engine's own hold takes over once the
// phone attaches. The status Sprites reports lags (it said "cold" for a Sprite
// that was running this very command), so the hold answering is the proof the
// Sprite is up, not a status poll. See docs/providers/sprites.md.
//
// Pure TS, no React Native imports, so it runs under bun test.

const API = "https://api.sprites.dev/v1";
// A wake from paused plus the command took about 4s, measured.
const CALL_TIMEOUT_MS = 30_000;

/** The phone's hold, named apart from the engine's so neither cancels the other. */
export const PHONE_HOLD = "ateam-phone-wake";
/** Long enough to connect; the engine holds from the moment the phone attaches. */
export const PHONE_HOLD_EXPIRE = "2m";

/** An HTTP status from Sprites, or null when there was none. */
export class SpritesError extends Error {
	constructor(
		message: string,
		readonly status: number | null,
	) {
		super(message);
		this.name = "SpritesError";
	}
}

/** What the exec runs: the hold, on the Sprite's own API socket, printing that socket's HTTP status. */
export function holdCommand(): string[] {
	const body = JSON.stringify({ expire: PHONE_HOLD_EXPIRE });
	return [
		"bash",
		"-c",
		`curl -s -o /dev/null -w '%{http_code}' -X PUT --unix-socket /.sprite/api.sock ` +
			`http://sprite/v1/tasks/${PHONE_HOLD} -H 'Content-Type: application/json' -d '${body}'`,
	];
}

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new SpritesError(`${what} timed out after ${CALL_TIMEOUT_MS / 1000}s`, null)),
			CALL_TIMEOUT_MS,
		);
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

export interface SpritesClient {
	/** Wake `sprite` if it's paused, and hold it up for PHONE_HOLD_EXPIRE. */
	wake(sprite: string): Promise<void>;
	/** One signed-in call and nothing else: a rejected token throws. */
	check(): Promise<void>;
}

export function createSpritesClient(token: string, opts: { fetch?: typeof fetch } = {}): SpritesClient {
	const doFetch = opts.fetch ?? fetch;
	const headers = { authorization: `Bearer ${token}` };
	const rejected = (status: number) =>
		status === 401 || status === 403 ? new SpritesError("Sprites rejected the token", status) : null;

	return {
		async wake(sprite) {
			const query = holdCommand()
				.map((arg) => `cmd=${encodeURIComponent(arg)}`)
				.join("&");
			const resp = await withTimeout(
				doFetch(`${API}/sprites/${encodeURIComponent(sprite)}/exec?${query}`, {
					method: "POST",
					headers,
				}),
				"Sprites wake",
			);
			const denied = rejected(resp.status);
			if (denied) throw denied;
			if (resp.status === 404) throw new SpritesError(`Sprites has no Sprite named ${sprite}`, 404);
			if (!resp.ok) throw new SpritesError(`Sprites wake failed (HTTP ${resp.status})`, resp.status);
			const held = (await resp.text()).trim();
			if (held !== "200" && held !== "201") {
				throw new SpritesError(`${sprite} woke, but its hold didn't take (${held || "no answer"})`, null);
			}
		},
		async check() {
			const resp = await withTimeout(doFetch(`${API}/sprites`, { headers }), "Sprites sign-in");
			const denied = rejected(resp.status);
			if (denied) throw denied;
			if (!resp.ok) throw new SpritesError(`Sprites sign-in failed (HTTP ${resp.status})`, resp.status);
		},
	};
}
