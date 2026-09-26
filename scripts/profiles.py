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
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
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


def write_private_json(path, value):
    with path.open("x", encoding="utf-8") as stream:
        os.chmod(path, 0o600)
        json.dump(value, stream, separators=(",", ":"), sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def inspect_backend_bundle(bundle):
    managed_backup.directory(bundle)
    marker = bundle / "manifest.json"
    managed_backup.regular(marker, 1024 * 1024)
    manifest = managed_backup.strict_json(marker.read_bytes())
    if (not isinstance(manifest, dict) or manifest.get("format_version") != 1
            or manifest.get("scope") != "profile-backend-only"):
        raise RuntimeError("Unsupported registered backend bundle; registry was left unchanged")
    source_id = manifest.get("source_profile_id")
    source_private = manifest.get("source_private_workspace")
    if (not isinstance(source_id, str) or str(uuid.UUID(source_id)) != source_id
            or not isinstance(source_private, str) or not Path(source_private).is_absolute()):
        raise RuntimeError("Invalid source profile identity or private workspace")
    backend = bundle / "backend"
    managed_backup.directory(backend)
    backend_marker = backend / "manifest.json"
    managed_backup.regular(backend_marker, 1024 * 1024)
    observed = hashlib.sha256(backend_marker.read_bytes()).hexdigest()
    if manifest.get("backend_manifest_sha256") != observed:
        raise RuntimeError("Registered backend manifest changed; registry was left unchanged")
    snapshot = managed_backup.validate(backend)
    core = next(entry for entry in snapshot["entries"] if entry["path"] == "sessions.sqlite")
    if core["schema"] < 12:
        raise RuntimeError("Restore requires a schema-12 backend with an execution fence")
    return manifest


def retarget_restored_store(database, staged_data, final_data, source_private, target_private):
    connection = sqlite3.connect(database)
    try:
        connection.execute("PRAGMA journal_mode=DELETE")
        connection.execute("BEGIN IMMEDIATE")
        schema = connection.execute("PRAGMA user_version").fetchone()[0]
        private_identity = (staged_data.parent.parent / "workspace").stat()
        for account_id, encoded in connection.execute("SELECT id,data FROM accounts").fetchall():
            record = managed_backup.strict_json(encoded)
            expected = str(staged_data / "provider-accounts" / account_id)
            if record.get("native_home") != expected:
                raise RuntimeError("Restored account home does not match its staged profile")
            record["native_home"] = str(final_data / "provider-accounts" / account_id)
            connection.execute("UPDATE accounts SET data=? WHERE id=?", (json.dumps(record, separators=(",", ":")), account_id))
        for workspace_id, indexed_root, encoded in connection.execute(
                "SELECT id,root,data FROM workspaces WHERE root=?", (source_private,)).fetchall():
            record = managed_backup.strict_json(encoded)
            if (record.get("root") != indexed_root or record.get("repository_id") is not None
                    or record.get("needs_rebind") is not True):
                raise RuntimeError("Source private workspace cannot be safely remapped")
            record["root"] = str(target_private)
            record["needs_rebind"] = False
            record["worktree_lifecycle_needs_rebind"] = False
            connection.execute("UPDATE workspaces SET root=?,data=? WHERE id=?",
                (str(target_private), json.dumps(record, separators=(",", ":")), workspace_id))
            if schema >= 14:
                if connection.execute("UPDATE path_bindings SET device=?,inode=? WHERE kind='workspace' AND id=?",
                        (str(private_identity.st_dev), str(private_identity.st_ino), workspace_id)).rowcount != 1:
                    raise RuntimeError("Restored private workspace has no source identity")
            elif schema == 13:
                connection.execute("INSERT OR REPLACE INTO path_bindings(kind,id,device,inode) VALUES('workspace',?,?,?)",
                    (workspace_id, str(private_identity.st_dev), str(private_identity.st_ino)))
        connection.commit()
    finally:
        connection.close()
    managed_backup.sync_file(database)
    managed_backup.database_check(database, "sessions.sqlite")


def restore_backend_profile(home, value, bundle, name):
    name = name.strip()
    if not name or len(name) > 80:
        raise RuntimeError("Profile name must contain 1 to 80 characters")
    bundle = bundle.expanduser().absolute()
    source = inspect_backend_bundle(bundle)
    profiles = home / "profiles"
    profiles.mkdir(mode=0o700, exist_ok=True)
    managed_backup.directory(profiles)
    profile_id = str(uuid.uuid4())
    final = profile_path(home, profile_id)
    stage = Path(tempfile.mkdtemp(prefix=f".restore-{profile_id}-", dir=profiles))
    os.chmod(stage, 0o700)
    published = False
    try:
        runtime_home = stage / "runtime"
        runtime_home.mkdir(mode=0o700)
        (stage / "workspace").mkdir(mode=0o700)
        staged_data = runtime_home / "data"
        final_data = final / "runtime" / "data"
        managed_backup.restore(bundle / "backend", staged_data)
        retarget_restored_store(staged_data / "sessions.sqlite", staged_data, final_data,
                                source["source_private_workspace"], final / "workspace")
        write_private_json(runtime_home / "runtime.json",
                           {"format_version": 1, "data_directory": str(final_data)})
        write_private_json(stage / "restore-intent.json", {"format_version": 1,
            "scope": "profile-backend-only", "id": profile_id, "name": name,
            "source_profile_id": source["source_profile_id"],
            "backend_manifest_sha256": source["backend_manifest_sha256"]})
        for path in (staged_data, runtime_home, stage):
            managed_backup.sync_dir(path)
        managed_backup.rename_no_replace(stage, final)
        published = True
        managed_backup.sync_dir(profiles)
        signal = os.environ.get("ADE_E2E_RESTORE_PUBLISHED_SIGNAL")
        release = os.environ.get("ADE_E2E_RESTORE_PUBLISHED_RELEASE")
        if signal or release:
            if (not signal or not release or not Path(signal).is_absolute()
                    or not Path(release).is_absolute()):
                raise RuntimeError("Invalid backend restore E2E pause paths")
            Path(signal).write_text(profile_id)
            deadline = time.monotonic() + 10
            while not Path(release).exists():
                if time.monotonic() >= deadline:
                    raise RuntimeError("Backend restore E2E pause timed out; resume the unpublished profile")
                time.sleep(0.01)
        item = {"id": profile_id, "name": name}
        value["profiles"].append(item)
        write_registry(home, value)
        return {"type": "profile_backend_restored", "profile": profile_result(home, item, value["selected_id"]),
                "scope": "profile-backend-only", "source_profile_id": source["source_profile_id"]}
    finally:
        if not published and stage.exists():
            shutil.rmtree(stage)


def pending_restores(home, value):
    profiles = home / "profiles"
    if not profiles.exists():
        return []
    managed_backup.directory(profiles)
    registered = {item["id"] for item in value["profiles"]}
    pending = []
    for child in profiles.iterdir():
        if child.name in registered or child.name.startswith("."):
            continue
        try:
            profile_id = str(uuid.UUID(child.name))
            if profile_id != child.name:
                continue
            managed_backup.directory(child)
            marker = child / "restore-intent.json"
            managed_backup.regular(marker, 1024 * 1024)
            record = managed_backup.strict_json(marker.read_bytes())
            name = record.get("name")
            source_id = record.get("source_profile_id")
            if (record.get("format_version") == 1 and record.get("id") == profile_id
                    and record.get("scope") == "profile-backend-only"
                    and isinstance(name, str) and 1 <= len(name.strip()) <= 80
                    and isinstance(source_id, str) and str(uuid.UUID(source_id)) == source_id):
                pending.append({"id": profile_id, "name": record.get("name"), "source_profile_id": record.get("source_profile_id")})
        except (OSError, ValueError, AttributeError):
            continue
    return pending


def resume_restore(home, value, profile_id):
    pending = next((item for item in pending_restores(home, value) if item["id"] == profile_id), None)
    if pending is None or not isinstance(pending["name"], str) or not pending["name"]:
        raise RuntimeError("No validated unpublished profile restore has that identity")
    directory = profile_path(home, profile_id)
    for path in (directory, directory / "runtime", directory / "workspace"):
        managed_backup.directory(path)
    binding = directory / "runtime" / "runtime.json"
    managed_backup.regular(binding, 1024 * 1024)
    binding_data = managed_backup.strict_json(binding.read_bytes())
    data = directory / "runtime" / "data"
    if binding_data != {"format_version": 1, "data_directory": str(data)}:
        raise RuntimeError("Unpublished profile binding is invalid; registry was left unchanged")
    managed_backup.directory(data)
    accounts = data / "provider-accounts"
    if accounts.exists() or accounts.is_symlink():
        managed_backup.directory(accounts)
    database = data / "sessions.sqlite"
    schema = managed_backup.database_check(database, "sessions.sqlite")
    if schema not in (12, 13, 14, 15, 16):
        raise RuntimeError("Unpublished profile schema is unsupported; registry was left unchanged")
    with contextlib.closing(sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True)) as connection:
        marker = connection.execute("SELECT worktree_lifecycle_needs_rebind,restored_from_backup FROM restore_fence WHERE id=1").fetchone()
        if marker != (1, 1):
            raise RuntimeError("Unpublished profile has no restore fence; registry was left unchanged")
        for account_id, encoded in connection.execute("SELECT id,data FROM accounts"):
            account = managed_backup.strict_json(encoded)
            if account.get("native_home") != str(data / "provider-accounts" / account_id) or account.get("state") != "unverified":
                raise RuntimeError("Unpublished account binding is invalid; registry was left unchanged")
            managed_backup.directory(accounts / account_id)
        for table in ("repositories", "workspaces"):
            for record_id, indexed_root, encoded in connection.execute(f"SELECT id,root,data FROM {table}"):
                record = managed_backup.strict_json(encoded)
                if record.get("root") != indexed_root:
                    raise RuntimeError(f"Unpublished {table} root is inconsistent: {record_id}")
                private = table == "workspaces" and indexed_root == str(directory / "workspace")
                if record.get("needs_rebind") is not (not private):
                    raise RuntimeError(f"Unpublished {table} lost its restore fence: {record_id}")
                if private and schema >= 13:
                    identity = (directory / "workspace").stat()
                    binding = connection.execute("SELECT device,inode FROM path_bindings WHERE kind='workspace' AND id=?",
                                                 (record_id,)).fetchone()
                    if binding != (str(identity.st_dev), str(identity.st_ino)):
                        raise RuntimeError("Unpublished private workspace identity changed; registry was left unchanged")
    lifecycle = data / "sessions.worktrees" / "lifecycle.sqlite3"
    review = data / "sessions.review.sqlite3"
    if review.exists() or review.is_symlink():
        managed_backup.database_check(review, "sessions.review.sqlite3")
    if lifecycle.parent.exists() or lifecycle.parent.is_symlink():
        managed_backup.directory(lifecycle.parent)
    if lifecycle.exists() or lifecycle.is_symlink():
        managed_backup.database_check(lifecycle, "sessions.worktrees/lifecycle.sqlite3")
        with contextlib.closing(sqlite3.connect(f"{lifecycle.as_uri()}?mode=ro", uri=True)) as connection:
            for repository_id, encoded in connection.execute("SELECT id,data FROM repositories"):
                if managed_backup.strict_json(encoded).get("needs_rebind") is not True:
                    raise RuntimeError(f"Unpublished lifecycle repository lost its restore fence: {repository_id}")
    item = {"id": profile_id, "name": pending["name"]}
    value["profiles"].append(item)
    write_registry(home, value)
    return {"type": "profile_backend_restored", "profile": profile_result(home, item, value["selected_id"]),
            "scope": "profile-backend-only", "source_profile_id": pending["source_profile_id"]}


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
    restore = actions.add_parser("restore-backend", help="Restore a backend bundle into a new unselected profile")
    restore.add_argument("--backup", type=Path, required=True)
    restore.add_argument("--name", required=True)
    actions.add_parser("pending-restores", help="List unpublished backend restores after interrupted registry publication")
    resume = actions.add_parser("resume-restore", help="Publish a validated interrupted backend restore")
    resume.add_argument("id")
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
        elif args.action == "restore-backend":
            output = restore_backend_profile(home, value, args.backup, args.name)
        elif args.action == "pending-restores":
            output = {"type": "pending_restores", "profiles": pending_restores(home, value)}
        elif args.action == "resume-restore":
            output = resume_restore(home, value, args.id)
        else:
            item = find_profile(value, args.id)
            output = {"type": "profile_started", **run_start(home, item, args.daemon, value["selected_id"])}
    print(json.dumps(output))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, sqlite3.Error, subprocess.TimeoutExpired) as error:
        print(json.dumps({"type": "error", "message": str(error)}), file=sys.stderr)
        sys.exit(1)
