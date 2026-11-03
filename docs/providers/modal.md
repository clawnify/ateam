# Modal (evaluated, not supported yet)

[Modal Sandboxes](https://modal.com/docs/guide/sandboxes) are containers you create from
an SDK, billed per second, with no charge once they're terminated. This page records a
spike on whether one can be an Ateam box. It isn't a setup guide: Modal isn't in the
providers table, and the steps below aren't a supported way to run Ateam.

**Verified against** Ateam engine release 0.1.80 (protocol 25) · Modal client 1.6.3 ·
Claude Code 2.1.316 · 2026-11-02 and 2026-11-03 · rerun with [`modal-spike.py`](modal-spike.py);
the stable-alias prototype is [`modal_box.py`](modal_box.py)

**Verdict:** a Sandbox can be a box, but it isn't worth an in-tree integration yet. The
engine runs, SSH and the phone's WebSocket work, and a memory snapshot keeps the engine,
its terminals and an agent in the middle of a command running. A prototype gives a box
one ssh alias for its whole life, sleeping on a snapshot and waking when you connect.
Against that:

- Every piece rests on `_experimental_` SDK calls.
- Memory snapshots expire 7 days after the first one in a chain, so a box has to restart
  cold at least once a week.
- A box can have memory snapshots or exit snapshots, not both. Anything that ends it
  unplanned, such as a timeout or the workspace's spend limit, loses everything since its
  last snapshot.
- Over SSH nothing can become root, and processes started through Modal's `exec` don't
  survive a snapshot (both seen on gVisor).
- The phone could only wake a box through Modal's gRPC SDKs.
- CPU costs about 3.7 times what Sprites charges, and Modal bills at least what a box
  requests, whatever it uses.

Persistent Sandboxes, still gated for this workspace, wouldn't change that much. By the
SDK source, a persistent Sandbox is a chain of sessions of at most an hour each (5 minutes
idle), and each session starts from the previous one's filesystem. So the engine and any
agent would restart at least hourly. They would replace the snapshot bookkeeping, not the
need to keep processes alive.

## What was measured

| | Result |
| --- | --- |
| Engine install | `install.sh` runs in an image build as a non-root user, and its handshake passes. Node 22 comes in through nvm. The `gh` step aborted the script ([#416](https://github.com/clawnify/ateam/issues/416)), so the spike image preinstalls `gh` |
| SSH | Run `sshd -D` as the sandbox's command and expose port 22 with `unencrypted_ports=[22]`. You get a raw TCP tunnel, `r4xx.modal.host:<port>`. sshd takes 1–5s after the tunnel appears, and the first attempt may fail with 255 |
| Engine over SSH | `ateam attach --stdio` starts both daemons and `~/.ateam/rpc.sock`, as on any box |
| Runtimes | The default is **gVisor**: kernel `4.19.0-gvisor`, no systemd, and kernel-mode `tailscaled` fails with `tstun.New("tailscale0"): operation not permitted`. **`runtime="vm"`** has a real 7.2 kernel, a 504 GB disk and a working `/dev/net/tun`. Neither has systemd, so `install.sh --service` has nothing to install into |
| Root | The sandbox's own command and Modal's `exec` run as root. Over SSH, `sudo` fails: `The "no new privileges" flag is set, which prevents sudo from running as root` (seen on gVisor, not tried on vm) |
| Create time | About 0.7s once the image is cached. The first run builds the image for a few minutes |
| Lifetime | `timeout` must be between 10s and 86400s, so **24 hours at most**. A memory restore restarts that clock on gVisor: with `timeout=120` and a snapshot at 60s, the restored sandbox ran another 123s. Not measured on vm |
| Idle | SSH traffic alone keeps a sandbox alive: 150s of SSH-only traffic with `idle_timeout=60` and it was still up. After 90s of silence it was terminated, and **an idle-terminated sandbox is gone** unless something snapshotted it first |
| Filesystem snapshot | `snapshot_filesystem()` takes 1.1–6.3s, doesn't stop the sandbox, and a new sandbox from it starts in 0.7s. Clones, `~/.claude/.credentials.json` and `~/.ateam` (the SQLite database) survive, but processes don't. Kept 30 days by default, configurable up to no expiry |
| Memory snapshot | `_experimental_enable_snapshot=True`, `_experimental_snapshot()`, `Sandbox._experimental_from_snapshot()`. A snapshot takes 1.9–5.3s on gVisor and 8.9–11.6s on vm, and ends the sandbox. A restore takes 0.2–0.8s, and the restored sandbox keeps its name. **The engine, its PTY sessions and anything started over SSH survive**. Per [Modal's docs](https://modal.com/docs/guide/sandbox-snapshots), a memory snapshot expires 7 days after the first snapshot in its chain, can't be extended, and is restored only on the same instance type. Background processes started through `exec` aren't restored: `tailscaled` started that way was gone after a restore on gVisor |
| Exit snapshot | With `experimental_options={"enable_exit_snapshot": True}`, a sandbox that idled out left a filesystem snapshot 0.1s after it ended, with the credentials and `~/.ateam` in it. Modal refuses it together with memory snapshots: `InvalidError: Memory snapshots do not support exit snapshots` |
| Persistent Sandboxes | `_experimental_persistent=True` → `PermissionDeniedError: Persistent Sandboxes are not available for this workspace yet.`, still on 2026-11-03. By the SDK source (`sandbox/_impl_persistent.py`), each session lasts at most 1h and pauses after 5 min idle, with the next session starting from the previous one's exit snapshot (filesystem only), so processes don't survive a pause |
| Tunnel after restore | **Changes on every restore**: a new port each time, and often a new host. Seen for both filesystem and memory restores. The host keys don't change |
| Stable alias | [`modal_box.py`](modal_box.py) as a `ProxyCommand` passed all 11 checks of `modal-spike.py alias`. A connect to an awake box handshakes in 2.1–2.9s, since the helper starts Python and looks the tunnel up through Modal's API each time. Sleep takes a filesystem snapshot (1.1–2.7s), then a memory snapshot (1.9–4.2s). A connect to a sleeping box restores it in 1.5–1.9s and handshakes in 2.9–3.3s. Two connects at once still wake one sandbox. The tunnel changed, but the alias, the host key and the engine's PIDs didn't. Once the memory chain is too old, the box wakes cold from the filesystem snapshot in 2.2–2.5s, keeping files and losing processes, and the next sleep starts a new chain |
| Tailscale | Both runtimes join a tailnet with a login link: kernel TUN on vm, userspace networking on gVisor. On vm the engine binds `<tailnet-ip>:8787`. In userspace mode the tailnet address isn't on any interface, so the engine binds `127.0.0.1:8787` and `tailscaled` hands inbound connections to it. From a laptop on the tailnet, `system:hello` over the WebSocket answered in 0.41s (vm) and 0.18s (gVisor), both relayed through DERP |
| Tailscale across a snapshot | Started over SSH as the box user (userspace mode), `tailscaled` kept its node and address across a memory snapshot. Started through `exec`, it didn't survive on gVisor. On vm, the `exec`-started one still reported Running on the same node from inside after a restore, but the laptop saw the node offline a minute later. Not settled |
| Desktop by tailnet address | The desktop connects to a `host:port` box over the WebSocket. Connected that way, it cloned a public repo onto the box, created a task and launched Claude Code. After a mid-turn snapshot it marked the box offline, then reconnected by itself within seconds of the restore (17s offline in all, with a 20s gap between snapshot and restore) |
| Agent across a snapshot | Claude Code 2.1.316 on gVisor. A sign-in half done (the login URL showing, its state only in memory) survived a snapshot, and finished after the restore. Mid-turn, with a Bash tool call running a 2-minute loop: the snapshot took 5.3s and the restore 0.3s, 20s later. The loop kept ticking and the turn's timer kept counting. The end of the turn, Claude's next API call, wasn't read before the sandbox stopped at the spend limit |
| Spend limit | The workspace had $1.00 of credit for the month and allowed no spend beyond it. When the spike reached it (about 00:05 UTC on 2026-11-03, $1.02 metered in all), the sandboxes that were running stopped, and every create and restore failed with `ResourceExhaustedError: Workspace … has exceeded its spend limit` |

## Cost

Rates from `modal billing rates` (2026-11-03): Sandbox CPU **$0.1419 per core-hour** and
Sandbox memory **$0.024 per GiB-hour**, three times Modal's Function rates. Modal bills the
larger of what a sandbox requests and what it uses, with a minimum of 0.125 core. The bill
agreed: the app that held the alias and agent test boxes, about half an hour at 2 vCPU and 4 GiB
in all, cost $0.197.

| Box | Awake, per hour | Awake, per day | Asleep |
| --- | --- | --- | --- |
| Modal, 2 vCPU / 4 GiB requested | $0.38 | $9.12 (≈ $274 for 30 days) | no compute. Snapshot storage isn't on the pricing page |
| Modal, 0.125 vCPU / 1 GiB requested, 2 / 4 GiB limit | $0.042, plus anything used above the request | $1.00, plus use | same |
| [Sprites](https://fly.io/sprites) | CPU used at $0.0385 per CPU-hour, memory used at $0.021875 per GB-hour | depends on use. Their example: $0.23 for a 4-hour Claude Code session | storage only |
| [boxd](boxd.md) | about €61 a month for 2 vCPU left running | about €2 | disk only |

So per core-hour, Modal's CPU costs about 3.7 times Sprites', and memory costs about the
same. A box on Modal should request the minimum and set a limit, since a fixed 2 vCPU
bills 2 vCPU all day. The bill groups costs by app and hour, not by sandbox tag, so the
`cost` phase now gives each sizing its own app. It hasn't been rerun since that change, so
what an idle box uses above the minimum request is still unmeasured.

## What it would take

- **A box command that starts everything.** `sshd` and `tailscaled` would have to start
  from the sandbox's own command, which is the only place that runs as root and keeps its
  processes across a snapshot. `tailscaled` needs its state on disk as a regular node: an
  ephemeral node is removed 30–60 minutes after it goes offline, so it wouldn't outlive a
  night's sleep.
- **The stable alias**, as `modal_box.py` prototypes. The `~/.ssh/config` entry is fixed,
  with `HostKeyAlias`. Its `ProxyCommand` finds the box's sandbox by name, restores the
  memory snapshot, or wakes cold from the filesystem snapshot once the chain is near 7
  days, then pipes the connection through. The desktop's `SleepCheck` would ask the same
  record whether a box sleeps. Otherwise every launch of the desktop wakes every Modal box.
- **A sleep driver** (`packages/server/src/sleep/`) that runs `modal_box.py sleep`'s
  steps. Something has to hold a Modal token to call them. A token on the box reaches every
  sandbox in the workspace, which is the same problem as a boxd org key. A scheduled
  function in the user's own Modal workspace could do it instead (untested).
- **A daily cycle for a busy box.** A snapshot and restore restarts the 24-hour clock on
  gVisor, at the cost of one dropped connection.
- **A weekly cold restart**, when the memory snapshot chain runs out. That restarts the
  engine and ends any agent that is running.
- **A wake adapter for the phone** (`packages/protocol/src/wake.ts`). Modal exposes
  sandboxes through its SDKs (Python, JavaScript, Go), which speak gRPC. There is no single
  REST call to make, as with the other providers. Whether the JavaScript SDK runs in React
  Native is unchecked.
- All of this rests on `_experimental_` SDK calls that may change without notice.

## How the agent and phone tests were run

`modal-spike.py tailscale` creates the box, prints a Tailscale login link and waits. Run it
from a laptop on the tailnet: a node whose `tailscaled` runs in userspace mode can't open
sockets to tailnet addresses, so the WebSocket check fails there. While it waits:

1. Install Claude Code on the box over SSH (`curl -fsSL https://claude.ai/install.sh | bash`).
2. In the desktop, connect to `<tailnet-ip>:8787`. A `host:port` connection is a WebSocket.
   Add a public repository to the box, start a task, and sign Claude in from its terminal.
3. Give Claude a long command, and in the middle of it run
   `modal-spike.py snapshot --sandbox <id> --gap 20`.

The phase starts `tailscaled` through `exec`, so on gVisor the node won't come back after
that snapshot. Start it over SSH as the box user instead:
`/usr/sbin/tailscaled --state=mem: --tun=userspace-networking --statedir=$HOME/.ts --socket=$HOME/.ts/tailscaled.sock`,
then `tailscale --socket=$HOME/.ts/tailscaled.sock up`.

## Open points

- [x] **Phone over Tailscale.** Reachable on both runtimes; see Tailscale above.
- [x] **Stable alias prototype.** `modal_box.py`, 11 of 11 checks.
- [x] **Cost.** See Cost above.
- [x] **Exit snapshots.** They work, but not together with memory snapshots.
- [ ] **The end of an agent's turn after a mid-turn restore.** Everything up to Claude's
      next API call was seen. Rerun the agent test and read the turn to its end.
- [ ] **The desktop through the alias.** On the test laptop, `~/.ssh/config` was rewritten
      from an older copy within a minute each time the alias was added, so the desktop's
      reconnect was shown over the tailnet address instead. `modal-spike.py alias` does what
      the desktop's SSH transport does on every connect.
- [ ] **The phone app itself.** The WebSocket check makes the app's first call, but Ateam
      Go never connected: the simulator build on the test laptop is a Debug build that
      needs a Metro server.
- [ ] **A restore on vm.** Does it restart the `timeout` clock (`restore-clock --runtime vm`),
      and does a `tailscaled` started from the box's own command keep its node across it?
- [ ] **What an idle box uses** above the minimum request (`cost`, one app per sizing).
- [ ] **Persistent Sandboxes.** Still gated on 2026-11-03. Ask Modal to enable them, then run
      `modal-spike.py persistent`. Check the hourly session limit in practice, whether the
      tunnel stays the same across pause and resume, and whether an incoming SSH connection
      resumes a paused sandbox.
- [ ] **Who holds the Modal token** for the sleep driver: the box, or a scheduled function
      in the user's workspace.

Running the spike needs a Modal token (`modal token new`) and a workspace with credit: the
spend limit stops every phase, including restores.
