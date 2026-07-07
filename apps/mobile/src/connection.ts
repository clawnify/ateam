// The phone's link to a box: open a WebSocket to the box's opt-in `ateam` WS
// listener (reachable over Tailscale), handshake the protocol version, then bind
// the full AteamApi over it. React Native can't spawn `ssh` like the desktop, but
// it ships a WebSocket — and @ateam/protocol is pure TS, so buildAteamApi runs
// here unchanged. This is the whole client: everything else is the shared contract.
import {
	type AteamApi,
	buildAteamApi,
	createRpcClient,
	type NativeClientApi,
	PROTOCOL_VERSION,
	type SystemInfo,
	serverHandshake,
	wsClientTransport,
} from "@ateam/protocol";

// A remote client owns no local dialogs or clipboard: folder-pick and image
// attach flow over RPC (fs.listDir / util.writeImageBytes) instead, so this
// client-native slice is inert here. Single-window, so the window surface stubs too.
const mobileNative: NativeClientApi = {
	pathForFile: () => "",
	pick: async () => null,
	pickFiles: async () => [],
	stageClipboardImage: async () => false,
	stageImagePath: async () => false,
	openProject: async () => {},
	boundProjectId: () => null,
};

export interface Connection {
	api: AteamApi;
	info: SystemInfo;
	/** Close the socket; the daemon and its live sessions live on. */
	close(): void;
}

const CONNECT_TIMEOUT_MS = 15_000;

/** Connect to `ws://host:port` (the box's Tailscale address + WS port). */
export async function connect(url: string): Promise<Connection> {
	const client = wsClientTransport(url);
	const rpc = createRpcClient(client.transport);
	let info: SystemInfo;
	try {
		// A bad host / firewalled port leaves the socket hanging with no error, so
		// cap the handshake — the UI must not wait forever on connect.
		info = await withTimeout(serverHandshake(rpc), CONNECT_TIMEOUT_MS);
	} catch (err) {
		client.close();
		throw err;
	}
	if (info.protocolVersion !== PROTOCOL_VERSION) {
		client.close();
		throw new Error(
			`Protocol mismatch: box speaks v${info.protocolVersion}, app speaks v${PROTOCOL_VERSION}. Update the older side.`,
		);
	}
	return { api: buildAteamApi(rpc, mobileNative), info, close: client.close };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`connection timed out after ${ms}ms`)), ms);
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
