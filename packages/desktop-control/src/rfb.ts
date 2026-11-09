/** The client half of RFB 3.8, as emitted by Ubuntu's noVNC. Frame messages
 * before forwarding: WebSocket boundaries are NOT RFB message boundaries.
 * Unknown extensions fail closed rather than letting input bypass the lease.
 * Server pixels pass through untouched; there is no second renderer/capture. */
export class RfbInputGate {
	private buffer = Buffer.alloc(0);
	private stage = 0;
	private generation = 0;
	private messageGeneration: number | null = null;
	private allowedAtStart = false;
	private keys = new Map<string, Buffer>();
	private pointer: Buffer | null = null;
	constructor(
		private readonly send: (data: Buffer) => void,
		private readonly canInput: () => boolean,
		/** Called for each input message forwarded while this viewer controls. */
		private readonly onInput: () => void = () => {},
	) {}

	feed(data: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, data]);
		if (this.buffer.length > 1_100_000) throw new Error("VNC message too large");
		while (this.buffer.length) {
			if (this.messageGeneration === null) {
				this.messageGeneration = this.generation;
				this.allowedAtStart = this.canInput();
			}
			const length = this.length();
			if (length === null || this.buffer.length < length) return;
			const message = this.buffer.subarray(0, length);
			const allowed =
				this.allowedAtStart && this.messageGeneration === this.generation && this.canInput();
			this.buffer = this.buffer.subarray(length);
			this.messageGeneration = null;
			if (this.stage < 4) {
				if (this.stage === 0 && message.toString() !== "RFB 003.008\n")
					throw new Error("RFB 3.8 required");
				if (this.stage === 1 && message[0] !== 2)
					throw new Error("VNC password authentication required");
				// Always shared: one viewer must never evict another.
				this.send(this.stage === 3 ? Buffer.from([1]) : message);
				this.stage++;
				continue;
			}
			const type = message.readUInt8(0);
			if ([4, 5, 6, 251, 255].includes(type)) {
				if (!allowed) continue;
				if (type === 4 || type === 255) {
					const down = type === 4 ? message[1] : message.readUInt16BE(2);
					const id = `${type}:${message.subarray(4).toString("hex")}`;
					if (down) this.keys.set(id, Buffer.from(message));
					else this.keys.delete(id);
				}
				if (type === 5) this.pointer = Buffer.from(message);
				this.onInput();
			}
			this.send(message);
		}
	}

	/** Release only keys actually forwarded by this viewer, even if its key-up
	 * arrives after takeover. No stuck Ctrl or mouse drag for the next owner. */
	revoke(): void {
		this.generation++;
		for (const key of this.keys.values()) {
			if (key[0] === 4) key[1] = 0;
			else key.writeUInt16BE(0, 2);
			this.send(key);
		}
		this.keys.clear();
		if (this.pointer?.[1]) {
			this.pointer[1] = 0;
			this.send(this.pointer);
		}
		this.pointer = null;
	}

	private length(): number | null {
		if (this.stage < 4) return this.stage === 0 ? 12 : this.stage === 2 ? 16 : 1;
		const b = this.buffer;
		switch (b[0]) {
			case 0:
				return 20; // SetPixelFormat
			case 2:
				return b.length < 4 ? null : 4 + b.readUInt16BE(2) * 4;
			case 3:
				return 10; // FramebufferUpdateRequest
			case 4:
				return 8; // KeyEvent
			case 5:
				return 6; // PointerEvent
			case 6: {
				// ClientCutText, including noVNC's extended clipboard
				if (b.length < 8) return null;
				const size = Math.abs(b.readInt32BE(4));
				if (size > 1_000_000) throw new Error("VNC clipboard too large");
				return 8 + size;
			}
			case 150:
				return 10; // EnableContinuousUpdates
			case 248:
				return b.length < 9 ? null : 9 + b.readUInt8(8); // Fence
			case 251:
				return b.length < 8 ? null : 8 + b.readUInt8(6) * 16; // SetDesktopSize
			case 255:
				if (b.length < 2) return null;
				if (b[1] !== 0) throw new Error("Unsupported VNC extension");
				return 12; // QEMU extended key event
			default:
				throw new Error(`Unsupported VNC message: ${b[0]}`);
		}
	}
}
