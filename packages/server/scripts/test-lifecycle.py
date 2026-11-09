#!/usr/bin/env python3
"""Real Linux process/socket tests. Run only in a disposable VM after installing
the candidate server. No account credentials or coding agents are used.

ATEAM_LIFECYCLE_TEST=1 python3 test-lifecycle.py ~/ateam-app/cli.js
"""
import fcntl
import json
import os
from pathlib import Path
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time

assert os.environ.get("ATEAM_LIFECYCLE_TEST") == "1", "disposable VM opt-in required"
assert sys.platform == "linux", "requires Linux peer credentials and flock"
cli = str(Path(sys.argv[1]).resolve())
root = Path(tempfile.mkdtemp(prefix="ateam-lifecycle-"))
children = []
logs = []


def env_for(name):
    folder = root / name
    folder.mkdir(exist_ok=True)
    # Separate payloads isolate activation gates without repurposing HOME.
    shutil.copyfile(cli, folder / "cli.js")
    for asset in ("daemon.js", "node_modules"):
        (folder / asset).symlink_to(Path(cli).parent / asset)
    data = folder / "data"
    data.mkdir()
    return {**os.environ, "ATEAM_DATA_DIR": str(data),
            "ATEAM_RPC_SOCK": str(data / "rpc.sock"),
            "ATEAM_CONFIG": str(data / "settings.json")}


def payload(env):
    return Path(env["ATEAM_DATA_DIR"]).parent


def start(env, *args):
    log = open(root / f"process-{len(children)}.log", "w+")
    logs.append(log)
    p = subprocess.Popen(["node", str(payload(env) / "cli.js"), *args], env=env, stdin=subprocess.DEVNULL,
                         stdout=log, stderr=log)
    children.append(p)
    return p


def wait_for(fn, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            value = fn()
            if value:
                return value
        except (OSError, ValueError):
            pass
        time.sleep(0.05)
    raise AssertionError("condition timed out")


def hello(env):
    with socket.socket(socket.AF_UNIX) as s:
        s.settimeout(2)
        s.connect(env["ATEAM_RPC_SOCK"])
        pid, _, _ = struct.unpack("3i", s.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        s.sendall(b'{"t":"req","id":1,"method":"system:hello","args":[]}\n')
        data = b""
        while b"\n" not in data:
            data += s.recv(65536)
        result = json.loads(data.split(b"\n")[0])
        assert result["ok"] and result["result"]["protocolVersion"]
        return pid


def stop(p):
    if p.poll() is None:
        p.terminate()
        p.wait(timeout=10)


try:
    env = env_for("simultaneous")
    starters = [start(env, "daemon") for _ in range(12)]
    pid = wait_for(lambda: hello(env))
    wait_for(lambda: sum(p.poll() is None for p in starters) == 1)
    winner = next(p for p in starters if p.pid == pid)
    assert winner.poll() is None
    print("PASS simultaneous starts: one live engine and one socket owner", flush=True)

    # The same database cannot be opened through a second socket, nor the same
    # socket stolen by another data directory.
    alternate = {**env, "ATEAM_RPC_SOCK": str(root / "alternate.sock")}
    assert start(alternate, "daemon").wait(timeout=10) == 0
    other = env_for("other-data")
    other["ATEAM_RPC_SOCK"] = env["ATEAM_RPC_SOCK"]
    assert start(other, "daemon").wait(timeout=10) == 0
    assert hello(env) == pid
    print("PASS ownership covers both database and socket", flush=True)

    winner.kill()
    winner.wait(timeout=10)
    replacement = start(env, "daemon")
    assert wait_for(lambda: hello(env)) == replacement.pid
    stop(replacement)
    print("PASS SIGKILL releases ownership; stale socket is recovered", flush=True)

    # Hold the actual installer's activation gate before launching a daemon.
    # No application DB may be initialized while activation owns it.
    env = env_for("activation")
    folder = Path(env["ATEAM_DATA_DIR"])
    with open(payload(env) / "startup.lock", "w") as gate:
        fcntl.flock(gate, fcntl.LOCK_EX)
        p = start(env, "daemon")
        time.sleep(0.5)
        assert p.poll() is None
        assert not (folder / "ateam.sqlite").exists()
        assert not Path(env["ATEAM_RPC_SOCK"]).exists()
        fcntl.flock(gate, fcntl.LOCK_UN)
    assert wait_for(lambda: hello(env)) == p.pid
    # A running daemon/connection must not keep the startup gate locked.
    with open(payload(env) / "startup.lock", "w") as gate:
        fcntl.flock(gate, fcntl.LOCK_EX | fcntl.LOCK_NB)
    stop(p)
    print("PASS activation excludes initialization, not normal operation", flush=True)

    env = env_for("interrupted")
    folder = Path(env["ATEAM_DATA_DIR"])
    for phase in ("preparing", "activating", "failed:1"):
        (payload(env) / "install-state").write_text(phase)
        assert start(env, "daemon").wait(timeout=10) != 0
        assert not (folder / "ateam.sqlite").exists()
    (payload(env) / "install-state").write_text("starting")
    p = start(env, "daemon")
    assert wait_for(lambda: hello(env)) == p.pid
    stop(p)
    print("PASS interrupted activation refuses startup; completed activation can resume", flush=True)

    env = env_for("connect-only")
    p = start(env, "attach", "--stdio", "--no-start")
    assert p.wait(timeout=15) != 0
    assert not (Path(env["ATEAM_DATA_DIR"]) / "ateam.sqlite").exists()
    print("PASS verification never starts a daemon", flush=True)

    env = env_for("managed")
    folder = Path(env["ATEAM_DATA_DIR"])
    (payload(env) / "service-owner").write_text("system")
    assert start(env, "daemon").wait(timeout=10) != 0
    assert not (folder / "ateam.sqlite").exists()
    p = start(env, "daemon", "--supervised")
    assert wait_for(lambda: hello(env)) == p.pid
    stop(p)
    print("PASS managed engines require the supervisor startup path", flush=True)
finally:
    for p in children:
        stop(p)
    for log in logs:
        log.close()
    if sys.exc_info()[0] is None:
        shutil.rmtree(root)
    else:
        print(f"Failure logs retained in {root}", file=sys.stderr)
