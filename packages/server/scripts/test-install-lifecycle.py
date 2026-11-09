#!/usr/bin/env python3
"""Destructive service lifecycle tests, ONLY on a disposable Linux VM.
Requires a candidate --service install and passwordless sudo for that service.
ATEAM_LIFECYCLE_TEST=1 python3 test-install-lifecycle.py INSTALLER TARBALL
"""
import fcntl
import json
import os
from pathlib import Path
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import tarfile
import io
import time

assert os.environ.get("ATEAM_LIFECYCLE_TEST") == "1", "disposable VM opt-in required"
installer, tarball = map(lambda x: str(Path(x).resolve()), sys.argv[1:3])
data = Path.home() / ".ateam"
lifecycle = Path.home() / "ateam-app"
sock = str(data / "rpc.sock")
cli = str(Path.home() / ".local/bin/ateam")
logs = Path(tempfile.mkdtemp(prefix="ateam-installer-tests-"))
processes = []


def wait_for(fn, seconds=90):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            result = fn()
            if result:
                return result
        except (OSError, ValueError):
            pass
        time.sleep(0.02)
    raise AssertionError("condition timed out")


def rpc(method, args=None):
    with socket.socket(socket.AF_UNIX) as s:
        s.settimeout(5)
        s.connect(sock)
        pid, _, _ = struct.unpack("3i", s.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        s.sendall((json.dumps({"t": "req", "id": 1, "method": method, "args": args or []}) + "\n").encode())
        with s.makefile("r") as stream:
            for line in stream:
                frame = json.loads(line)
                if frame.get("t") == "res" and frame.get("id") == 1:
                    assert frame["ok"], frame
                    return frame.get("result"), pid
    raise AssertionError("no RPC reply")


def state():
    return (lifecycle / "install-state").read_text().strip()


def service_pid():
    return int(subprocess.check_output(["systemctl", "show", "-p", "MainPID", "--value", "ateam.service"]))


def install(extra_env=None, extra_args=()):
    log = open(logs / f"install-{len(processes)}.log", "w")
    # Exercise the documented stdin-pipeline invocation, not only bash FILE.
    p = subprocess.Popen(["bash", "-o", "pipefail", "-c", 'cat "$1" | bash -s -- --service "${@:2}"', "bash", installer, *extra_args],
                         env={**os.environ, "ATEAM_TARBALL": tarball, **(extra_env or {})},
                         stdout=log, stderr=log, start_new_session=True)
    log.close()
    processes.append(p)
    return p


def unlocked():
    with open(lifecycle / "install.lock", "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            return False


def checked_ready(old):
    if state() != "ready" or not unlocked():
        return False
    _, pid = rpc("system:hello")
    return pid if pid == service_pid() and pid != old else False


curl = Path.home() / ".local/bin/curl"
curl_created = False
paused_pid = None
try:
    _, initial = rpc("system:hello")
    assert initial == service_pid()
    terminal, _ = rpc("pty:boxShell")
    terminal = terminal["terminalId"]
    marker = logs / "shell-preserved"
    rpc("pty:write", [terminal, "LIFECYCLE_SURVIVES=kept\n"])

    # An active initializer owns a shared startup gate. Installer must wait,
    # while another installer is rejected without changing transaction state.
    with open(lifecycle / "startup.lock", "a") as gate:
        fcntl.flock(gate, fcntl.LOCK_SH)
        first = install()
        wait_for(lambda: not unlocked())
        second = install({"ATEAM_DATA_DIR": str(logs / "other-data")})
        assert second.wait(timeout=15) == 75
        assert rpc("system:hello")[1] == initial
        fcntl.flock(gate, fcntl.LOCK_UN)
    # Repeated genuine attach requests cover disconnect and reconnect during
    # activation; every successful connection must belong to systemd.
    while first.poll() is None:
        attempt = subprocess.run(["timeout", "2", cli, "attach", "--stdio"],
                                 input=b'{"t":"req","id":1,"method":"system:hello","args":[]}\n',
                                 capture_output=True, timeout=15)
        if attempt.stdout:
            try:
                assert rpc("system:hello")[1] == service_pid()
            except OSError:
                pass  # the managed process may be between stop and start
    assert first.returncode == 0, (logs / "install-0.log").read_text()
    current = wait_for(lambda: checked_ready(initial))
    print("PASS concurrent installs serialize; reconnects remain service-owned", flush=True)

    # Freeze only this disposable service's main engine, not its PTY children.
    # The installer reaches activation and waits for the old process to exit;
    # kill its entire invocation before it can complete. No timing hook in prod.
    paused_pid = current
    os.kill(paused_pid, signal.SIGSTOP)
    interrupted = install()
    wait_for(lambda: state() == "activating")
    # Observe TERM pending on the stopped engine before killing the installer.
    # This keeps the interruption deterministic even on a fast machine.
    def term_pending():
        fields = dict(line.split(":", 1) for line in Path(f"/proc/{paused_pid}/status").read_text().splitlines() if ":" in line)
        return int(fields["ShdPnd"].strip(), 16) & (1 << (signal.SIGTERM - 1))
    wait_for(term_pending, seconds=5)
    os.killpg(interrupted.pid, signal.SIGKILL)
    interrupted.wait(timeout=10)
    wait_for(unlocked)
    os.kill(paused_pid, signal.SIGCONT)
    paused_pid = None
    wait_for(lambda: service_pid() == 0)
    refused = subprocess.run([cli, "attach", "--stdio"], capture_output=True, timeout=15)
    assert refused.returncode == 75
    assert state() == "activating"
    retry = install()
    assert retry.wait(timeout=120) == 0
    current = wait_for(lambda: checked_ready(current))
    print("PASS killed activation releases locks, refuses false readiness and retries", flush=True)

    # Exercise the real system:update handler. Intercept only the two public
    # download URLs inside this disposable VM to deliver the unpublished candidate.
    # No production endpoint or authentication behavior is replaced.
    original_curl = subprocess.check_output(["which", "curl"], text=True).strip()
    installer_url = "https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install.sh"
    tarball_url = "https://github.com/clawnify/ateam/releases/latest/download/ateam-server.tar.gz"
    with curl.open("x") as f:
        curl_created = True
        f.write("#!/usr/bin/python3\nimport os,sys,shutil\n")
        f.write(f"sources={{{installer_url!r}:{installer!r},{tarball_url!r}:{tarball!r}}}\n")
        f.write("args=sys.argv[1:]; source=sources.get(args[-1]) if args else None\n")
        f.write("if source:\n if '-o' in args: shutil.copyfile(source,args[args.index('-o')+1])\n else: sys.stdout.buffer.write(open(source,'rb').read())\n")
        f.write(f"else: os.execv({original_curl!r},[{original_curl!r}]+args)\n")
    curl.chmod(0o755)
    response, _ = rpc("system:update")
    assert response["started"]
    wait_for(lambda: not unlocked())
    current = wait_for(lambda: checked_ready(current), seconds=120)
    print("PASS real system:update uses the same transaction and service ownership", flush=True)

    reopened, _ = rpc("pty:boxShell")
    assert reopened["terminalId"] == terminal
    rpc("pty:write", [terminal, f"printf '%s' \"$LIFECYCLE_SURVIVES\" > {marker}\n"])
    wait_for(lambda: marker.exists() and marker.read_text() == "kept")
    rpc("pty:kill", [terminal])
    print("PASS live shell state survives install, interrupted install, retry and RPC update", flush=True)
    # The browser step must consume the newly activated payload and launcher,
    # not the previous release's files. Replace only the expensive browser setup
    # with a fixture that checks those prerequisites on a real installer run.
    browser_tar = logs / "browser-candidate.tgz"
    browser_marker = logs / "browser-activated"
    browser_script = f'#!/bin/bash\nset -eu\ngrep -q LIFECYCLE_BROWSER_PAYLOAD "$HOME/ateam-app/desktop.js"\ntest -x "$HOME/.local/bin/ateam"\ntouch {browser_marker}\n'.encode()
    with tarfile.open(tarball, "r:gz") as source, tarfile.open(browser_tar, "w:gz") as target:
        for entry in source:
            if not entry.isfile():
                target.addfile(entry)
                continue
            content = source.extractfile(entry).read()
            if entry.name == "install-browser.sh":
                content = browser_script
            elif entry.name == "desktop.js":
                content += b"\n// LIFECYCLE_BROWSER_PAYLOAD\n"
            entry.size = len(content)
            target.addfile(entry, io.BytesIO(content))
    browser_install = install({"ATEAM_TARBALL": str(browser_tar)}, ("--browser",))
    assert browser_install.wait(timeout=120) == 0
    assert browser_marker.exists(), "browser installer ran before its payload was activated"
    print("PASS browser setup consumes the activated payload and launcher", flush=True)
    print(f"Installer logs: {logs}", flush=True)
finally:
    if paused_pid:
        os.kill(paused_pid, signal.SIGCONT)
    if curl_created:
        curl.unlink()
    for p in processes:
        if p.poll() is None:
            os.killpg(p.pid, signal.SIGTERM)
            p.wait(timeout=15)
