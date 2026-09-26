#!/usr/bin/env python3
"""Stable lux-ade launch, in-place data adoption, and planned application replacement.

Daemon replacement requires an acknowledged, boot-fenced handoff. Explicit
supervisor replacement also stops live work through its identity-checked API.
Legacy daemons must be stopped by their owner first.
"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time

SCRIPT = Path(__file__).resolve()
PROJECT = SCRIPT.parent if SCRIPT.parent.name == "Resources" else SCRIPT.parents[1]
DEFAULT_DAEMON = (PROJECT.parent / "MacOS/ade-daemon" if PROJECT.parent.name == "Contents"
                  else Path(os.environ.get("CARGO_TARGET_DIR", PROJECT / "target")) / "release/ade-daemon")
DEFAULT_HOME = Path.home() / "Library/Application Support/lux-ade/runtime"
APPLICATION_PROTOCOL = "ade-application-v1"
RUNTIME_PROTOCOL = "ade-runtime-v8"


def rpc(endpoint, value, timeout=5):
    with socket.socket(socket.AF_UNIX) as peer:
        peer.settimeout(timeout)
        peer.connect(str(endpoint))
        peer.sendall((json.dumps(value) + "\n").encode())
        with peer.makefile("rb") as reader:
            line = reader.readline(128 * 1024)
        if not line.endswith(b"\n"):
            raise RuntimeError("Daemon disconnected or returned an oversized control frame")
        result = json.loads(line)
        if result.get("type") == "error":
            raise RuntimeError(result.get("message", "Daemon error"))
        return result


@contextlib.contextmanager
def locked(directory, name):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / name).open("a+b") as handle:
        os.chmod(handle.name, 0o600)
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError(f"Another process owns {handle.name}") from error
        yield handle


def save_binding(home, directory):
    # Inspect under the original locks. Copying the database would create two
    # lifecycle owners, each with a different lock inode and the same marker tokens.
    directory = directory.resolve(strict=True)
    with contextlib.ExitStack() as locks:
        locks.enter_context(locked(directory, "writer.lock"))
        worktrees = directory / "sessions.worktrees"
        if worktrees.exists():
            for entry in sorted(worktrees.glob("*.lock")):
                locks.enter_context(locked(worktrees, entry.name))
        database = directory / "sessions.sqlite"
        if database.exists():
            with contextlib.closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as connection:
                version = connection.execute("PRAGMA user_version").fetchone()[0]
                if version not in range(1, 13):
                    raise RuntimeError(f"Unsupported store version {version}; keep the original directory")
                if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                    raise RuntimeError("Database integrity check failed; original directory preserved")
        descriptor, temporary = tempfile.mkstemp(prefix="binding-", dir=home)
        try:
            with os.fdopen(descriptor, "w") as writer:
                json.dump({"format_version": 1, "data_directory": str(directory)}, writer)
                writer.flush()
                os.fsync(writer.fileno())
            os.replace(temporary, home / "runtime.json")
            parent = os.open(home, os.O_RDONLY)
            try:
                os.fsync(parent)
            finally:
                os.close(parent)
        finally:
            Path(temporary).unlink(missing_ok=True)
    return directory


def binding(home, create=False):
    filename = home / "runtime.json"
    if filename.exists():
        value = json.loads(filename.read_text())
        if value.get("format_version") != 1:
            raise RuntimeError("Unsupported runtime binding format")
        return Path(value["data_directory"]).resolve(strict=True)
    explicit = os.environ.get("ADE_DATA_DIR")
    if explicit:
        directory = Path(explicit).expanduser()
        if create:
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            return save_binding(home, directory)
        return directory.resolve()
    if not create:
        raise RuntimeError("No stable runtime selected. Use adopt --data-dir PATH for an existing store.")
    candidates = sorted({p.parent.resolve() for pattern in ("ade*-data/sessions.sqlite", "ade*.data/sessions.sqlite")
                         for p in home.parent.glob(pattern)})
    if len(candidates) > 1:
        raise RuntimeError("Several legacy stores exist. Select one with adopt --data-dir PATH; none were merged:\n"
                           + "\n".join(str(p) for p in candidates))
    if candidates:
        return save_binding(home, candidates[0])
    directory = home / "data"
    directory.mkdir(mode=0o700, exist_ok=True)
    return save_binding(home, directory)


def endpoint(home):
    if os.environ.get("ADE_SOCKET"):
        return Path(os.environ["ADE_SOCKET"])
    # Keep the stable endpoint within the Unix socket path limit on macOS.
    identity = hashlib.sha256(os.fsencode(home.resolve())).hexdigest()[:20]
    return Path(f"/tmp/ade-{os.getuid()}-{identity}.sock")


def hello(sock):
    try:
        return rpc(sock, {"op": "hello"})
    except (FileNotFoundError, ConnectionRefusedError):
        return None


def compatible(value):
    if (value.get("application_protocol") != APPLICATION_PROTOCOL
            or value.get("runtime_protocol") != RUNTIME_PROTOCOL):
        raise RuntimeError("Existing daemon cannot hand off this runtime. Stop it through its owner first; it was left running.")


def build_identity(binary, providers=None):
    """Include external bridge code and its pinned dependencies in runtime identity."""
    providers = PROJECT / 'providers' if providers is None else Path(providers)
    digest = hashlib.sha256(b'ade-runtime-build-v2\0')
    files = [('binary', Path(binary))]
    workspace_lock = providers.parent / 'pnpm-lock.yaml'
    if workspace_lock.is_file():
        files.append(('pnpm-lock.yaml', workspace_lock))
    for directory, children, names in os.walk(providers):
        children[:] = sorted(name for name in children if name not in ('node_modules', '.git', '__pycache__'))
        for name in sorted(names):
            source = Path(directory) / name
            if name.endswith('.test.mjs') or any(word in name for word in ('fixture', 'mock', 'fake-sdk')):
                continue
            if (source.suffix == '.mjs' or name == 'package.json'
                    or (not workspace_lock.is_file() and name in ('pnpm-lock.yaml', 'pnpm-workspace.yaml'))):
                files.append((source.relative_to(providers).as_posix(), source))
    for label, source in sorted(files):
        digest.update(label.encode() + b'\0')
        # File digests delimit contents and keep memory independent of binary size.
        with source.open('rb') as stream:
            file_digest = hashlib.sha256()
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                file_digest.update(chunk)
            digest.update(file_digest.digest())
    return digest.hexdigest()


def workspace_environment(environment, project=PROJECT):
    """Installed apps wait for a folder; development and explicit roots stay explicit."""
    environment = dict(environment)
    if "ADE_ROOT" not in environment:
        if project.name == "Resources" and project.parent.name == "Contents":
            environment["ADE_WORKSPACE_SELECTION"] = "1"
        else:
            environment["ADE_ROOT"] = str(project)
    return environment


def start(home, data, sock, daemon):
    build_id = build_identity(daemon)
    current = hello(sock)
    if current:
        compatible(current)
        if current.get("build_id") != build_id:
            print("A newer daemon build is available. Keeping the compatible daemon and its live work; use runtime.py restart when ready.", file=sys.stderr)
        return current
    env = {**os.environ, "ADE_DATA_DIR": str(data), "ADE_SOCKET": str(sock), "ADE_BUILD_ID": build_id, "ADE_RUNTIME_BUILD_ID": build_identity(daemon.with_name("ade-runtime"))}
    env = workspace_environment(env)
    with (home / "daemon.log").open("ab") as log:
        child = subprocess.Popen([str(daemon)], env=env, stdin=subprocess.DEVNULL,
                                 stdout=log, stderr=log, start_new_session=True)
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise RuntimeError(f"Daemon exited ({child.returncode}); see {home / 'daemon.log'}")
        current = hello(sock)
        if current:
            compatible(current)
            if current["pid"] != child.pid:
                raise RuntimeError("Another daemon claimed the endpoint; inspect status before proceeding")
            return current
        time.sleep(0.05)
    raise RuntimeError(f"Daemon is not ready; inspect {home / 'daemon.log'} before retrying")


def restart(home, data, sock, daemon):
    current = hello(sock)
    if current is None:
        return start(home, data, sock, daemon)
    compatible(current)
    # The daemon closes admission, checks Agents/Git jobs, and publishes its ticket
    # before acknowledging. This is never replaced with SIGTERM or a PID-only kill.
    rpc(sock, {"op": "runtime.prepare_restart", "boot_id": current["boot_id"]})
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            with locked(data, "writer.lock"):
                break
        except RuntimeError:
            time.sleep(0.05)
    else:
        raise RuntimeError("Old daemon did not release its writer lock; replacement was not forced")
    new = start(home, data, sock, daemon)
    if new["boot_id"] == current["boot_id"] or new["runtime_instance"] != current["runtime_instance"]:
        raise RuntimeError("Replacement did not preserve runtime identity; inspect status")
    return new


def wait_unlocked(data, name):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            with locked(data, name):
                return
        except RuntimeError:
            time.sleep(0.05)
    raise RuntimeError(f"Previous process did not release {name}; replacement was not forced")


def replace_supervisor(home, data, sock, daemon):
    current = hello(sock) or start(home, data, sock, daemon)
    # v2 has the same fenced shutdown contract; only explicit replacement may
    # cross this boundary. Ordinary start/restart still require exact protocols.
    if current.get("application_protocol") != APPLICATION_PROTOCOL or current.get("runtime_protocol") not in ("ade-runtime-v2", "ade-runtime-v3", "ade-runtime-v4", "ade-runtime-v5", "ade-runtime-v6", "ade-runtime-v7", RUNTIME_PROTOCOL):
        compatible(current)
    runtime_socket = current["runtime_socket"]
    instance = current["runtime_instance"]
    rpc(sock, {"op": "runtime.prepare_restart", "boot_id": current["boot_id"]})
    wait_unlocked(data, "writer.lock")
    # Writer-lock release can precede the supervisor observing owner EOF.
    deadline = time.monotonic() + 5
    while True:
        try:
            rpc(runtime_socket, {"op": "runtime.stop", "instance_id": instance, "stop_active": True})
            break
        except RuntimeError as error:
            if "Disconnect the application daemon" not in str(error) or time.monotonic() >= deadline:
                raise
            time.sleep(0.05)
    wait_unlocked(data, "runtime.lock")
    return start(home, data, sock, daemon)


def inspect(home, data, sock, daemon):
    current = hello(sock)
    result = {"data_directory": str(data), "socket": str(sock), "daemon": None,
              "daemon_update": None, "supervisor_update": None}
    if current:
        compatible(current)
        result["daemon"] = rpc(sock, {"op": "runtime.status"})
        running = rpc(current["runtime_socket"], {"op": "hello"})
        for key, installed, binary in [("daemon_update", current.get("build_id"), daemon),
                                      ("supervisor_update", running.get("build_id"), daemon.with_name("ade-runtime"))]:
            if installed and binary.is_file():
                result[key] = installed != build_identity(binary)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["locate", "status", "start", "restart", "replace-supervisor", "adopt"])
    parser.add_argument("--home", type=Path, default=Path(os.environ.get("ADE_RUNTIME_HOME", DEFAULT_HOME)))
    parser.add_argument("--daemon", type=Path, default=DEFAULT_DAEMON)
    parser.add_argument("--data-dir", type=Path, help="Original data directory to adopt in place")
    parser.add_argument("--stop-active", action="store_true", help="Allow supervisor replacement to end live shells and Agents")
    parser.add_argument("--client", type=Path, help="Launch this client after start/restart")
    args = parser.parse_args()
    home = args.home.expanduser().resolve()
    if args.action == "locate":
        print(json.dumps({"socket": str(endpoint(home))}))
        return
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    sock = endpoint(home)
    with locked(home, "launch.lock"):
        if args.action == "adopt":
            if args.data_dir is None:
                parser.error("adopt requires --data-dir")
            if (home / "runtime.json").exists():
                existing = binding(home)
                if existing != args.data_dir.resolve():
                    raise RuntimeError(f"Stable runtime already uses {existing}; use a separate --home to select another store")
            data = save_binding(home, args.data_dir)
            print(json.dumps({"data_directory": str(data), "socket": str(sock), "copied": False}))
            return
        data = binding(home, create=args.action == "start")
        if os.environ.get("ADE_DATA_DIR") and Path(os.environ["ADE_DATA_DIR"]).resolve() != data:
            raise RuntimeError("This client uses a different data directory from the launch profile; select its ADE_RUNTIME_HOME before recovery")
        existing = hello(sock)
        if existing:
            if existing.get("application_protocol") != APPLICATION_PROTOCOL:
                compatible(existing)
            runtime_socket = existing.get("runtime_socket")
            if not isinstance(runtime_socket, str):
                raise RuntimeError("Running daemon omitted its runtime endpoint; it was left running")
            identity = rpc(runtime_socket, {"op":"hello"})
            if Path(identity["data_directory"]).resolve() != data:
                raise RuntimeError("Running supervisor belongs to a different data directory; recovery refused")
        if args.action == "status":
            print(json.dumps(inspect(home, data, sock, args.daemon.resolve()), indent=2))
            return
        if args.action == "replace-supervisor" and not args.stop_active:
            raise RuntimeError("Supervisor replacement ends live shells and Agents; --stop-active is required")
        operation = {"restart": restart, "replace-supervisor": replace_supervisor}.get(args.action, start)
        value = operation(home, data, sock, args.daemon.resolve(strict=True))
        print(json.dumps({"data_directory": str(data), "socket": str(sock), "daemon": value}), flush=True)
    if args.client:
        env = {**os.environ, "ADE_SOCKET": str(sock), "ADE_DATA_DIR": str(data), "ADE_RUNTIME_HOME": str(home)}
        os.execve(args.client.resolve(strict=True), [str(args.client.resolve())], env)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, sqlite3.Error, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
