// The Tailscale-mode transport: buildAteamApi driving the engine over a raw TCP
// socket. This is the exact client seam the phone uses (react-native-tcp-socket →
// socketClientTransport → createRpcClient → buildAteamApi) and the shape the
// daemon's opt-in TCP listener serves. Stubs the engine/dispatcher so the test
// isolates the TRANSPORT + binding, not the native-module-laden engine.
import { type AddressInfo, connect, createServer } from "node:net";
import { expect, test } from "bun:test";
import {
	buildAteamApi,
	CH,
	createRpcClient,
	type NativeClientApi,
	serverHandshake,
} from "@ateam/protocol";
import { serveRpc } from "../src/rpc";
import { socketClientTransport, socketServerTransport } from "../src/transport/socket";

// serveRpc only reads engine.on (to forward events) and dispatcher.handle.
const stubEngine = { on: () => () => {} } as unknown as Parameters<typeof serveRpc>[0];

const nativeStub: NativeClientApi = {
	pathForFile: () => "",
	pick: async () => null,
	pickFiles: async () => [],
	stageClipboardImage: async () => false,
	stageImagePath: async () => false,
	openProject: async () => {},
	boundProjectId: () => null,
};

test("buildAteamApi drives the engine over a real TCP socket", async () => {
	const project = {
		id: "p1",
		name: "demo",
		repoPath: "/x",
		defaultBranch: "main",
		githubOwner: null,
		githubName: null,
		color: null,
	};
	const dispatcher = {
		methods: [CH.systemHello, CH.projectsList],
		handle: async (method: string) => {
			if (method === CH.systemHello) return { protocolVersion: 1, agents: ["claude"] };
			if (method === CH.projectsList) return [project];
			throw new Error(`unexpected method ${method}`);
		},
	} as unknown as Parameters<typeof serveRpc>[1];

	const server = createServer({ allowHalfOpen: true }, (sock) =>
		serveRpc(stubEngine, dispatcher, socketServerTransport(sock)),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;

	const sock = connect(port, "127.0.0.1");
	await new Promise<void>((resolve, reject) => {
		sock.once("connect", resolve);
		sock.once("error", reject);
	});

	// Exactly the phone's connect flow: handshake first (gate the version), then
	// the full AteamApi over the same RPC client.
	const rpc = createRpcClient(socketClientTransport(sock));
	const info = await serverHandshake(rpc);
	expect(info.protocolVersion).toBe(1);
	expect(info.agents).toEqual(["claude"]);

	const api = buildAteamApi(rpc, nativeStub);
	const list = await api.projects.list();
	expect(list).toHaveLength(1);
	expect(list[0]?.name).toBe("demo");

	sock.destroy();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});
