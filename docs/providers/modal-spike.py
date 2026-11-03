"""Can a Modal Sandbox be an Ateam box? The spike behind docs/providers/modal.md.

Each phase creates its own sandboxes, prints what it measured, and terminates them.

    uv tool install modal && modal token new     # once
    ssh-keygen -t ed25519 -N "" -f /tmp/modal-spike-key
    MODAL_BOX_KEY=/tmp/modal-spike-key uv run --with modal python docs/providers/modal-spike.py <phase> [--runtime vm]

Phases:
    baseline     image with sshd + the engine, SSH over a TCP tunnel, `ateam attach`, TUN/Tailscale probe
    fs-snapshot  filesystem snapshot -> new sandbox: what survives, what the tunnel becomes
    mem-snapshot memory snapshot -> restore: do the engine's processes survive
    idle         is the 24h cap real, and does SSH-only traffic count against idle_timeout
    persistent   persistent Sandbox pause/resume (needs Modal to enable it for the workspace)
    exit-snapshot does an idle-terminated sandbox leave a filesystem snapshot behind
    restore-clock does a memory restore restart the `timeout` clock, and keep the sandbox's name
    alias        modal_box.py as a ProxyCommand: one ssh alias across sleep, wake and a cold wake
    cost         an hour of an idle box at three sizings, each in its own app, to read off the bill afterwards
    tailscale    join the tailnet (approve a login link), the phone's WebSocket over it, across a memory snapshot
                 (run it with `--with websockets` on a laptop on the tailnet: a node running tailscaled in
                 userspace mode can't open sockets to tailnet addresses)
    snapshot     memory-snapshot a running sandbox (`--sandbox <id>`), wait `--gap` seconds, restore it:
                 the step taken in the middle of an agent's turn

Stop leftovers with `modal app stop ateam-spike -y` (and `ateam-boxes` for the alias phase).
"""

import argparse
import json
import os
import subprocess
import threading
import time

import modal

import modal_box
from modal_box import KEY, SIZE, SSHD, build_image

app = modal.App.lookup("ateam-spike", create_if_missing=True)


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


def exit_snapshot(image, runtime):
    """Does a sandbox that idles out leave a filesystem snapshot behind, and can it also take memory snapshots?"""
    sb, host, port = start(image, runtime, idle_timeout=60, experimental_options={"enable_exit_snapshot": True})
    ssh(host, port, "mkdir -p ~/.claude && echo secret > ~/.claude/.credentials.json; ls -d ~/.ateam")
    s = time.time(); sb.wait(raise_on_termination=False); timed("idle-terminated", s)
    s = time.time(); img = sb._experimental_get_exit_snapshot(timeout=300); timed("exit snapshot ready", s)
    sb2, h2, p2 = start(img, runtime)
    print("after idle exit:", ssh(h2, p2, "cat ~/.claude/.credentials.json; ls ~/.ateam | head -3"))
    sb2.terminate()
    try:
        sb3, _, _ = start(image, runtime, _experimental_enable_snapshot=True,
                          experimental_options={"enable_exit_snapshot": True})
        print("exit snapshot together with memory snapshots: accepted")
        sb3.terminate()
    except Exception as e:  # noqa: BLE001 - we want the message, whatever it is
        print("exit snapshot together with memory snapshots:", type(e).__name__, str(e)[:200])


def restore_clock(image, runtime):
    """After a memory restore, does the `timeout` clock start again, and does the sandbox keep its name?"""
    name = f"clock-{int(time.time())}"
    born = time.time()
    sb, _, _ = start(image, runtime, timeout=120, name=name, _experimental_enable_snapshot=True)
    time.sleep(max(0, 60 - (time.time() - born)))
    snap = sb._experimental_snapshot()
    s = time.time(); sb2 = modal.Sandbox._experimental_from_snapshot(snap); restored = time.time()
    timed("memory restore", s)
    try:
        found = modal.Sandbox.from_name("ateam-spike", name)
        print("restored sandbox keeps its name:", found.object_id == sb2.object_id)
    except modal.exception.NotFoundError:
        print("restored sandbox keeps its name: no")
    while sb2.poll() is None and time.time() - restored < 240:
        time.sleep(5)
    print(f"restored sandbox (timeout=120) ended {time.time() - restored:.0f}s after the restore, "
          f"{time.time() - born:.0f}s after the first create", "(still running)" if sb2.poll() is None else "")
    if sb2.poll() is None:
        sb2.terminate()


HELLO = '{"t":"req","id":1,"method":"system:hello","args":[]}\n'


def alias(image, runtime):
    """One ~/.ssh/config entry for the box's whole life: connect, sleep, wake on connect, wake cold."""
    box = f"spike-{int(time.time()) % 100000}"
    here = os.path.dirname(os.path.abspath(__file__))
    cfg = f"/tmp/{box}.ssh_config"
    with open(cfg, "w") as f:
        f.write(f"Host modal-{box}\n  User ateam\n  IdentityFile {KEY}\n  HostKeyAlias modal-{box}\n"
                f"  UserKnownHostsFile /tmp/{box}.known_hosts\n  StrictHostKeyChecking accept-new\n"
                f"  ProxyCommand uv run -q --with modal python {here}/modal_box.py proxy {box}\n")
    results = []

    def check(label, ok, detail=""):
        results.append((label, ok))
        print(("PASS" if ok else "FAIL"), label, detail, flush=True)

    def run(cmd, timeout=90):
        r = subprocess.run(["ssh", "-F", cfg, f"modal-{box}", cmd], capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout.strip(), r.stderr.strip()

    def hello():
        """What the desktop does on every connect: `ateam attach --stdio` over the alias, then system:hello."""
        s = time.time()
        p = subprocess.Popen(["ssh", "-F", cfg, f"modal-{box}", "bash -lc 'exec ateam attach --stdio'"],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        p.stdin.write(HELLO); p.stdin.flush()
        line = p.stdout.readline()
        took = time.time() - s
        p.kill()
        err = p.stderr.read().strip()
        return "protocolVersion" in line, took, err

    # The engine and the PTY daemon, by PID; the bracket keeps pgrep from matching its own shell.
    pids = ("pgrep -f 'ateam-app/(cli.js daemo[n]|daemon.j[s])' | sort | tr '\\n' ' '; "
            "pgrep -f 'sleep 999[9]' >/dev/null && echo marker")
    modal_box.create(box, runtime, image)
    ok, took, _ = hello()
    check("handshake through the alias", ok, f"{took:.1f}s")
    run("(nohup sleep 9999 >/dev/null 2>&1 &); echo kept > ~/kept.txt")
    before = run(pids)[1]
    first_tunnel = modal_box.status(box)["tunnel"]

    print("sleep:", modal_box.sleep(box))
    check("asleep after sleep", modal_box.running(box) is None)

    out = []
    threads = [threading.Thread(target=lambda: out.append(hello())) for _ in range(2)]
    [t.start() for t in threads]; [t.join() for t in threads]
    check("two connects at once wake it, both handshake", all(o[0] for o in out),
          " | ".join(f"{o[1]:.1f}s {o[2]}" for o in out))
    live = [sb for sb in modal.Sandbox.list(app_id=modal_box.app().app_id) if sb.poll() is None]
    check("only one sandbox runs after the double wake", len(live) == 1, f"{len(live)} running")
    st = modal_box.status(box)
    check("the tunnel changed, the alias didn't", st["tunnel"] != first_tunnel, f"{first_tunnel} -> {st['tunnel']}")
    after = run(pids)[1]
    check("engine, PTY daemon and other processes survived the wake", after == before, f"{before!r} -> {after!r}")
    ok, took, _ = hello()
    check("a connect while awake skips the wake", ok, f"{took:.1f}s")

    print("sleep:", modal_box.sleep(box))
    rec = modal_box.state()[box]
    modal_box.state()[box] = rec | {"chain_start": time.time() - 7 * 24 * 3600}  # as if the chain had expired
    ok, took, err = hello()
    check("an expired memory snapshot wakes cold from the filesystem snapshot", ok, f"{took:.1f}s {err}")
    rc, cold, _ = run(f"cat ~/kept.txt; {pids}")
    check("a cold wake keeps files, loses processes", cold.startswith("kept") and "marker" not in cold, repr(cold))
    print("sleep:", modal_box.sleep(box))
    check("a box woken cold starts a new memory snapshot chain", modal_box.state()[box]["chain_start"] > time.time() - 120)
    ok, took, err = hello()
    check("and wakes from it", ok, f"{took:.1f}s {err}")

    modal_box.destroy(box)
    print(f"{sum(ok for _, ok in results)}/{len(results)} passed")


COST_SIZES = {
    "fixed-gvisor": (None, {"cpu": 2, "memory": 4096}),
    "burst-gvisor": (None, {"cpu": (0.125, 2), "memory": (1024, 4096)}),
    "burst-vm": ("vm", {"cpu": (0.125, 2), "memory": (1024, 4096)}),
}


def cost(image, runtime):
    """An hour of an idle box with the engine running, at each sizing. Modal bills the larger of what a
    sandbox requests and what it uses, so the request is the lever. The bill groups costs by app and hour
    (sandbox tags don't show in it), so each sizing gets its own app. Read it a couple of hours later:
    `modal billing report --for today -r h --show-resources`. Not rerun since that change: the first run
    shared one app, and the workspace's spend limit stopped it before the in-box readings."""
    boxes = {}
    for label, (rt, size) in COST_SIZES.items():
        sized = modal.App.lookup(f"ateam-cost-{label}", create_if_missing=True)
        sb = modal.Sandbox.create(*SSHD, app=sized, image=image, unencrypted_ports=[22], runtime=rt, timeout=4000,
                                  tags={"cost": label}, **size)
        host, port = tunnel(sb)
        ssh_ready(host, port)
        engine_check(host, port)
        boxes[label] = sb
        print(label, sb.object_id, time.strftime("%H:%M:%S"), flush=True)
    time.sleep(3600)
    for label, sb in boxes.items():
        print(label, in_box(sb, "cat /sys/fs/cgroup/cpu.stat 2>&1 | head -1; "
                                "cat /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory.current 2>&1; free -m | sed -n 2p"))
        sb.terminate()
    print("ended", time.strftime("%H:%M:%S"))


def ws_hello(addr: str) -> str:
    """What the phone does first: system:hello over the engine's WebSocket."""
    import asyncio

    import websockets

    async def go():
        async with websockets.connect(f"ws://{addr}", open_timeout=10) as ws:
            await ws.send(HELLO.strip())
            return await asyncio.wait_for(ws.recv(), 10)

    try:
        return asyncio.run(go())
    except Exception as e:  # noqa: BLE001 - we want the message, whatever it is
        return f"{type(e).__name__}: {e}"


def pause(flag: str, why: str) -> None:
    """Wait for someone to `touch` the flag (the simulator check happens by hand), or 30 minutes."""
    print(f"[pause] {why}: touch {flag} to go on", flush=True)
    deadline = time.time() + 1800
    while not os.path.exists(flag) and time.time() < deadline:
        time.sleep(3)
    if os.path.exists(flag):
        os.remove(flag)


TS_STATE = ("tailscale status --json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); "
            "print(d[\"BackendState\"], (d.get(\"TailscaleIPs\") or [\"-\"])[0], d[\"Self\"][\"ID\"])'")


def tailscale(image, runtime):
    """Phone over Tailscale: join the tailnet as an ephemeral node (approve the printed login link), serve the
    engine's WebSocket there, reach it from this machine's tailnet, then again after a memory snapshot.
    Run it on a tailnet node. Pauses for a by-hand check from the phone at each step."""
    label = runtime or "gvisor"
    flag = f"/tmp/modal-spike-{label}.go"
    sb, host, port = start(image, runtime, timeout=3600, _experimental_enable_snapshot=True)
    userspace = runtime != "vm"
    # No systemd in either runtime, so tailscaled runs as a plain background process. --state=mem: makes the
    # node ephemeral: `tailscale logout` removes it at once, and Tailscale does 30-60 min after it goes offline.
    # Started through Modal's exec, as here, it did not survive the memory restore on gVisor: Modal doesn't
    # restore background processes an exec started. A box has to start it from the sandbox's own command, or
    # over SSH (userspace mode runs as the box user; sudo is refused there).
    in_box(sb, "mkdir -p /run/tailscale; (tailscaled --state=mem: --socket=/run/tailscale/tailscaled.sock "
               + ("--tun=userspace-networking " if userspace else "") + ">/tmp/tailscaled.log 2>&1 &); sleep 3")
    in_box(sb, f"(tailscale up --hostname=modal-spike-{label} --accept-dns=false >/tmp/up.log 2>&1 &); sleep 6")
    print("approve:", in_box(sb, "grep -o 'https://login.tailscale.com/[^ ]*' /tmp/up.log | head -1"), flush=True)
    st, s = "", time.time()
    while time.time() - s < 1800:
        st = in_box(sb, TS_STATE)
        if st.startswith("Running"):
            break
        time.sleep(5)
    timed("approved and running", s)
    _, ip, node = st.split()
    print("tailnet", ip, "node", node, "|", in_box(sb, "ip -br addr show tailscale0 2>&1 | head -1"))
    # Kernel TUN puts the tailnet IP on an interface the engine can bind. In userspace mode it isn't on
    # any interface; tailscaled hands inbound connections to the same port on localhost instead.
    listen = "127.0.0.1:8787" if userspace else f"{ip}:8787"
    ssh(host, port, f"echo {listen} > ~/.ateam/ws-addr")
    engine_check(host, port)
    print("ws listener:", in_box(sb, "ss -ltn | grep 8787"))
    print("hello over the tailnet:", ws_hello(f"{ip}:8787")[:120], flush=True)
    pause(flag, f"connect the phone to {ip}:8787")

    ssh(host, port, "(nohup sleep 9999 >/dev/null 2>&1 &)")
    s = time.time(); snap = sb._experimental_snapshot(); timed("memory snapshot", s)
    sb.terminate()
    time.sleep(30)  # the phone sees the box go away
    s = time.time(); sb = modal.Sandbox._experimental_from_snapshot(snap); timed("memory restore", s)
    s, st, hello = time.time(), "", ""
    while time.time() - s < 300:
        st = in_box(sb, TS_STATE)
        hello = ws_hello(f"{ip}:8787")
        if "protocolVersion" in hello:
            break
        time.sleep(2)
    timed("tailnet WebSocket answers again", s)
    print("after restore:", st, "| same node:", st.split()[1:] == [ip, node], "|", hello[:120])
    h2, p2 = tunnel(sb)
    ssh_ready(h2, p2)
    print(ssh(h2, p2, SURVIVORS))
    pause(flag, "check the phone reconnected")
    print("logout:", in_box(sb, "tailscale logout 2>&1; echo rc=$?"))
    sb.terminate()


def snapshot(sandbox_id: str, gap: float) -> None:
    """Memory-snapshot a running sandbox (one created with snapshots on), end it, wait, restore it."""
    sb = modal.Sandbox.from_id(sandbox_id)
    s = time.time(); snap = sb._experimental_snapshot(); timed(f"memory snapshot {snap.object_id}", s)
    sb.terminate()
    time.sleep(gap)
    s = time.time(); sb2 = modal.Sandbox._experimental_from_snapshot(snap)
    timed(f"memory restore -> {sb2.object_id}", s)
    print("tunnel", *tunnel(sb2), flush=True)


PHASES = {"baseline": baseline, "fs-snapshot": fs_snapshot, "mem-snapshot": mem_snapshot,
          "idle": idle, "persistent": persistent, "exit-snapshot": exit_snapshot,
          "restore-clock": restore_clock, "alias": alias, "cost": cost,
          "tailscale": tailscale}

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("phase", choices=[*PHASES, "snapshot"])
    ap.add_argument("--runtime", choices=["gvisor", "vm"], default="gvisor")
    ap.add_argument("--sandbox", help="snapshot: the sandbox to snapshot and restore")
    ap.add_argument("--gap", type=float, default=20, help="snapshot: seconds between the snapshot and the restore")
    a = ap.parse_args()
    if a.phase == "snapshot":
        snapshot(a.sandbox, a.gap)
    else:
        PHASES[a.phase](build_image(), None if a.runtime == "gvisor" else a.runtime)
    print(json.dumps({"done": a.phase, "runtime": a.runtime}))
