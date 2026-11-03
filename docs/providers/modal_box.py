"""A Modal Sandbox behind one ssh alias that never changes. The prototype behind docs/providers/modal.md.

A box is a Sandbox named after it in the Modal app `ateam-boxes`. Sleeping takes a filesystem snapshot
and then a memory snapshot (which ends the sandbox), and records both in the Modal Dict `ateam-boxes`.
Connecting through the alias wakes the box: it restores the memory snapshot, or, once that has expired,
starts a new sandbox from the filesystem snapshot. Either way the tunnel address is looked up on each
connect, so `~/.ssh/config` is written once:

    Host modal-<box>
      User ateam
      HostKeyAlias modal-<box>
      ProxyCommand uv run -q --with modal==1.6.3 python /path/to/modal_box.py proxy <box>

    modal_box.py create <box> [--runtime vm]   build the image and start the box
    modal_box.py proxy <box>                    the ProxyCommand: wake the box if it sleeps, then pipe stdio to its sshd
    modal_box.py sleep <box>                    snapshot it, record the snapshots, end the sandbox
    modal_box.py status <box>
    modal_box.py destroy <box>                  end the sandbox and forget the snapshots

The image authorizes MODAL_BOX_KEY.pub (default ~/.ssh/id_ed25519.pub), plus every key in the file
MODAL_BOX_AUTHORIZED if that is set. Nothing here runs unless something calls `sleep`: deciding when
is the engine's job (packages/server/src/sleep/control.ts), and this prototype has no driver for it.
The box's command starts only sshd. For the phone, tailscaled has to start where a snapshot keeps it:
from the box's command, or over SSH as the box user in userspace mode, never through Modal's exec (see
modal.md). The SDK is pinned because the calls this makes are `_experimental_` and may change in any release.
"""

import argparse
import os
import socket
import sys
import threading
import time

import modal

APP_NAME = "ateam-boxes"
INSTALL = "https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install.sh"
SSHD = ["/bin/sh", "-c", "mkdir -p /run/sshd && exec /usr/sbin/sshd -D -e"]
# The minimum request, allowed to burst to 2 vCPU and 4 GiB: Modal bills the larger of what a sandbox
# requests and what it uses, so a fixed 2 vCPU bills 2 vCPU all day. An idle box stays under this request on
# both runtimes, $1.00 a day (the `cost` phase). The control, tailscale and vm restore-clock runs used this
# sizing; the earlier snapshot timings in modal.md were at a fixed 2 vCPU / 4 GiB.
SIZE = {"cpu": (0.125, 2), "memory": (1024, 4096)}
LIFETIME = 24 * 3600  # Modal's cap on `timeout`
# A memory snapshot expires 7 days after the first one in its chain, and a snapshot of a restored
# sandbox keeps that date. Wake cold (from the filesystem snapshot) a little before that.
CHAIN_MAX = 6.5 * 24 * 3600
KEY = os.environ.get("MODAL_BOX_KEY") or os.path.expanduser("~/.ssh/id_ed25519")


def log(msg: str) -> None:
    print(f"[modal_box] {msg}", file=sys.stderr, flush=True)


def app() -> modal.App:
    return modal.App.lookup(APP_NAME, create_if_missing=True)


def state() -> modal.Dict:
    return modal.Dict.from_name(APP_NAME, create_if_missing=True)


def build_image() -> modal.Image:
    keys = [open(KEY + ".pub").read().strip()]
    extra = os.environ.get("MODAL_BOX_AUTHORIZED")
    if extra:
        keys += [k.strip() for k in open(extra) if k.strip()]
    authorized = "\\n".join(keys)
    return (
        modal.Image.debian_slim(python_version="3.12")
        .apt_install("openssh-server", "git", "curl", "ca-certificates", "sudo", "procps", "iproute2", "gnupg")
        .run_commands(
            "useradd -m -s /bin/bash ateam",
            "echo 'ateam ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/ateam",
            "mkdir -p /home/ateam/.ssh /run/sshd",
            f"printf '{authorized}\\n' > /home/ateam/.ssh/authorized_keys",
            "chown -R ateam:ateam /home/ateam/.ssh && chmod 700 /home/ateam/.ssh "
            "&& chmod 600 /home/ateam/.ssh/authorized_keys",
            "ssh-keygen -A",
            "sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config",
            # gh preinstalled, so install.sh skips its own gh step, which aborted it before #424 (#416).
            "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/gh.gpg",
            "echo 'deb [signed-by=/usr/share/keyrings/gh.gpg] https://cli.github.com/packages stable main' "
            "> /etc/apt/sources.list.d/gh.list",
            "apt-get update -q && apt-get install -yq gh",
            "curl -fsSL https://tailscale.com/install.sh | sh",
            # The engine, the documented way, as the user that owns the agents.
            f"su - ateam -c 'curl -fsSL {INSTALL} | bash'",
        )
    )


def running(box: str) -> modal.Sandbox | None:
    try:
        sb = modal.Sandbox.from_name(APP_NAME, box)
    except modal.exception.NotFoundError:
        return None
    return sb if sb.poll() is None else None


def create(box: str, runtime: str | None = None, image: modal.Image | None = None) -> modal.Sandbox:
    if running(box):
        raise SystemExit(f"{box} is already running")
    sb = modal.Sandbox.create(*SSHD, app=app(), name=box, image=image or build_image(), unencrypted_ports=[22],
                              runtime=runtime, timeout=LIFETIME, _experimental_enable_snapshot=True, **SIZE)
    state()[box] = {"runtime": runtime, "chain_start": None, "snapshot": None, "image": None}
    return sb


def wake(box: str) -> tuple[modal.Sandbox, str]:
    """The box's running sandbox, restoring or cold-starting it first if it sleeps. Returns (sandbox, how)."""
    sb = running(box)
    if sb:
        return sb, "running"
    rec = state().get(box)
    if not rec:
        raise SystemExit(f"no box named {box}")
    fresh = rec["snapshot"] and rec["chain_start"] and time.time() - rec["chain_start"] < CHAIN_MAX
    try:
        if fresh:
            snap = modal.SandboxSnapshot.from_id(rec["snapshot"])
            return modal.Sandbox._experimental_from_snapshot(snap, name=box), "restored"
        if not rec["image"]:
            raise SystemExit(f"{box} has no snapshot to wake from")
        image = modal.Image.from_id(rec["image"])
        sb = modal.Sandbox.create(*SSHD, app=app(), name=box, image=image, unencrypted_ports=[22],
                                  runtime=rec["runtime"], timeout=LIFETIME, _experimental_enable_snapshot=True, **SIZE)
        state()[box] = rec | {"chain_start": None, "snapshot": None}
        return sb, "cold"
    except modal.exception.AlreadyExistsError:
        # Another connection woke it first (the desktop opens more than one).
        for _ in range(20):
            sb = running(box)
            if sb:
                return sb, "running"
            time.sleep(0.5)
        raise


def sleep(box: str) -> dict:
    sb = running(box)
    if not sb:
        raise SystemExit(f"{box} isn't running")
    rec = state()[box]
    t = time.time()
    image = sb.snapshot_filesystem(timeout=120)
    t_fs = time.time() - t
    t = time.time()
    snap = sb._experimental_snapshot()  # ends the sandbox
    t_mem = time.time() - t
    sb.terminate()
    rec = rec | {"image": image.object_id, "snapshot": snap.object_id,
                 "chain_start": rec["chain_start"] or time.time()}
    state()[box] = rec
    return {"fs_snapshot_s": round(t_fs, 1), "mem_snapshot_s": round(t_mem, 1)}


def connect(host: str, port: int, deadline: float) -> tuple[socket.socket, bytes]:
    """A connection whose far end is sshd: the tunnel can accept before sshd listens, then close at once."""
    while True:
        try:
            s = socket.create_connection((host, port), timeout=5)
            banner = s.recv(256)
            if banner.startswith(b"SSH-"):
                s.settimeout(None)
                return s, banner
            s.close()
        except OSError:
            pass
        if time.time() > deadline:
            raise SystemExit(f"sshd never answered on {host}:{port}")
        time.sleep(0.5)


def proxy(box: str) -> None:
    t = time.time()
    sb, how = wake(box)
    tn = sb.tunnels()[22]
    s, banner = connect(tn.unencrypted_host, tn.unencrypted_port, time.time() + 30)
    if how != "running":
        log(f"{box} {how} in {time.time() - t:.1f}s")
    out = sys.stdout.buffer
    out.write(banner)
    out.flush()

    def upstream() -> None:
        while chunk := os.read(0, 65536):
            s.sendall(chunk)
        s.shutdown(socket.SHUT_WR)

    threading.Thread(target=upstream, daemon=True).start()
    while chunk := s.recv(65536):
        out.write(chunk)
        out.flush()


def status(box: str) -> dict:
    sb = running(box)
    rec = state().get(box)
    out = {"box": box, "running": bool(sb), "record": rec}
    if sb:
        tn = sb.tunnels()[22]
        out |= {"sandbox": sb.object_id, "tunnel": f"{tn.unencrypted_host}:{tn.unencrypted_port}"}
    return out


def destroy(box: str) -> None:
    sb = running(box)
    if sb:
        sb.terminate()
    state().pop(box, None)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["create", "proxy", "sleep", "status", "destroy"])
    ap.add_argument("box")
    ap.add_argument("--runtime", choices=["gvisor", "vm"], default="gvisor")
    a = ap.parse_args()
    if a.command == "create":
        sb = create(a.box, None if a.runtime == "gvisor" else a.runtime)
        print(status(a.box))
    elif a.command == "proxy":
        proxy(a.box)
    elif a.command == "sleep":
        print(sleep(a.box))
    elif a.command == "status":
        print(status(a.box))
    else:
        destroy(a.box)
