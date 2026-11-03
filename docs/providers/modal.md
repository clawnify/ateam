# Modal (evaluated, not supported yet)

[Modal Sandboxes](https://modal.com/docs/guide/sandboxes) are containers you create from
an SDK, billed per second, with no charge once they're terminated. This page records a
spike on whether one can be an Ateam box. It isn't a setup guide: Modal isn't in the
providers table, and the steps below aren't a supported way to run Ateam.

**Verified against** Ateam engine release 0.1.80 (protocol 25) · Modal client 1.6.3 ·
Claude Code 2.1.316 and 2.1.317 · 2026-11-02 and 2026-11-03 · rerun with
[`modal-spike.py`](modal-spike.py); the stable-alias prototype is [`modal_box.py`](modal_box.py),
and the control app [`modal_control.py`](modal_control.py)

**Verdict:** a Sandbox can be a box, but it isn't worth an in-tree integration yet. The
engine runs, SSH and the phone's WebSocket work, and a memory snapshot keeps the engine,
its terminals and an agent in the middle of its turn running: the turn finished after the
restore, and the desktop and the phone came back. A prototype gives a box one ssh alias for
its whole life, sleeping on a snapshot and waking when you connect, and a small app in the
user's own Modal workspace can do the sleeping and waking, so the Modal token never leaves
Modal. Against that:

- Every piece rests on `_experimental_` SDK calls.
- Memory snapshots expire 7 days after the first one in a chain, so a box has to restart
  cold at least once a week.
- A box can have memory snapshots or exit snapshots, not both. Anything that ends it
  unplanned, such as a timeout or the workspace's spend limit, loses everything since its
  last snapshot.
- Over SSH nothing can become root, and processes started through Modal's `exec` don't
  survive a snapshot (both seen on gVisor).
- sshd is open to the whole internet: Modal's inbound allowlist doesn't cover the raw TCP
  tunnel it sits behind.
- A box with memory snapshots can't pin its region. One landed in `us-east`, about twice
  as far per keystroke from Europe as a box pinned to `eu`, which in turn can't take memory
  snapshots and costs 1.15 times as much.
- The control app is code Ateam would ship and keep working in every user's workspace.
- CPU costs about 3.7 times what Sprites charges, and Modal bills at least what a box
  requests, whatever it uses: an idle box left awake costs $1.00 a day at the smallest
  sizing tried.

Persistent Sandboxes, still gated for this workspace, wouldn't change that much. By the
SDK source, a persistent Sandbox is a chain of sessions of at most an hour each (5 minutes
idle), and each session starts from the previous one's filesystem. So the engine and any
agent would restart at least hourly. They would replace the snapshot bookkeeping, not the
need to keep processes alive.

**Decided 2026-11-03: not supported for now.** Revisit when Modal makes memory snapshots
stable (not `_experimental_`) with longer retention, or offers a sandbox that keeps its
processes and its address across a pause, without the 24-hour cap. Until then this page and
its scripts stay as a record and a starting point.

## What was measured

| | Result |
| --- | --- |
| Engine install | `install.sh` runs in an image build as a non-root user, and its handshake passes. Node 22 comes in through nvm. The `gh` step aborted the script ([#416](https://github.com/clawnify/ateam/issues/416), fixed since by [#424](https://github.com/clawnify/ateam/pull/424)), so the spike image preinstalls `gh` |
| SSH | Run `sshd -D` as the sandbox's command and expose port 22 with `unencrypted_ports=[22]`. You get a raw TCP tunnel, `r4xx.modal.host:<port>`. sshd takes 1–5s after the tunnel appears, and the first attempt may fail with 255 |
| Engine over SSH | `ateam attach --stdio` starts both daemons and `~/.ateam/rpc.sock`, as on any box |
| Runtimes | The default is **gVisor**: kernel `4.19.0-gvisor`, no systemd, and kernel-mode `tailscaled` fails with `tstun.New("tailscale0"): operation not permitted`. **`runtime="vm"`** has a real 7.2 kernel, a 504 GB disk and a working `/dev/net/tun`. Neither has systemd, so `install.sh --service` has nothing to install into |
| Root | The sandbox's own command and Modal's `exec` run as root. Over SSH, `sudo` fails: `The "no new privileges" flag is set, which prevents sudo from running as root` (seen on gVisor, not tried on vm) |
| Create time | About 0.7s once the image is cached. The first run builds the image for a few minutes |
| Lifetime | `timeout` must be between 10s and 86400s, so **24 hours at most**. A memory restore restarts that clock, on gVisor and on vm alike: with `timeout=120` and a snapshot at 60s, the restored sandbox ran another 123s on both |
| Idle | SSH traffic alone keeps a sandbox alive: 150s of SSH-only traffic with `idle_timeout=60` and it was still up. After 90s of silence it was terminated, and **an idle-terminated sandbox is gone** unless something snapshotted it first |
| Filesystem snapshot | `snapshot_filesystem()` takes 1.1–6.3s, doesn't stop the sandbox, and a new sandbox from it starts in 0.7s. Clones, `~/.claude/.credentials.json` and `~/.ateam` (the SQLite database) survive, but processes don't. Kept 30 days by default, configurable up to no expiry |
| Memory snapshot | `_experimental_enable_snapshot=True`, `_experimental_snapshot()`, `Sandbox._experimental_from_snapshot()`. A snapshot takes 1.4–8.3s on gVisor and 8.9–11.6s on vm, and ends the sandbox. A restore takes 0.2–0.8s, and the restored sandbox keeps its name. **The engine, its PTY sessions and anything started over SSH survive**. Per [Modal's docs](https://modal.com/docs/guide/sandbox-snapshots), a memory snapshot expires 7 days after the first snapshot in its chain, can't be extended, and is restored only on the same instance type. Background processes started through `exec` aren't restored: `tailscaled` started that way was gone after a restore on gVisor |
| Exit snapshot | With `experimental_options={"enable_exit_snapshot": True}`, a sandbox that idled out left a filesystem snapshot 0.1s after it ended, with the credentials and `~/.ateam` in it. Modal refuses it together with memory snapshots: `InvalidError: Memory snapshots do not support exit snapshots` |
| Persistent Sandboxes | `_experimental_persistent=True` → `PermissionDeniedError: Persistent Sandboxes are not available for this workspace yet.`, still on 2026-11-03. By the SDK source (`sandbox/_impl_persistent.py`), each session lasts at most 1h and pauses after 5 min idle, with the next session starting from the previous one's exit snapshot (filesystem only), so processes don't survive a pause |
| Tunnel after restore | **Changes on every restore**: a new port each time, and often a new host. Seen for both filesystem and memory restores. The host keys don't change |
| Stable alias | [`modal_box.py`](modal_box.py) as a `ProxyCommand` passed all 11 checks of `modal-spike.py alias`. A connect to an awake box handshakes in 2.1–2.9s, since the helper starts Python and looks the tunnel up through Modal's API each time. Sleep takes a filesystem snapshot (1.1–2.7s), then a memory snapshot (1.9–4.2s). A connect to a sleeping box restores it in 1.5–1.9s and handshakes in 2.9–3.3s. Two connects at once still wake one sandbox. The tunnel changed, but the alias, the host key and the engine's PIDs didn't. Once the memory chain is too old, the box wakes cold from the filesystem snapshot in 2.2–2.5s, keeping files and losing processes, and the next sleep starts a new chain |
| Tailscale | Both runtimes join a tailnet with a login link: kernel TUN on vm, userspace networking on gVisor. On vm the engine binds `<tailnet-ip>:8787`. In userspace mode the tailnet address isn't on any interface, so the engine binds `127.0.0.1:8787` and `tailscaled` hands inbound connections to it. From a laptop on the tailnet, `system:hello` over the WebSocket answered in 0.41s (vm) and 0.18s (gVisor), both relayed through DERP |
| Tailscale across a snapshot | Started over SSH as the box user (userspace mode), `tailscaled` kept its node, its address and its node ID across a memory snapshot, twice on gVisor. Started through `exec`, it didn't survive on gVisor. On vm, the `exec`-started one still reported Running on the same node from inside after a restore, but the laptop saw the node offline a minute later. Not settled |
| Desktop by tailnet address | The desktop connects to a `host:port` box over the WebSocket. Connected that way, it cloned a public repo onto the box, created a task and launched Claude Code. After a mid-turn snapshot it marked the box offline, then reconnected by itself within seconds of the restore: 17s offline in all with a 20s gap between snapshot and restore, and 41s with a 30s gap and an 8.3s snapshot |
| Agent across a snapshot | Claude Code 2.1.316 on gVisor. A sign-in half done (the login URL showing, its state only in memory) survived a snapshot, and finished after the restore. Mid-turn, with a Bash tool call running a 2-minute loop: the snapshot took 5.3s and the restore 0.3s, 20s later. The loop kept ticking and the turn's timer kept counting. In a second run (Claude Code 2.1.317, an 8.3s snapshot, a 30s gap) the turn finished after the restore: Claude's next API call went through, and its answer pointed out the 40-second stall between two ticks |
| Phone | Ateam Go on an iPhone connected to the engine's WebSocket over the tailnet, and the engine counted two clients, the desktop and the phone. Two minutes after a restore only the desktop was back; the phone was connected again when checked in the app |
| Control app | [`modal_control.py`](modal_control.py), deployed in the workspace, passed all 8 checks of `modal-spike.py control`. Its functions slept a box in 5.3–7.2s and woke it in 2.8–4.9s, answering once sshd did, with the box's processes intact; both include the function's cold start. Through its private endpoints with a Proxy Token, sleep took 7.0s, and an ssh alias whose `ProxyCommand` is only `curl` and `nc` woke the box and handshook in 5.7s, or 1.7s when it was awake. A call without the token got HTTP 401, and the Proxy Token was refused as an API token (`AuthError: Token ID is malformed`) |
| Inbound allowlist | `inbound_cidr_allowlist` doesn't guard the raw TCP tunnel: a sandbox that allowed only 192.0.2.1/32 still let ssh in from elsewhere. sshd faces the whole internet, behind its key-only login |
| Placement and latency | A sandbox with memory snapshots can't pin a region. One landed in `us-east` (its `MODAL_REGION`), and the tailnet test boxes relayed through New York, Frankfurt and Seattle. Pinned to `eu`, a sandbox ran in `eu-west`, but it can't take memory snapshots and bills 1.15 times as much (1.75 for a narrow region such as `eu-west`). From a laptop in Europe, connecting took 121 ms to `us-east` and 57 ms to `eu-west`. From a second machine, keystroke round trips over ssh were 92 ms and 42 ms |
| Volumes | On a Modal Volume, `git status` in a 7,872-file checkout took 0.47s, against 0.018s on the box's own disk, about 26 times as long, and a shallow clone 0.84s against 0.44s. Checkouts belong on the box's disk |
| Spend limit | When the workspace reached its spend limit, the sandboxes that were running stopped, as [Modal's budgets guide](https://modal.com/docs/guide/budgets) says they do: "Modal stops workloads that would incur additional out-of-pocket charges". Every create and restore then failed with `ResourceExhaustedError: Workspace … has exceeded its spend limit`. The spike's own test boxes, held at 2 vCPU and 4 GiB, had used up the workspace's credit |

## Cost

Rates from `modal billing rates` (2026-11-03): Sandbox CPU **$0.1419 per core-hour** and
Sandbox memory **$0.024 per GiB-hour**, three times Modal's Function rates. Modal bills the
larger of what a sandbox requests and what it uses, with a minimum of 0.125 core. The bill
agreed: the app that held the alias and agent test boxes, about half an hour at 2 vCPU and 4 GiB
in all, cost $0.197.

| Box | Awake, per hour | Awake, per day | Asleep |
| --- | --- | --- | --- |
| Modal, 2 vCPU / 4 GiB requested | $0.38 | $9.12 (≈ $274 for 30 days) | no compute. Snapshot storage isn't on the pricing page |
| Modal, 0.125 vCPU / 1 GiB requested, 2 / 4 GiB limit | $0.042 idle (measured), plus any use above the request | $1.00 idle (≈ $30 for 30 days) | same |
| [Sprites](https://fly.io/sprites) | CPU used at $0.0385 per CPU-hour, memory used at $0.021875 per GB-hour | depends on use. Their example: $0.23 for a 4-hour Claude Code session | storage only |
| [boxd](boxd.md) | about €61 a month for 2 vCPU left running | about €2 | disk only |

So per core-hour, Modal's CPU costs about 3.7 times Sprites', and memory costs about the
same. A box on Modal should request the minimum and set a limit, since a fixed 2 vCPU
bills 2 vCPU all day. The `cost` phase kept an idle box awake, its engine running, for an
hour at each sizing, each in its own app, since the bill groups costs by app and hour, not
by sandbox tag. Each was billed exactly its request for the time it ran: $0.386 for 61
minutes at 2 vCPU and 4 GiB, and $0.042 for about an hour at 0.125 vCPU and 1 GiB, on
gVisor and on vm alike. So an idle box stays under the smaller request on both runtimes
and costs $1.00 a day: one box left awake uses about all of the Starter plan's $30 of
monthly credit. On vm the box had used 281 MiB and 1.6 CPU-seconds in that hour, so a
smaller memory request might hold too (not tried). gVisor has no cgroup files, and its
`free` reports the limit or the host's memory, so there the bill is the only reading.

## What it would take

- **`tailscaled` where a snapshot keeps it.** Start it from the sandbox's own command, or
  over SSH as the box user in userspace mode as the `tailscale` phase does, never through
  `exec`. Kernel mode needs root, which only the sandbox's command has. It also needs its
  state on disk as a regular node: an ephemeral node is removed 30–60 minutes after it goes
  offline, so it wouldn't outlive a night's sleep.
- **The stable alias**, as `modal_box.py` prototypes. The `~/.ssh/config` entry is fixed,
  with `HostKeyAlias`. Its `ProxyCommand` finds the box's sandbox by name, restores the
  memory snapshot, or wakes cold from the filesystem snapshot once the chain is near 7
  days, then pipes the connection through. The desktop's `SleepCheck` would ask the same
  record whether a box sleeps. Otherwise every launch of the desktop wakes every Modal box.
- **A sleep driver** (`packages/server/src/sleep/`) that runs `modal_box.py sleep`'s
  steps. A Modal token on the box would reach every sandbox in the workspace, which is the
  same problem as a boxd org key. The app below keeps that token inside Modal, so the box
  would only hold a Proxy Token for the app's endpoints.
- **A daily cycle for a busy box.** A snapshot and restore restarts the 24-hour clock, at
  the cost of one dropped connection.
- **Something about sshd.** The inbound allowlist doesn't cover the raw TCP tunnel, so either
  sshd's key-only login keeps facing the internet, or the box drops its public tunnel and is
  reached only over the tailnet, where the desktop already connects by WebSocket.
- **A weekly cold restart**, when the memory snapshot chain runs out. That restarts the
  engine and ends any agent that is running.
- **A small app in the user's own Modal workspace**, as [`modal_control.py`](modal_control.py)
  prototypes, holding the Modal token so nothing else does. Its private web endpoints,
  guarded by a [Proxy Token](https://modal.com/docs/guide/webhook-proxy-auth), wake a box
  and return its tunnel, or put it to sleep. The phone's wake adapter
  (`packages/protocol/src/wake.ts`) then makes one HTTPS call with a bearer token, like the
  providers woken with a single REST call, and the `ProxyCommand` is `curl` and `nc`. A
  scheduled function could run the daily cycle. A Proxy Token opens every protected endpoint
  in its workspace (or, with RBAC, its environment), so the endpoints would also have to
  check which box a caller may touch. Ateam would ship this app and keep it working in
  every user's workspace.
- All of this rests on `_experimental_` SDK calls that may change without notice.

## How the agent and phone tests were run

`modal-spike.py tailscale` creates the box, starts `tailscaled` over SSH as the box user in
userspace mode (through `exec` it doesn't survive a snapshot), prints a Tailscale login link
and waits. Run it from a laptop on the tailnet: a node whose `tailscaled` runs in userspace
mode can't open sockets to tailnet addresses, so the phase's own WebSocket check fails
there. While it waits:

1. Install Claude Code on the box over SSH (`curl -fsSL https://claude.ai/install.sh | bash`).
2. In the desktop, connect to `<tailnet-ip>:8787`. A `host:port` connection is a WebSocket.
   Add a public repository to the box, start a task, and sign Claude in from its terminal.
3. Connect the phone to the same address.
4. Give Claude a long command, and partway through `touch` the flag the phase names. It
   takes the memory snapshot, waits 30s, restores the box and waits again, for a look at
   the phone. `modal-spike.py snapshot --sandbox <id> --gap 20` does the same to any
   sandbox.

## Open points

- [x] **Phone over Tailscale**, including Ateam Go itself, across a snapshot.
- [x] **Stable alias prototype.** `modal_box.py`, 11 of 11 checks.
- [x] **The end of an agent's turn after a mid-turn restore.** It finished.
- [x] **A restore on vm.** It restarts the `timeout` clock there too.
- [x] **The app in the user's workspace.** `modal_control.py`, 8 of 8 checks.
- [x] **Exit snapshots.** They work, but not together with memory snapshots.
- [x] **Volumes, who can reach sshd, latency.** See the table above.
- [x] **What an idle box uses.** Nothing above its request, on either runtime: $1.00 a day
      at 0.125 vCPU and 1 GiB.
- [ ] **The desktop through the alias.** On the test laptop, `~/.ssh/config` was rewritten
      from an older copy within a minute each time the alias was added, so the desktop's
      reconnect was shown over the tailnet address instead. `modal-spike.py alias` and
      `control` do what the desktop's SSH transport does on every connect.
- [ ] **`tailscaled` over SSH on vm**, across a snapshot. Only gVisor was run that way.
- [ ] **Persistent Sandboxes.** Still gated on 2026-11-03. Ask Modal to enable them, then run
      `modal-spike.py persistent`. Check the hourly session limit in practice, whether the
      tunnel stays the same across pause and resume, and whether an incoming SSH connection
      resumes a paused sandbox.

Running the spike needs a Modal token (`modal token new`) and a workspace with credit: the
spend limit stops every phase, including restores. Check `modal billing summary` before a
long phase. The Starter plan's $30 of monthly compute needs a payment method on file
([Modal's billing guide](https://modal.com/docs/guide/billing)).
