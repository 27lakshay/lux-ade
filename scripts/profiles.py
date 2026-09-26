#!/usr/bin/env python3
"""Create and select independent local ADE profiles; start them only on demand."""

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid

import managed_backup


SCRIPT = Path(__file__).resolve()
RUNTIME = SCRIPT.with_name("runtime.py")
DEFAULT_HOME = Path.home() / "Library/Application Support/lux-ade/profiles"


@contextlib.contextmanager
def locked(home):
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(home, 0o700)
    with (home / "registry.lock").open("a+b") as handle:
        os.chmod(handle.name, 0o600)
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def read_registry(home):
    filename = home / "registry.json"
    if not filename.exists():
        return {"format_version": 1, "selected_id": None, "profiles": []}
    value = json.loads(filename.read_text())
    if (not isinstance(value, dict) or value.get("format_version") != 1
            or not isinstance(value.get("profiles"), list)):
        raise RuntimeError("Unsupported profile registry; it was left unchanged")
    profiles = value["profiles"]
    if any(not isinstance(item, dict) or not isinstance(item.get("id"), str)
           or not isinstance(item.get("name"), str) for item in profiles):
        raise RuntimeError("Invalid profile registry; it was left unchanged")
    ids = [item["id"] for item in profiles]
    if len(ids) != len(set(ids)) or value.get("selected_id") not in (None, *ids):
        raise RuntimeError("Invalid profile identities; registry was left unchanged")
    return value


def write_registry(home, value):
    descriptor, temporary = tempfile.mkstemp(prefix="registry-", dir=home)
    try:
        with os.fdopen(descriptor, "w") as writer:
            os.fchmod(writer.fileno(), 0o600)
            json.dump(value, writer, separators=(",", ":"))
            writer.write("\n")
            writer.flush()
            os.fsync(writer.fileno())
        os.replace(temporary, home / "registry.json")
        directory = os.open(home, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(temporary).unlink(missing_ok=True)


def profile_path(home, profile_id):
    # Registry IDs are UUIDs, not user-supplied directory names.
    return home / "profiles" / str(uuid.UUID(profile_id))


def profile_result(home, item, selected_id):
    profile_id = item["id"]
    return {"id": profile_id, "name": item["name"],
            "selected": profile_id == selected_id,
            "home": str(profile_path(home, profile_id) / "runtime")}


def find_profile(value, profile_id):
    chosen = profile_id or value["selected_id"]
    if chosen is None:
        raise RuntimeError("No profile is selected; create or select a profile first")
    item = next((entry for entry in value["profiles"] if entry["id"] == chosen), None)
    if item is None:
        raise RuntimeError("Profile ID is not registered on this host")
    return item


def run_start(home, item, daemon, selected_id):
    directory = profile_path(home, item["id"])
    runtime_home = directory / "runtime"
    workspace_root = directory / "workspace"
    workspace_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    environment = dict(os.environ)
    for name in ("ADE_SOCKET", "ADE_DATA_DIR", "ADE_RUNTIME_HOME"):
        environment.pop(name, None)
    if SCRIPT.parent.name == "Resources" and SCRIPT.parent.parent.name == "Contents":
        environment.pop("ADE_ROOT", None)
        environment["ADE_WORKSPACE_SELECTION"] = "1"
    else:
        environment["ADE_ROOT"] = str(workspace_root)
    command = [sys.executable, str(RUNTIME), "start", "--home", str(runtime_home)]
    if daemon is not None:
        command.extend(["--daemon", str(daemon)])
    result = subprocess.run(command, env=environment, capture_output=True, text=True, timeout=25)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "Profile daemon could not start")
    launch = json.loads(result.stdout)
    return {"profile": profile_result(home, item, selected_id),
            "socket": launch["socket"], "daemon": launch["daemon"]}


def backup_backend(home, item, output):
    """Capture the registered backend with source identity for a later full restore."""
    profile_directory = profile_path(home, item["id"])
    runtime_home = profile_directory / "runtime"
    binding = runtime_home / "runtime.json"
    if not runtime_home.is_dir():
        raise RuntimeError("Profile has no durable runtime binding to back up")
    # The runtime launcher uses this same lock around adoption and startup.
    # Keep the binding pinned while the daemon continues ordinary SQLite writes.
    with (runtime_home / "launch.lock").open("a+b") as runtime_lock:
        os.chmod(runtime_lock.name, 0o600)
        fcntl.flock(runtime_lock, fcntl.LOCK_EX)
        try:
            info = binding.lstat()
        except FileNotFoundError:
            raise RuntimeError("Profile has no durable runtime binding to back up") from None
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise RuntimeError("Profile runtime binding is redirected; preserve it for review")
        binding_bytes = binding.read_bytes()
        value = managed_backup.strict_json(binding_bytes)
        if (not isinstance(value, dict) or value.get("format_version") != 1
                or not isinstance(value.get("data_directory"), str)
                or not Path(value["data_directory"]).is_absolute()):
            raise RuntimeError("Profile runtime binding is invalid; preserve it for review")
        source_data = Path(value["data_directory"]).resolve(strict=True)
        output = output.expanduser().absolute()
        managed_backup.directory(output.parent)
        resolved_output = output.resolve(strict=False)
        if resolved_output.is_relative_to(profile_directory.resolve()) or resolved_output.is_relative_to(source_data):
            raise RuntimeError("Profile backup destination must be outside the source profile and data directory")
        if output.exists() or output.is_symlink():
            raise RuntimeError("Profile backup destination already exists; it was left unchanged")
        stage = Path(tempfile.mkdtemp(prefix=f".{output.name}.stage-", dir=output.parent))
        os.chmod(stage, 0o700)
        try:
            backend = managed_backup.create(source_data, stage / "backend")
            after = binding.lstat()
            if ((info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns) !=
                    (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
                    or binding.read_bytes() != binding_bytes):
                raise RuntimeError("Profile runtime binding changed during backup; no bundle was published")
            backend_manifest = (stage / "backend" / "manifest.json").read_bytes()
            manifest = {
                "format_version": 1,
                "scope": "profile-backend-only",
                "source_profile_id": item["id"],
                "source_profile_name": item["name"],
                "source_runtime_home": str(runtime_home.resolve()),
                "source_private_workspace": str((profile_directory / "workspace").resolve()),
                "source_data_directory": str(source_data),
                "backend_manifest_sha256": hashlib.sha256(backend_manifest).hexdigest(),
                "backend_scope": backend["scope"],
                "excluded": ["Electron browser session storage and tab metadata",
                             "Electron pending-send journal and window identity",
                             "Profile registry and runtime owner state", *backend["excluded"]],
            }
            marker = stage / "manifest.json"
            with marker.open("x", encoding="utf-8") as stream:
                os.chmod(marker, 0o600)
                json.dump(manifest, stream, separators=(",", ":"), sort_keys=True)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            managed_backup.sync_dir(stage)
            managed_backup.rename_no_replace(stage, output)
            try:
                managed_backup.sync_dir(output.parent)
            except OSError as error:
                raise RuntimeError(
                    f"Profile backup was published at {output}, but directory sync failed; "
                    f"durability is unconfirmed: {error}"
                ) from error
            return {"type": "profile_backend_backup", "path": str(output), "manifest": manifest}
        finally:
            if stage.exists():
                shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=Path(os.environ.get("ADE_PROFILES_HOME", DEFAULT_HOME)))
    parser.add_argument("--daemon", type=Path, help="ADE daemon binary for profile start")
    actions = parser.add_subparsers(dest="action", required=True)
    create = actions.add_parser("create", help="Create a profile without starting its daemon")
    create.add_argument("name")
    actions.add_parser("list", help="List stable profile identities")
    actions.add_parser("current", help="Inspect the selected profile")
    select = actions.add_parser("select", help="Change the default profile without affecting running work")
    select.add_argument("id")
    start = actions.add_parser("start", help="Start or attach to a compatible profile daemon")
    start.add_argument("id", nargs="?", help="Profile ID; selected profile by default")
    backup = actions.add_parser("backup-backend", help="Capture a registered backend; excludes Electron-owned state")
    backup.add_argument("--out", type=Path, required=True)
    backup.add_argument("id", nargs="?", help="Profile ID; selected profile by default")
    args = parser.parse_args()
    home = args.home.expanduser().resolve()
    with locked(home):
        value = read_registry(home)
        if args.action == "create":
            name = args.name.strip()
            if not name or len(name) > 80:
                raise RuntimeError("Profile name must contain 1 to 80 characters")
            profile_id = str(uuid.uuid4())
            profile_path(home, profile_id).mkdir(parents=True, mode=0o700)
            item = {"id": profile_id, "name": name}
            value["profiles"].append(item)
            if value["selected_id"] is None:
                value["selected_id"] = profile_id
            write_registry(home, value)
            output = {"type": "profile", "profile": profile_result(home, item, value["selected_id"])}
        elif args.action == "list":
            output = {"type": "profiles", "selected_id": value["selected_id"],
                      "profiles": [profile_result(home, item, value["selected_id"])
                                   for item in value["profiles"]]}
        elif args.action == "current":
            item = find_profile(value, None)
            output = {"type": "profile", "profile": profile_result(home, item, value["selected_id"])}
        elif args.action == "select":
            item = find_profile(value, args.id)
            value["selected_id"] = item["id"]
            write_registry(home, value)
            output = {"type": "profile", "profile": profile_result(home, item, value["selected_id"])}
        elif args.action == "backup-backend":
            item = find_profile(value, args.id)
            output = backup_backend(home, item, args.out)
        else:
            item = find_profile(value, args.id)
            output = {"type": "profile_started", **run_start(home, item, args.daemon, value["selected_id"])}
    print(json.dumps(output))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(json.dumps({"type": "error", "message": str(error)}), file=sys.stderr)
        sys.exit(1)
