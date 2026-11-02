# Modal (evaluated, not supported yet)

[Modal Sandboxes](https://modal.com/docs/guide/sandboxes) are containers you create from
an SDK, billed per second, with no charge once they're terminated. This page records a
spike on whether one can be an Ateam box. It isn't a setup guide: Modal isn't in the
providers table, and the steps below aren't a supported way to run Ateam.

**Verified against** Ateam engine from `main` (protocol 25) · Modal client 1.6.3 ·
2026-11-02 · rerun with [`modal-spike.py`](modal-spike.py)

**Verdict so far:** a Sandbox runs the engine and takes SSH fine. What doesn't fit is
that a sandbox lives at most 24 hours and gets a **new tunnel address every time** one is
restored, so a box would need in-tree code: something that keeps the ssh alias pointing at
the current sandbox, plus a sleep driver built on Modal's *experimental* memory snapshots.
Modal's Persistent Sandboxes (real pause/resume) would remove most of that, but they're
gated per workspace and weren't available to ours.

## What was measured

| | Result |
| --- | --- |
| Engine install | `install.sh` runs in an image build as a non-root user, and its handshake passes. Node 22 comes in through nvm. The `gh` step aborted the script ([#416](https://github.com/clawnify/ateam/issues/416)), so the spike image preinstalls `gh` |
| SSH | Run `sshd -D` as the sandbox's command and expose port 22 with `unencrypted_ports=[22]`. You get a raw TCP tunnel, `r4xx.modal.host:<port>`. sshd takes 1–5s after the tunnel appears, and the first attempt may fail with 255 |
| Engine over SSH | `ateam attach --stdio` starts both daemons and `~/.ateam/rpc.sock`, as on any box |
| Runtimes | The default is **gVisor**: kernel `4.19.0-gvisor`, no systemd, and kernel-mode `tailscaled` fails with `tstun.New("tailscale0"): operation not permitted`. Userspace-networking `tailscaled` runs. **`runtime="vm"`** has a real 7.2 kernel, a 504 GB disk and a working `/dev/net/tun`, and kernel-mode `tailscaled` starts. Neither has systemd, so `install.sh --service` has nothing to install into |
| Create time | About 0.7s once the image is cached. The first run builds the image for a few minutes |
| Lifetime | `timeout` must be between 10s and 86400s, so **24 hours at most** |
| Idle | SSH traffic alone keeps a sandbox alive: 150s of SSH-only traffic with `idle_timeout=60` and it was still up. After 90s of silence it was terminated, and **an idle-terminated sandbox is gone** unless something snapshotted it first |
| Filesystem snapshot | `snapshot_filesystem()` takes 1.7–6.3s, and a new sandbox from it starts in 0.7s. Clones, `~/.claude/.credentials.json` and `~/.ateam` (the SQLite database) survive; processes don't |
| Memory snapshot | `_experimental_enable_snapshot=True`, `_experimental_snapshot()`, `Sandbox._experimental_from_snapshot()`. Snapshot takes 2.6–3.5s on gVisor and 8.9s on vm; restore takes 0.4–0.8s. **The engine and every other process survive**, on both runtimes |
| Persistent Sandboxes | `_experimental_persistent=True` → `PermissionDeniedError: Persistent Sandboxes are not available for this workspace yet.` By the SDK source, each session lasts at most 1h and pauses after 5 min idle, with the next session starting from the previous one's exit snapshot (filesystem only) |
| Tunnel after restore | **Changes on every restore**: a new port each time, and often a new host. Seen for both filesystem and memory restores |

## What it would take

- **A stable alias.** A fixed `HostName` breaks on the first restore. A `ProxyCommand`
  helper could keep the `~/.ssh/config` entry fixed: it would look up the box's current
  sandbox through the Modal API, restore the latest snapshot if none is running, and
  pipe the connection through that sandbox's tunnel. It would also do the job of a
  `SleepCheck` and a wake adapter, since connecting is what wakes the box.
- **A sleep driver** (`packages/server/src/sleep/`). Sleeping would be a memory snapshot,
  then terminating the sandbox, and waking would be a restore. The 24-hour limit forces at
  least one cycle a day, even on a busy box.
- **A Modal token, held somewhere.** Something has to call the API to snapshot and restore.
  If the box does it itself, a token on the box reaches every sandbox in the workspace,
  which is the same problem as a boxd org key.
- All of this rests on `_experimental_` SDK calls that may change without notice.

## Open points

- [ ] **Phone over Tailscale.** Join a tailnet from a `runtime="vm"` sandbox, which has
      kernel TUN, then from gVisor with userspace networking. Connect the iOS app to the
      engine's WebSocket on `<tailnet-ip>:8787`. This needs a Tailscale auth key, and it
      needs the engine started with `ATEAM_WS_ADDR` and no systemd. Also check whether the
      node keeps its tailnet identity across a memory snapshot and restore.
- [ ] **A real agent across a snapshot.** Start a Claude task through the desktop, take a
      memory snapshot mid-turn, restore it, and check that the PTY session, the agent and
      the desktop's reconnect all survive.
- [ ] **Stable alias prototype.** Build the `ProxyCommand` helper above and check that the
      desktop reconnects through it after a restore without editing `~/.ssh/config`.
- [ ] **Cost.** What one box at 2 vCPU and 4 GB costs per day, on both runtimes, against
      Sprites and boxd. The spike didn't read the bill.
- [ ] **Persistent Sandboxes.** Ask Modal to enable them for the workspace, then run
      `modal-spike.py persistent`. Check whether the tunnel stays the same across
      pause/resume, and whether an incoming SSH connection resumes a paused sandbox or
      only an SDK call does.
- [ ] **Exit snapshots.** Try `experimental_options={"enable_exit_snapshot": True}`, so an
      idle-terminated sandbox isn't lost.
