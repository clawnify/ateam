// The connection controller: which engines drive the app. Owns the always-alive
// local engine and holds any connected boxes CONCURRENTLY — one board unions their
// tasks, each task's "environment" being the engine that owns it. Every call is
// routed to the owning engine by createAggregate (main/aggregate.ts); every held
// engine's push-events are forwarded to the renderer. Connecting to a box opens a
// transport — the `attach` relay over OpenSSH, or a WebSocket to its Tailscale
// listener — handshakes (gating the protocol version), and ADDS it: connecting
// never drops the others.

import {
	CH,
	type ClientTransport,
	createRpcClient,
	DEFAULT_EDITOR_PORT,
	type EditorEndpointDTO,
	type EditorOpenResult,
	PROTOCOL_VERSION,
	type ProjectDTO,
	type RpcClient,
	type SystemInfo,
	wsClientTransport,
} from "@ateam/protocol";
import { getAgent } from "@ateam/agents";
import {
	buildCloudInit,
	type ConnectionDTO,
	type Engine,
	endpointUrl,
	forgetConnection,
	hetznerProvider,
	type HostTransport,
	listConnections,
	recordConnection,
	resolveTransport,
	sshClientTransport,
	sshExec,
} from "@ateam/server";
import { app, ipcMain } from "electron";
import WebSocket from "ws";
import { join } from "node:path";
import {
	type BoxReadiness,
	type CreateBoxSpec,
	type CreateProgressEvent,
	HOST_CH,
	type HostStatus,
	type InstallAgentResult,
	type InstallLogEvent,
	type ProviderOptions,
	type SecretsStatus,
} from "../shared/host";
import { type Aggregate, createAggregate } from "./aggregate";
import {
	createSecretStore,
	generateBoxKey,
	writeSshConfigEntry,
	waitForSsh,
	waitForTailscale,
} from "./box-setup";
import {
	type Backend,
	type BackendEvent,
	localBackend,
	type Router,
	remoteBackend,
} from "./backend";
import { editorForwardFlags, editorLocalPort } from "./editor-tunnel";
import { withTimeout } from "./timeout";

// The one pre-quoted remote command (ssh space-joins remote args, so `bash -lc`
// must arrive as a single element): a login shell (agent-CLI PATH) execing the
// attach relay. Proven live against the Hetzner box.
const REMOTE_ATTACH = "bash -lc 'exec ateam attach --stdio'";
// The canonical box installer, reused verbatim (single source of truth for how a
// box is set up — the same script the docs tell users to curl by hand).
const INSTALL_URL =
	"https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install.sh";
// Default WebSocket port baked into a provisioned box's Tailscale listener (matches
// the picker's placeholder). The listener only exists if the box is on Tailscale.
const WS_DEFAULT_PORT = 8787;

// Probe a box's task-readiness (base64'd over SSH to dodge quoting) and self-heal the
// git identity: once the box is signed into GitHub, derive name+email from the account
// — `gh auth login` authenticates but does NOT set the commit identity. `\\(` becomes
// `\(` in the string so jq gets its interpolation syntax.
const READINESS_PROBE = `GH=$(command -v gh || true)
SIGNED=0; LOGIN=""
if [ -n "$GH" ] && "$GH" auth status >/dev/null 2>&1; then
	SIGNED=1
	LOGIN=$("$GH" api user -q .login 2>/dev/null || true)
	if [ -z "$(git config --global user.name || true)" ] || [ -z "$(git config --global user.email || true)" ]; then
		N=$("$GH" api user -q '.name // .login' 2>/dev/null || true)
		E=$("$GH" api user -q '"\\(.id)+\\(.login)@users.noreply.github.com"' 2>/dev/null || true)
		[ -n "$N" ] && git config --global user.name "$N"
		[ -n "$E" ] && git config --global user.email "$E"
	fi
fi
echo "gh_installed=$([ -n "$GH" ] && echo 1 || echo 0)"
echo "gh_signed_in=$SIGNED"
echo "gh_login=$LOGIN"
echo "git_name=$(git config --global user.name || true)"
echo "git_email=$(git config --global user.email || true)"`;
// Cap a connect: ssh can hang on an auth prompt or an unreachable host with no
// error, and the UI must not wait forever. A live daemon replies in well under this.
const CONNECT_TIMEOUT_MS = 20_000;
// A WebSocket over Tailscale goes HALF-OPEN on NAT/WireGuard idle timeout (and on
// laptop sleep) with no close event — and createRpcClient has no per-call timeout,
// because it relies on onClose to reject in-flight calls. Without a health probe
// the board would simply stop responding, silently and forever. So: ping, and treat
// a failed ping as the close the socket never sent. 15s is well under the ~25s
// typical NAT/WireGuard mapping timeout; the same interval the phone settled on.
// SSH needs none of this — a dead ssh child exits and closes the pipe for real.
const WS_PING_INTERVAL_MS = 15_000;
const WS_PING_TIMEOUT_MS = 10_000;

/** The push-events forwarded from every held backend to every window. */
const FORWARDED: { event: BackendEvent; channel: string }[] = [
	{ event: "taskUpdated", channel: CH.evtTaskUpdated },
	{ event: "taskRemoved", channel: CH.evtTaskRemoved },
	{ event: "loopsUpdated", channel: CH.evtLoopsUpdated },
	{ event: "ptyData", channel: CH.evtPtyData },
	{ event: "ptyExit", channel: CH.evtPtyExit },
];

/** The main-process connection controller (the renderer-facing shape is AteamHost). */
export interface Host {
	/** The stable indirection the IPC bridge registers against once. */
	readonly router: Router;
	list(): Promise<ConnectionDTO[]>;
	connect(alias: string | null): Promise<HostStatus>;
	disconnect(alias: string): void;
	/** Remove a box from the connections list (disconnecting it first if held). */
	forget(alias: string): void;
	connected(): Promise<HostStatus[]>;
	/** id → owning-engine alias (null = local), from the aggregate's learned registry. */
	origins(): Record<string, string | null>;
	/** Start the in-app editor on the task's engine and resolve the URL THIS
	 *  client loads for it (localhost, ssh forward, or tailnet endpoint) — or
	 *  report that the engine still needs code-server installed. */
	editorUrl(taskId: string): Promise<{ url: string } | { needsInstall: true }>;
	/** Connect the box if needed, then clone+register a repo ON it (from its remote URL). */
	provision(alias: string, input: { cloneUrl: string }): Promise<ProjectDTO>;
	/** Install the ateam engine on a reachable SSH box (idempotent), streaming the
	 *  installer's output, then connect. `dest` is an ssh_config alias or user@host. */
	install(dest: string, opts?: { wsAddr?: string }): Promise<HostStatus>;
	/** Create a box from scratch at a provider, provision it, and connect. */
	createBox(spec: CreateBoxSpec): Promise<HostStatus>;
	/** Install an agent's CLI on a connected box, streaming the log; returns the login step. */
	installAgent(alias: string, agentId: string): Promise<InstallAgentResult>;
	/** Probe a connected box's task-readiness (and self-heal git identity once signed in). */
	boxReadiness(alias: string): Promise<BoxReadiness>;
	/** Which provisioning secrets are saved (booleans, never the values). */
	secretsStatus(): SecretsStatus;
	/** Persist provider credentials (encrypted). Returns the new saved-status. */
	saveSecrets(patch: { hetznerToken?: string; tailscaleAuthKey?: string }): SecretsStatus;
	/** The provider's real regions + sizes for the given token (or the saved one). */
	providerOptions(token?: string): Promise<ProviderOptions>;
}

export interface HostDeps {
	/** The in-process engine — the default backend and the connections-registry db owner. */
	localEngine: Engine;
	/** Push a channel + args to every live window (main-process multi-window fan-out). */
	broadcast: (channel: string, ...args: unknown[]) => void;
}

export function createHost({ localEngine, broadcast }: HostDeps): Host {
	const db = localEngine.services.db;
	const local = localBackend(localEngine);

	// alias → backend; `null` is the always-held local engine (insertion order: local
	// first). Boxes are added on connect and removed on disconnect.
	const backends = new Map<string | null, Backend>([[null, local]]);
	// Per-alias event unsubscribers, so disconnecting one box stops only its stream.
	const unbinders = new Map<string | null, () => void>();
	// Per-alias health probes (ws only) — cleared on disconnect so a dropped box
	// stops pinging a socket nobody is listening to.
	const probes = new Map<string, ReturnType<typeof setInterval>>();
	// alias → the SystemInfo learned at handshake. A held engine's identity doesn't
	// change while it's held (its agent list can, and installAgent refreshes it), so
	// every status read answers from here instead of asking the box again. Asking was
	// the bug: `connected()` is a system:hello PER BOX on every connect/disconnect/
	// install, and an RPC never times out — so one stale box hung the whole list, and
	// with it `connect()`'s already-held path and anything awaiting it.
	const infos = new Map<string | null, SystemInfo>();

	// One aggregate over a LIVE backend array: connecting pushes onto it (so the
	// learned id→engine registry survives), disconnecting rebuilds a fresh one (so a
	// gone engine's ids stop routing). Both share the same array reference.
	const backendList: Backend[] = [local];
	let agg: Aggregate = createAggregate(backendList, local);

	function bindEvents(backend: Backend): () => void {
		const offs = FORWARDED.map(({ event, channel }) =>
			backend.on(event, (payload) => broadcast(channel, payload)),
		);
		return () => {
			for (const off of offs) off();
		};
	}
	// Forward the local engine's events from startup; each connected box adds its own.
	unbinders.set(null, bindEvents(local));

	async function statusOf(backend: Backend, alias: string | null): Promise<HostStatus> {
		// The local engine is in-process — asking it can't hang, and its agent list changes
		// under us (installing a CLI on the Mac), so always ask. A BOX is asked exactly once,
		// at the handshake; `infos` serves every read after that. The fallback is unreachable
		// (connect caches before it registers the backend) but capped rather than trusting.
		if (alias !== null) {
			const cached = infos.get(alias);
			if (cached) return { mode: backend.kind, alias, info: cached };
			await refreshInfo(alias);
			const info = infos.get(alias);
			if (!info) throw new Error(`Couldn't read "${alias}" status — it stopped answering.`);
			return { mode: backend.kind, alias, info };
		}
		const info = (await backend.handle(CH.systemHello, [])) as SystemInfo;
		return { mode: backend.kind, alias, info };
	}

	/** Re-read a held box's system:hello into the cache (its agent list changed). */
	async function refreshInfo(alias: string): Promise<void> {
		const backend = backends.get(alias);
		if (!backend) return;
		try {
			const info = await withTimeout(
				backend.handle(CH.systemHello, []) as Promise<SystemInfo>,
				CONNECT_TIMEOUT_MS,
			);
			infos.set(alias, info);
		} catch {
			// Unreachable mid-refresh: keep the cached info. The probe (ws) or the wire's
			// own close (ssh) is what decides a box is gone — never a stale agent list.
		}
	}

	function connected(): Promise<HostStatus[]> {
		return Promise.all([...backends.entries()].map(([alias, b]) => statusOf(b, alias)));
	}

	function broadcastConnections(): void {
		void connected().then((list) => broadcast(HOST_CH.evtConnectionsChanged, list));
	}

	/**
	 * Open the wire to a box. Which wire is a property of the connection, not of
	 * the call site: an ssh_config alias gets the `attach` relay over OpenSSH; a
	 * `host:port` gets a WebSocket to the box's Tailscale listener.
	 *
	 * The `ws` constructor is injected because Electron's MAIN process is Node 20
	 * (electron 34.5.8 → node 20.19.1), which has no global WebSocket — the
	 * renderer and the phone do, the main process doesn't.
	 */
	function openTransport(
		alias: string,
		wire: HostTransport | null,
	): { transport: ClientTransport; close(): void } {
		if (wire === "ws") {
			const url = endpointUrl(alias);
			if (!url) throw new Error(`"${alias}" is not a host:port endpoint`);
			return wsClientTransport(url, WebSocket as never);
		}
		if (wire === null) {
			throw new Error(
				`Unknown connection "${alias}" — add it to ~/.ssh/config, or give a Tailscale endpoint like 100.x.y.z:8787.`,
			);
		}
		// The editor forward rides the RPC child (idle forwards cost nothing), so
		// the tunnel needs no lifecycle of its own — it dies with the connection.
		return sshClientTransport(alias, [REMOTE_ATTACH], { sshFlags: editorForwardFlags(alias) });
	}

	async function connect(alias: string | null): Promise<HostStatus> {
		// local is permanent; connecting to it (or to an already-held box) is a no-op.
		if (alias === null) return statusOf(local, null);
		const existing = backends.get(alias);
		if (existing) return statusOf(existing, alias);

		// Resolve once: the same answer decides which wire to open AND what we save.
		const wire = resolveTransport(db, alias);
		const client = openTransport(alias, wire);
		const rpc: RpcClient = createRpcClient(client.transport);
		let info: SystemInfo;
		try {
			info = await withTimeout(rpc.call(CH.systemHello) as Promise<SystemInfo>, CONNECT_TIMEOUT_MS);
		} catch (err) {
			client.close();
			throw err;
		}
		if (info.protocolVersion !== PROTOCOL_VERSION) {
			client.close();
			throw new Error(
				`Protocol mismatch: "${alias}" speaks v${info.protocolVersion}, this app speaks v${PROTOCOL_VERSION}. Update the older side.`,
			);
		}

		recordConnection(db, {
			hostAlias: alias,
			transport: wire ?? "ssh",
			serverVersion: String(info.protocolVersion),
			agentsAvailable: info.agents,
		});
		// The remote's method set matches the local dispatcher's (same contract).
		const backend = remoteBackend(rpc, local.methods, client.close);
		infos.set(alias, info); // cached before the backend is reachable — statusOf's invariant
		backends.set(alias, backend);
		backendList.push(backend); // the live aggregate now fans out to it too
		unbinders.set(alias, bindEvents(backend));
		// A closed wire must take its backend WITH it. Nothing else drops a dead engine:
		// a call routed into one never settles (no per-call timeout), so it stayed on the
		// board, green, swallowing every request — the exact opposite of the promise that
		// "a box that's asleep or unreachable just shows as disconnected". Wire-agnostic
		// on purpose: the ws probe below only catches a HALF-open socket, while a real
		// close is all SSH ever gives us (the relay's ssh child exits).
		client.transport.onClose?.(() => {
			if (backends.get(alias) === backend) disconnect(alias);
		});
		if (wire === "ws") probes.set(alias, startHealthProbe(alias, rpc));
		broadcastConnections();
		return { mode: "remote", alias, info };
	}

	/**
	 * Keep a WebSocket honest. A half-open socket answers nothing and reports
	 * nothing, so we ask it a cheap question on a timer: one unanswered ping means
	 * the connection is gone, and we tear it down exactly as an explicit disconnect
	 * would — disposing it, dropping it from the aggregate so no call routes into a
	 * dead engine, and telling the renderer. A visible disconnect beats a board that
	 * quietly stops working.
	 */
	function startHealthProbe(alias: string, rpc: RpcClient): ReturnType<typeof setInterval> {
		const timer = setInterval(() => {
			void withTimeout(rpc.call(CH.systemHello), WS_PING_TIMEOUT_MS).catch(() => {
				if (backends.has(alias)) disconnect(alias);
			});
		}, WS_PING_INTERVAL_MS);
		// Never hold the app open just to ping a box.
		timer.unref?.();
		return timer;
	}

	function disconnect(alias: string): void {
		const backend = backends.get(alias);
		if (!backend) return; // unknown alias / already gone (null never routes here — it's not a key)
		const probe = probes.get(alias);
		if (probe) {
			clearInterval(probe);
			probes.delete(alias);
		}
		unbinders.get(alias)?.();
		unbinders.delete(alias);
		backend.dispose();
		backends.delete(alias);
		infos.delete(alias);
		const i = backendList.indexOf(backend);
		if (i >= 0) backendList.splice(i, 1);
		// Rebuild so the learned registry drops the gone engine's ids (no stale routing).
		agg = createAggregate(backendList, local);
		broadcastConnections();
	}

	function forget(alias: string): void {
		disconnect(alias); // no-op if not held; drops the live engine if it is
		forgetConnection(db, alias);
		// disconnect only broadcasts when the box was held — a never-connected row
		// changes the list too, so always tell the renderer to re-read it.
		broadcastConnections();
	}

	function origins(): Record<string, string | null> {
		// Invert the aggregate's learned id→Backend registry into id→alias for the renderer.
		const byBackend = new Map<Backend, string | null>();
		for (const [alias, b] of backends) byBackend.set(b, alias);
		const out: Record<string, string | null> = {};
		for (const [id, b] of agg.ownerOf) out[id] = byBackend.get(b) ?? null;
		return out;
	}

	async function install(dest: string, opts?: { wsAddr?: string }): Promise<HostStatus> {
		// Already set up and held — installing again would just re-run the (idempotent)
		// script for no reason; hand back its status.
		const existing = backends.get(dest);
		if (existing) return statusOf(existing, dest);

		const wsAddr = opts?.wsAddr?.trim();
		// A caller-supplied address is interpolated into a remote shell command, so it
		// must be EXACTLY a host:port endpoint — never anything that could break the pipe.
		if (wsAddr && !endpointUrl(wsAddr)) throw new Error(`"${wsAddr}" is not a host:port endpoint`);

		// Reuse install.sh verbatim. With an explicit address, bake it in; otherwise
		// derive the box's OWN tailnet IP on the box, so the phone's WebSocket listener
		// is set up automatically when the box is on Tailscale. An empty ATEAM_WS_ADDR
		// means "daemon service only, no listener" — install.sh treats it as unset.
		const pipeline = wsAddr
			? `curl -fsSL ${INSTALL_URL} | ATEAM_WS_ADDR=${wsAddr} bash -s -- --service`
			: // Single-quoted JS so the shell's ${ip:+…} parameter expansion stays literal.
				"ip=$(command -v tailscale >/dev/null 2>&1 && tailscale ip -4 2>/dev/null | head -1 || true); " +
				`curl -fsSL ${INSTALL_URL} ` +
				'| ATEAM_WS_ADDR="${ip:+$ip:' +
				WS_DEFAULT_PORT +
				'}" bash -s -- --service';

		const result = await sshExec(dest, `bash -lc '${pipeline}'`, {
			onData: (chunk) =>
				broadcast(HOST_CH.evtInstallLog, { dest, chunk } satisfies InstallLogEvent),
		});
		if (result.code !== 0) {
			throw new Error(`Setup of "${dest}" failed — ssh exited ${result.code ?? "on a signal"}.`);
		}

		// We just reached the box over SSH, so its transport is ssh — seed that row so
		// connect() resolves it even when `dest` is a user@host with no ssh_config entry.
		recordConnection(db, { hostAlias: dest, transport: "ssh" });
		return connect(dest);
	}

	// The encrypted provider-credentials store, created lazily (needs app to be ready).
	let secretsStore: ReturnType<typeof createSecretStore> | null = null;
	const secrets = () =>
		(secretsStore ??= createSecretStore(join(app.getPath("userData"), "provider-secrets.enc")));

	function secretsStatus(): SecretsStatus {
		const s = secrets().load();
		return { hetznerToken: !!s.hetznerToken, tailscaleAuthKey: !!s.tailscaleAuthKey };
	}

	function saveSecrets(patch: { hetznerToken?: string; tailscaleAuthKey?: string }): SecretsStatus {
		secrets().save(patch);
		return secretsStatus();
	}

	function providerOptions(token?: string): Promise<ProviderOptions> {
		const t = (token || secrets().load().hetznerToken || "").trim();
		if (!t) throw new Error("Enter your Hetzner API token to load regions and sizes.");
		return hetznerProvider.fetchOptions(t);
	}

	/** A DNS-label alias from a free-text box name (also the Tailscale hostname). */
	function sanitizeName(raw: string): string {
		const s = raw
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 63)
			.replace(/-+$/g, "");
		if (!s) throw new Error("Please give the box a name (letters, digits, or dashes).");
		return s;
	}

	async function createBox(spec: CreateBoxSpec): Promise<HostStatus> {
		const alias = sanitizeName(spec.name);
		const saved = secrets().load();
		const token = (spec.hetznerToken || saved.hetznerToken || "").trim();
		const tsKey = (spec.tailscaleAuthKey || saved.tailscaleAuthKey || "").trim();
		if (!token) throw new Error("A Hetzner API token is required.");
		if (!tsKey) throw new Error("A Tailscale auth key is required.");
		// Remember whatever we used, so the next box needs no re-entry.
		secrets().save({ hetznerToken: token, tailscaleAuthKey: tsKey });

		const progress = (stage: string) =>
			broadcast(HOST_CH.evtCreateProgress, { alias, stage } satisfies CreateProgressEvent);

		progress("Generating an SSH key");
		const { publicKey, privateKeyPath } = generateBoxKey(app.getPath("userData"), alias);
		const cloudInit = buildCloudInit({
			hostname: alias,
			sshPublicKey: publicKey,
			tailscaleAuthKey: tsKey,
		});

		const server = await hetznerProvider.createServer({
			token,
			name: alias,
			region: spec.region,
			size: spec.size,
			sshPublicKey: publicKey,
			cloudInit,
			onProgress: progress,
		});

		progress("Configuring SSH access");
		// The alias may be suffixed to dodge a pre-existing ~/.ssh/config entry, so use
		// what was actually written for every subsequent SSH (never the raw name).
		const boxAlias = writeSshConfigEntry(alias, server.publicIp, privateKeyPath);

		progress("Waiting for the box to boot");
		await waitForSsh(boxAlias);

		progress("Joining Tailscale");
		const onTailnet = await waitForTailscale(boxAlias);
		if (!onTailnet) {
			progress(
				"Tailscale didn't come up — installing anyway; the phone won't connect until it's fixed",
			);
		}

		// Reuse the streamed installer (Gap A): it derives the box's tailnet IP into
		// ATEAM_WS_ADDR (so the phone can connect) and connects on success.
		progress("Installing the engine");
		const status = await install(boxAlias);

		// Preinstall any requested agent CLIs (best-effort — the box is usable without
		// them, and the OAuth login is a separate step the user does after).
		for (const agentId of spec.agents ?? []) {
			progress(`Installing ${getAgent(agentId)?.label ?? agentId}`);
			try {
				await installAgent(boxAlias, agentId);
			} catch (err) {
				progress(
					`Couldn't install ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		return status;
	}

	async function installAgent(alias: string, agentId: string): Promise<InstallAgentResult> {
		const agent = getAgent(agentId);
		if (!agent?.install) throw new Error(`Don't know how to install "${agentId}".`);
		if (!backends.has(alias)) throw new Error(`Not connected to "${alias}".`);
		// Run the official installer in a login shell (PATH/profile set up), then confirm
		// the binary is on the login PATH the daemon will actually spawn it from.
		const remote = `bash -lc '${agent.install} && command -v ${agent.bin}'`;
		const result = await sshExec(alias, remote, {
			onData: (chunk) =>
				broadcast(HOST_CH.evtInstallLog, { dest: alias, chunk } satisfies InstallLogEvent),
		});
		if (result.code !== 0) {
			throw new Error(
				`Installing ${agent.label} on "${alias}" failed (exit ${result.code ?? "on a signal"}) — it may have installed but not landed on the login PATH.`,
			);
		}
		// The box's agent list now includes it — re-read the cached system:hello (it's what
		// statusOf serves) so the composer's env-agents update.
		await refreshInfo(alias);
		broadcastConnections();
		return { agentId, loginCommand: agent.loginCommand };
	}

	async function boxReadiness(alias: string): Promise<BoxReadiness> {
		if (!backends.has(alias)) throw new Error(`Not connected to "${alias}".`);
		const b64 = Buffer.from(READINESS_PROBE).toString("base64");
		let out = "";
		const r = await sshExec(alias, `echo ${b64} | base64 -d | bash -ls`, {
			onData: (chunk) => {
				out += chunk;
			},
		});
		if (r.code !== 0) {
			throw new Error(`Couldn't read "${alias}" readiness (ssh exited ${r.code ?? "on a signal"}).`);
		}
		const val = (k: string) => out.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim() ?? "";
		return {
			gh: {
				installed: val("gh_installed") === "1",
				signedIn: val("gh_signed_in") === "1",
				login: val("gh_login") || undefined,
			},
			gitName: val("git_name") || undefined,
			gitEmail: val("git_email") || undefined,
		};
	}

	async function provision(alias: string, input: { cloneUrl: string }): Promise<ProjectDTO> {
		// Provisioning targets a SPECIFIC engine — the aggregate routes by learned id,
		// but there's no id on the box yet, so call that backend's clone directly.
		await connect(alias); // idempotent if already held
		const backend = backends.get(alias);
		if (!backend) throw new Error(`Not connected to "${alias}"`);
		return backend.handle(CH.projectsClone, [input]) as Promise<ProjectDTO>;
	}

	const router: Router = {
		methods: local.methods,
		handle: (method, args) => agg.handle(method, args),
		handleFor: (ownerId, method, args) => agg.handleFor(ownerId, method, args),
		ownerKind: (ownerId) => agg.ownerKindOf(ownerId),
	};

	// Rehydrate the board on launch. A box's tasks exist for the aggregate only while
	// its engine is HELD, and a cold start holds none — which is why creating one
	// remote task made all the others appear: that connect is what put the box back
	// into the union. The `hosts` registry already remembers every box we've reached
	// (`known`), so reconnect those. Detached and in parallel: the board must never
	// wait on a box that's asleep, and each connect broadcasts its own arrival, which
	// the renderer reconciles additively — so tasks fill in as engines answer.
	for (const c of listConnections(db)) {
		if (!c.known) continue;
		void connect(c.alias).catch(() => {
			// Unreachable, asleep, or version-mismatched. connect() already closed its
			// own transport, and the connections list still renders the box from the
			// offline cache, so leaving it disconnected is the honest outcome.
		});
	}

	async function editorUrl(taskId: string): Promise<{ url: string } | { needsInstall: true }> {
		// Ask the OWNING engine to have its editor up before deciding how to reach it.
		const res = (await agg.handleFor(taskId, CH.editorOpen, [taskId])) as EditorOpenResult;
		if ("needsInstall" in res) return res;
		const ep: EditorEndpointDTO = res;
		const backend = agg.ownerOf.get(taskId);
		if (!backend || backend.kind === "local") return { url: `http://127.0.0.1:${ep.port}` };
		let alias: string | null = null;
		for (const [a, b] of backends) if (b === backend) alias = a;
		if (!alias) throw new Error("This task's box is no longer connected.");
		const ws = endpointUrl(alias);
		// A ws box is reached over the tailnet — the editor binds that same interface
		// (editorBindHost), so the alias's own host is the editor's host.
		if (ws) return { url: `http://${new URL(ws).hostname}:${ep.port}` };
		// ssh: the forward was opened at connect time against the DEFAULT port; a box
		// overriding ATEAM_EDITOR_PORT would answer somewhere the tunnel doesn't reach.
		if (ep.port !== DEFAULT_EDITOR_PORT)
			throw new Error(
				`"${alias}" runs its editor on port ${ep.port}, but the ssh forward targets ${DEFAULT_EDITOR_PORT}. Unset ATEAM_EDITOR_PORT on the box.`,
			);
		return { url: `http://127.0.0.1:${editorLocalPort(alias)}` };
	}

	return {
		router,
		list: async (): Promise<ConnectionDTO[]> => listConnections(db),
		connect,
		disconnect,
		forget,
		connected,
		origins,
		editorUrl,
		provision,
		install,
		createBox,
		installAgent,
		boxReadiness,
		secretsStatus,
		saveSecrets,
		providerOptions,
	};
}

/** Register the connection-control IPC channels against a host. Call once. */
export function registerHostIpc(host: Host): void {
	ipcMain.handle(HOST_CH.list, () => host.list());
	ipcMain.handle(HOST_CH.connect, (_e, alias: string | null) => host.connect(alias));
	ipcMain.handle(HOST_CH.disconnect, (_e, alias: string) => host.disconnect(alias));
	ipcMain.handle(HOST_CH.forget, (_e, alias: string) => host.forget(alias));
	ipcMain.handle(HOST_CH.connected, () => host.connected());
	ipcMain.handle(HOST_CH.origins, () => host.origins());
	ipcMain.handle(HOST_CH.provision, (_e, alias: string, input: { cloneUrl: string }) =>
		host.provision(alias, input),
	);
	ipcMain.handle(HOST_CH.install, (_e, dest: string, opts?: { wsAddr?: string }) =>
		host.install(dest, opts),
	);
	ipcMain.handle(HOST_CH.createBox, (_e, spec: CreateBoxSpec) => host.createBox(spec));
	ipcMain.handle(HOST_CH.installAgent, (_e, alias: string, agentId: string) =>
		host.installAgent(alias, agentId),
	);
	ipcMain.handle(HOST_CH.boxReadiness, (_e, alias: string) => host.boxReadiness(alias));
	ipcMain.handle(HOST_CH.secretsStatus, () => host.secretsStatus());
	ipcMain.handle(
		HOST_CH.saveSecrets,
		(_e, patch: { hetznerToken?: string; tailscaleAuthKey?: string }) => host.saveSecrets(patch),
	);
	ipcMain.handle(HOST_CH.providerOptions, (_e, token?: string) => host.providerOptions(token));
}
