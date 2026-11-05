// Which devices may use this box over its network port: the WebSocket the phone,
// and a desktop that reaches the box over Tailscale alone, connect to. That port
// has no login of its own, and a tailnet's default policy lets every device reach
// every other, so once the box is locked it serves only the devices paired with
// it. SSH is never gated: it authenticates with the user's key before the relay
// starts (cli.ts serveClient).
//
// Kept in <data dir>/pairings.json, readable by the user alone, and read afresh
// on every use, so `ateam pair` (another process) and the daemon see one state.
// Only hashes of tokens and codes are stored.
//
// A device pairs by redeeming a one-time code for its own token: a code comes
// from a device already paired (Settings → Boxes on the Mac, as a QR the phone's
// Camera opens), from the desktop over SSH, or from `ateam pair` in the box's
// terminal. Revoking a device drops its live connections at once (rpc.ts).
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	PairedDeviceDTO,
	PairingGrantDTO,
	PairingInviteDTO,
	PairingStatusDTO,
} from "@ateam/protocol";

export const PAIRINGS_FILE = "pairings.json";

/** How long a code may be redeemed. */
export const CODE_TTL_MS = 10 * 60 * 1000;

/** Codes are read off a screen and typed: no 0/O, 1/I/L, or U. 30^8 ≈ 6.6e11. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;

interface StoredDevice extends PairedDeviceDTO {
	tokenHash: string;
}

interface PairingFile {
	version: 1;
	/** Unpaired connections are refused. */
	locked: boolean;
	devices: StoredDevice[];
	codes: { hash: string; expiresAt: number }[];
}

const EMPTY: PairingFile = { version: 1, locked: false, devices: [], codes: [] };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Equal hashes, in constant time. */
function sameHash(a: string, b: string): boolean {
	const x = Buffer.from(a, "hex");
	const y = Buffer.from(b, "hex");
	return x.length === y.length && timingSafeEqual(x, y);
}

/** A code as typed: upper case, without spaces or dashes. */
export function normalizeCode(code: string): string {
	return code.toUpperCase().replace(/[\s-]/g, "");
}

function newCode(): string {
	const bytes = randomBytes(CODE_LENGTH);
	let out = "";
	for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
	return out;
}

export class Pairings {
	readonly path: string;

	constructor(
		dataDir: string,
		private readonly now: () => number = Date.now,
	) {
		this.path = join(dataDir, PAIRINGS_FILE);
	}

	private read(): PairingFile {
		if (!existsSync(this.path)) return structuredClone(EMPTY);
		try {
			const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<PairingFile>;
			return {
				version: 1,
				locked: raw.locked === true,
				devices: Array.isArray(raw.devices) ? raw.devices : [],
				codes: Array.isArray(raw.codes) ? raw.codes : [],
			};
		} catch {
			// A damaged file fails closed: nobody's token matches, and the box stays
			// locked until `ateam pair` writes a good one.
			return { ...structuredClone(EMPTY), locked: true };
		}
	}

	private write(f: PairingFile): void {
		const live = f.codes.filter((c) => c.expiresAt > this.now());
		mkdirSync(dirname(this.path), { recursive: true });
		const tmp = `${this.path}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ ...f, codes: live }, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, this.path);
		chmodSync(this.path, 0o600);
	}

	locked(): boolean {
		return this.read().locked;
	}

	status(you: string | null): PairingStatusDTO {
		const f = this.read();
		return {
			locked: f.locked,
			devices: f.devices.map(({ tokenHash: _, ...d }) => d),
			you,
		};
	}

	/** The device a token belongs to, or null. Marks it used. */
	verify(token: unknown): PairedDeviceDTO | null {
		if (typeof token !== "string" || token.length < 16) return null;
		const hash = sha256(token);
		const f = this.read();
		const d = f.devices.find((x) => sameHash(x.tokenHash, hash));
		if (!d) return null;
		d.lastUsedAt = this.now();
		this.write(f);
		const { tokenHash: _, ...dto } = d;
		return dto;
	}

	/** A one-time code for a new device. */
	invite(): PairingInviteDTO {
		const f = this.read();
		const code = newCode();
		const expiresAt = this.now() + CODE_TTL_MS;
		f.codes.push({ hash: sha256(code), expiresAt });
		this.write(f);
		return { code, expiresAt };
	}

	/** Trade a code for a device of its own. Throws when the code isn't live. */
	redeem(code: unknown, label: unknown, kind: unknown): PairingGrantDTO {
		if (typeof code !== "string") throw new Error("That code isn't valid.");
		const hash = sha256(normalizeCode(code));
		const f = this.read();
		const at = f.codes.findIndex((c) => c.expiresAt > this.now() && sameHash(c.hash, hash));
		if (at < 0) throw new Error("That code isn't valid, or it has expired. Ask for a new one.");
		f.codes.splice(at, 1);
		const grant = this.add(f, label, kind);
		this.write(f);
		return grant;
	}

	/** Lock an open box, pairing the device that asked: from now on every other
	 *  device needs a code. */
	lock(label: unknown, kind: unknown): PairingGrantDTO {
		const f = this.read();
		const grant = this.add(f, label, kind);
		f.locked = true;
		this.write(f);
		return grant;
	}

	revoke(id: string): boolean {
		const f = this.read();
		const before = f.devices.length;
		f.devices = f.devices.filter((d) => d.id !== id);
		if (f.devices.length === before) return false;
		this.write(f);
		return true;
	}

	/** Locks a brand-new box: nothing is paired yet, so the first device pairs with
	 *  `ateam pair`, or from a Mac over SSH. A box with a file already (an upgrade, a
	 *  choice made) keeps it. Off until Ateam Go on the App Store can pair
	 *  (LOCK_NEW_BOXES in cli.ts). */
	lockIfNew(): boolean {
		if (existsSync(this.path)) return false;
		this.write({ ...structuredClone(EMPTY), locked: true });
		return true;
	}

	/** `ateam pair --add-device`: pair a device by the hash of a token it made itself.
	 *  A box Ateam Go creates gets the hash in its cloud-init, so the phone is paired
	 *  before it first connects and the token never leaves it. Locked or open stays as
	 *  it is. False when that device is paired already. */
	addDevice(tokenHash: string, label: unknown, kind: unknown): boolean {
		if (!/^[0-9a-f]{64}$/.test(tokenHash)) {
			throw new Error("That isn't a token hash (64 lowercase hex digits).");
		}
		const f = this.read();
		if (f.devices.some((d) => sameHash(d.tokenHash, tokenHash))) return false;
		f.devices.push({ ...this.device(label, kind, null), tokenHash });
		this.write(f);
		return true;
	}

	/** `ateam pair --unlock`: open the box again, for when no paired device is left. */
	unlock(): void {
		const f = this.read();
		f.locked = false;
		this.write(f);
	}

	private add(f: PairingFile, label: unknown, kind: unknown): PairingGrantDTO {
		const token = randomBytes(32).toString("base64url");
		const device = this.device(label, kind, this.now());
		f.devices.push({ ...device, tokenHash: sha256(token) });
		return { token, device };
	}

	private device(label: unknown, kind: unknown, lastUsedAt: number | null): PairedDeviceDTO {
		return {
			id: randomUUID(),
			label: typeof label === "string" && label.trim() ? label.trim().slice(0, 60) : "Device",
			kind: kind === "desktop" || kind === "phone" || kind === "box" ? kind : "desktop",
			createdAt: this.now(),
			lastUsedAt,
		};
	}
}
