"""Can a Modal Sandbox be an Ateam box? The spike behind docs/providers/modal.md.

Each phase creates its own sandboxes, prints what it measured, and terminates them.

    uv tool install modal && modal token new     # once
    ssh-keygen -t ed25519 -N "" -f /tmp/modal-spike-key
    MODAL_SPIKE_KEY=/tmp/modal-spike-key uv run --with modal python docs/providers/modal-spike.py <phase> [--runtime vm]

Phases:
    baseline     image with sshd + the engine, SSH over a TCP tunnel, `ateam attach`, TUN/Tailscale probe
    fs-snapshot  filesystem snapshot -> new sandbox: what survives, what the tunnel becomes
    mem-snapshot memory snapshot -> restore: do the engine's processes survive
    idle         is the 24h cap real, and does SSH-only traffic count against idle_timeout
    persistent   persistent Sandbox pause/resume (needs Modal to enable it for the workspace)

Stop leftovers with `modal app stop ateam-spike -y`.
"""

import argparse
import json
import os
import subprocess
import time

import modal

KEY = os.environ.get("MODAL_SPIKE_KEY") or os.path.expanduser("~/.ssh/id_ed25519")
INSTALL = "https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install.sh"
SSHD = ["/bin/sh", "-c", "mkdir -p /run/sshd && exec /usr/sbin/sshd -D -e"]
SIZE = {"cpu": 2, "memory": 4096}

app = modal.App.lookup("ateam-spike", create_if_missing=True)


def build_image() -> modal.Image:
    pub = open(KEY + ".pub").read().strip()
    return (
        modal.Image.debian_slim(python_version="3.12")
        .apt_install("openssh-server", "git", "curl", "ca-certificates", "sudo", "procps", "iproute2", "gnupg")
        .run_commands(
            "useradd -m -s /bin/bash ateam",
            "echo 'ateam ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/ateam",
            "mkdir -p /home/ateam/.ssh /run/sshd",
            f"echo '{pub}' > /home/ateam/.ssh/authorized_keys",
            "chown -R ateam:ateam /home/ateam/.ssh && chmod 700 /home/ateam/.ssh "
            "&& chmod 600 /home/ateam/.ssh/authorized_keys",
            "ssh-keygen -A",
            "sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config",
            # gh preinstalled, so install.sh skips its own gh step (#416 aborts it).
            "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/gh.gpg",
            "echo 'deb [signed-by=/usr/share/keyrings/gh.gpg] https://cli.github.com/packages stable main' "
            "> /etc/apt/sources.list.d/gh.list",
            "apt-get update -q && apt-get install -yq gh",
            "curl -fsSL https://tailscale.com/install.sh | sh",
            # The engine, the documented way, as the user that owns the agents.
            f"su - ateam -c 'curl -fsSL {INSTALL} | bash'",
        )
    )


def timed(label: str, start: float) -> None:
    print(f"[time] {label}: {time.time() - start:.1f}s", flush=True)


def in_box(sb: modal.Sandbox, cmd: str) -> str:
    """Run as root through Modal's exec, not SSH."""
    p = sb.exec("bash", "-lc", cmd)
    out, err = p.stdout.read(), p.stderr.read()
    p.wait()
    return (out + err).strip()


def tunnel(sb: modal.Sandbox) -> tuple[str, int]:
    tn = sb.tunnels()[22]
    return tn.unencrypted_host, tn.unencrypted_port


def ssh(host: str, port: int, cmd: str, timeout: int = 60):
    argv = ["ssh", "-i", KEY, "-p", str(port), "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", "-o", "ConnectTimeout=20",
            f"ateam@{host}", cmd]
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stdout + r.stderr).strip()
    except subprocess.TimeoutExpired:
        return "timeout", ""


def ssh_ready(host: str, port: int, tries: int = 30) -> bool:
    """sshd takes a second or two after the tunnel exists; the first attempt can fail with 255."""
    start = time.time()
    rc, out = None, ""
    for _ in range(tries):
        rc, out = ssh(host, port, "true", timeout=15)
        if rc == 0:
            timed("ssh ready", start)
            return True
        time.sleep(1)
    print("ssh never ready:", rc, out)
    return False


SURVIVORS = ("pgrep -f 'sleep 999[9]' >/dev/null && echo procs-survived || echo procs-gone; "
             "pgrep -f 'ateam-app/cl[i]' >/dev/null && echo engine-survived || echo engine-gone")


def probe(sb: modal.Sandbox) -> None:
    print(in_box(sb, "uname -r; ls -l /dev/net/tun 2>&1; nproc; df -h / | tail -1; "
                     "test -d /run/systemd/system && echo systemd=yes || echo systemd=no"))
    print(in_box(sb, "(tailscaled --state=mem: --tun=userspace-networking --socket=/tmp/tsu.sock >/tmp/tsu.log 2>&1 &); "
                     "sleep 4; echo userspace-tailscaled: $(tailscale --socket=/tmp/tsu.sock status --json 2>&1 "
                     "| grep -m1 BackendState || echo not running); "
                     "(tailscaled --state=mem: --socket=/tmp/tsk.sock --statedir=/tmp/tsk >/tmp/tsk.log 2>&1 &); "
                     "sleep 4; echo '-- kernel-TUN tailscaled:'; tail -3 /tmp/tsk.log"))


def engine_check(host: str, port: int) -> None:
    """What the desktop does: `ateam attach` over SSH, which starts the daemon on demand."""
    rc, out = ssh(host, port,
                  "timeout 15 ~/.local/bin/ateam attach --stdio </dev/null >/tmp/attach.out 2>&1; sleep 2; "
                  "pgrep -af 'ateam-app/(cli|daemon)'; ls -l ~/.ateam/rpc.sock", timeout=90)
    print("engine:", rc, out)


def start(image: modal.Image, runtime: str | None, **kw) -> tuple[modal.Sandbox, str, int]:
    s = time.time()
    sb = modal.Sandbox.create(*SSHD, app=app, image=image, unencrypted_ports=[22], runtime=runtime,
                              **({"timeout": 1800} | SIZE | kw))
    timed(f"create ({runtime or 'gvisor'})", s)
    host, port = tunnel(sb)
    print("sandbox", sb.object_id, "tunnel", host, port)
    ssh_ready(host, port)
    return sb, host, port


def baseline(image, runtime):
    sb, host, port = start(image, runtime)
    probe(sb)
    engine_check(host, port)
    sb.terminate()


def fs_snapshot(image, runtime):
    sb, host, port = start(image, runtime)
    engine_check(host, port)
    ssh(host, port, "git clone -q --depth 1 https://github.com/clawnify/ateam ~/work/ateam; "
                    "mkdir -p ~/.claude && echo secret > ~/.claude/.credentials.json; (nohup sleep 9999 >/dev/null 2>&1 &)")
    s = time.time(); img = sb.snapshot_filesystem(); timed("snapshot_filesystem", s)
    sb.terminate()
    sb2, h2, p2 = start(img, runtime)
    print("tunnel", f"{host}:{port}", "->", f"{h2}:{p2}")
    print(ssh(h2, p2, f"ls ~/work/ateam | head -2; cat ~/.claude/.credentials.json; ls ~/.ateam; {SURVIVORS}"))
    sb2.terminate()


def mem_snapshot(image, runtime):
    sb, host, port = start(image, runtime, _experimental_enable_snapshot=True)
    engine_check(host, port)
    ssh(host, port, "(nohup sleep 9999 >/dev/null 2>&1 &)")
    s = time.time(); snap = sb._experimental_snapshot(); timed("memory snapshot", s)
    sb.terminate()
    s = time.time()
    sb2 = modal.Sandbox._experimental_from_snapshot(snap)
    h2, p2 = tunnel(sb2); timed("memory restore + tunnel", s)
    print("tunnel", f"{host}:{port}", "->", f"{h2}:{p2}")
    ssh_ready(h2, p2)
    print(ssh(h2, p2, SURVIVORS))
    sb2.terminate()


def idle(image, runtime):
    try:
        modal.Sandbox.create("sleep", "1", app=app, timeout=25 * 3600)
        print("a 25h timeout was accepted")
    except Exception as e:  # noqa: BLE001 - we want the message, whatever it is
        print("25h timeout:", type(e).__name__, str(e)[:150])
    sb, host, port = start(image, runtime, idle_timeout=60)
    s = time.time()
    ssh(host, port, "for i in $(seq 30); do echo tick; sleep 5; done", timeout=200)
    timed("ssh-only session", s)
    sb.poll(); print("alive after 150s of ssh-only traffic, idle_timeout=60:", sb.returncode is None)
    time.sleep(90)
    sb.poll(); print("alive after 90s of silence:", sb.returncode is None)
    if sb.returncode is None:
        sb.terminate()


def persistent(image, runtime):
    s = time.time()
    sb = modal.Sandbox.create(*SSHD, app=app, image=image, timeout=None, unencrypted_ports=[22],
                              runtime=runtime, _experimental_persistent=True, **SIZE)
    timed("create persistent", s)
    host, port = tunnel(sb)
    ssh_ready(host, port)
    engine_check(host, port)
    ssh(host, port, "mkdir -p ~/.claude && echo secret > ~/.claude/.credentials.json; (nohup sleep 9999 >/dev/null 2>&1 &)")
    s = time.time(); sb._experimental_pause(); timed("pause", s)
    print("ssh to the old tunnel while paused:", ssh(host, port, "echo reached", timeout=30))
    s = time.time(); sb._experimental_resume(); h2, p2 = tunnel(sb); timed("resume + tunnel", s)
    print("tunnel", f"{host}:{port}", "->", f"{h2}:{p2}", "(same)" if (h2, p2) == (host, port) else "(changed)")
    ssh_ready(h2, p2)
    print(ssh(h2, p2, f"cat ~/.claude/.credentials.json; {SURVIVORS}"))
    sb.terminate()


PHASES = {"baseline": baseline, "fs-snapshot": fs_snapshot, "mem-snapshot": mem_snapshot,
          "idle": idle, "persistent": persistent}

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("phase", choices=PHASES)
    ap.add_argument("--runtime", choices=["gvisor", "vm"], default="gvisor")
    a = ap.parse_args()
    PHASES[a.phase](build_image(), None if a.runtime == "gvisor" else a.runtime)
    print(json.dumps({"done": a.phase, "runtime": a.runtime}))
