#!/usr/bin/env python3
"""Snapshot the currently managed backend files; browser and native data need a later owner.

This is a backend backup building block, not a complete ADE profile backup. It
uses SQLite's online backup API so a running daemon can keep writing. Each
database is independently consistent; there is no cross-process snapshot
barrier for the daemon, runtime, and Electron yet.
"""

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import sys
import tempfile
import re
import time


FORMAT = 1
EXCLUSIONS = [
    "Electron browser sessions, tab metadata and cookies",
    "Electron pending-send journal and window identity",
    "Provider-native account homes and credentials",
    "External repositories, worktrees and files",
    "Stable service proxy routes and their daemon socket and port claims",
    "Source-profile Worktrunk ownership and active lifecycle claims",
    "Service and terminal output logs, diagnostics and private plugin files",
    "Runtime owner locks, sockets and live processes",
]
LIMITATIONS = [
    "SQLite databases have separate snapshot times and no shared ADE revision",
    "Stable service routes must be re-created explicitly after restore",
    "Running agent, terminal and service processes are not restored",
]
DATABASES = {
    "sessions.sqlite": (1, 17),
    "sessions.review.sqlite3": (0, 0),
    "sessions.worktrees/lifecycle.sqlite3": (1, 3),
}
MANIFESTS = {
    "sessions.worktrees/empty.toml": 1024 * 1024,
}
ALLOWED = set(DATABASES) | set(MANIFESTS)


def fail(message):
    raise ValueError(message)


def directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        fail(f"Directory is redirected or invalid: {path}")


def regular(path, maximum=None):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        fail(f"File is redirected or invalid: {path}")
    if maximum is not None and info.st_size > maximum:
        fail(f"File exceeds backup limit: {path}")
    return info


def strict_json(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                fail(f"Duplicate JSON key: {key}")
            result[key] = value
        return result

    return json.loads(data, object_pairs_hook=unique)


def sync_dir(path):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def sync_file(path):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def rename_no_replace(source, destination):
    """Publish a directory without ever replacing a concurrently-created name."""
    libc = ctypes.CDLL(None, use_errno=True)
    old = os.fsencode(source)
    new = os.fsencode(destination)
    if sys.platform == "darwin":
        rename = getattr(libc, "renamex_np", None)
        if rename is None:
            fail("Atomic no-clobber directory publication is unavailable")
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        result = rename(old, new, 0x4)  # RENAME_EXCL
    elif sys.platform.startswith("linux"):
        rename = getattr(libc, "renameat2", None)
        if rename is None:
            fail("Atomic no-clobber directory publication is unavailable")
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        result = rename(-100, old, -100, new, 1)  # AT_FDCWD, RENAME_NOREPLACE
    else:
        fail("Atomic no-clobber directory publication is unavailable on this platform")
    if result != 0:
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number), str(destination))


def digest(path):
    hasher = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            hasher.update(block)
            size += len(block)
    return {"sha256": hasher.hexdigest(), "size": size}


def database_check(path, kind):
    regular(path)
    connection = sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True)
    try:
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        low, high = DATABASES[kind]
        if not isinstance(version, int) or not low <= version <= high:
            fail(f"Unsupported {kind} schema version {version}; source and target were left unchanged")
        if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            fail(f"Invalid SQLite database: {kind}")
        if kind == "sessions.sqlite" and version >= 6:
            query = ("SELECT id,metadata,length(data),generation,state FROM attachments"
                     if version >= 11 else "SELECT id,metadata,length(data),NULL,'live' FROM attachments")
            for attachment_id, metadata, length, generation, state in connection.execute(query):
                value = strict_json(metadata)
                if value.get("id") != attachment_id or state not in ("live", "discarded"):
                    fail(f"Attachment record is invalid: {attachment_id}")
                if version >= 11 and (not isinstance(generation, str) or not generation):
                    fail(f"Attachment generation is invalid: {attachment_id}")
                if (state == "live" and value.get("size") != length) or (state == "discarded" and length != 0):
                    fail(f"Attachment payload is incomplete: {attachment_id}")
        return version
    finally:
        connection.close()


def snapshot_database(source, target):
    regular(source)
    reader = sqlite3.connect(f"{source.as_uri()}?mode=ro", uri=True, timeout=30)
    writer = sqlite3.connect(target)
    try:
        signal = os.environ.get("ADE_E2E_BACKUP_PAUSE_SIGNAL") if source.name == "sessions.sqlite" else None
        release = os.environ.get("ADE_E2E_BACKUP_PAUSE_RELEASE") if signal else None
        paused = False

        def progress(_status, remaining, _total):
            nonlocal paused
            if paused or not signal or not release or remaining <= 0:
                return
            if not os.path.isabs(signal) or not os.path.isabs(release):
                fail("Backup test pause paths must be absolute")
            paused = True
            Path(signal).write_text("sqlite-backup-active\n")
            deadline = time.monotonic() + 10
            while not Path(release).exists():
                if time.monotonic() >= deadline:
                    fail("Backup test pause timed out")
                time.sleep(0.01)

        reader.backup(writer, pages=1 if signal else 128, progress=progress, sleep=0.025)
        writer.commit()
    finally:
        writer.close()
        reader.close()
    sync_file(target)


def copy_manifest(source, target, maximum):
    regular(source, maximum)
    # A mutable runtime registry may be replaced while copying. Refuse an
    # unstable read instead of publishing a mixed file.
    for _ in range(3):
        before = regular(source, maximum)
        data = source.read_bytes()
        after = regular(source, maximum)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) == (
            after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns
        ) and len(data) == before.st_size:
            if source.name.endswith(".json"):
                strict_json(data)
            target.write_bytes(data)
            sync_file(target)
            return
    fail(f"Managed manifest changed during backup: {source}")


def add_entry(stage, source, name, entries):
    target = stage / name
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if name in DATABASES:
        snapshot_database(source, target)
        version = database_check(target, name)
        entries.append({"path": name, "kind": "sqlite", "schema": version, **digest(target)})
    else:
        copy_manifest(source, target, MANIFESTS[name])
        entries.append({"path": name, "kind": "manifest", **digest(target)})


def create(source, output):
    directory(source)
    directory(output.parent)
    if output.exists() or output.is_symlink():
        fail("Backup destination already exists; it was left unchanged")
    if not (source / "sessions.sqlite").exists():
        fail("Profile database does not exist")
    stage = Path(tempfile.mkdtemp(prefix=f".{output.name}.stage-", dir=output.parent))
    os.chmod(stage, 0o700)
    try:
        entries = []
        for name in sorted(ALLOWED):
            item = source / name
            if not item.exists() and not item.is_symlink():
                if name == "sessions.sqlite":
                    fail("Profile database does not exist")
                continue
            if item.parent != source:
                directory(item.parent)
            add_entry(stage, item, name, entries)
        manifest = {
            "format_version": FORMAT,
            "scope": "backend-snapshot-only",
            "consistency": "each-sqlite-database-independently-consistent",
            "entries": entries,
            "excluded": EXCLUSIONS,
            "limitations": LIMITATIONS,
        }
        manifest_path = stage / "manifest.json"
        with manifest_path.open("x", encoding="utf-8") as stream:
            os.chmod(manifest_path, 0o600)
            json.dump(manifest, stream, separators=(",", ":"), sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        for nested in (stage / "sessions.worktrees", stage):
            if nested.exists():
                sync_dir(nested)
        if output.exists() or output.is_symlink():
            fail("Backup destination appeared during snapshot; it was left unchanged")
        rename_no_replace(stage, output)
        sync_dir(output.parent)
        return manifest
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def validate(backup):
    directory(backup)
    manifest_path = backup / "manifest.json"
    regular(manifest_path, 1024 * 1024)
    manifest = strict_json(manifest_path.read_bytes())
    if not isinstance(manifest, dict) or manifest.get("format_version") != FORMAT:
        fail("Unsupported backup format; target was left unchanged")
    if manifest.get("scope") != "backend-snapshot-only" or manifest.get("consistency") != "each-sqlite-database-independently-consistent":
        fail("Unsupported backup scope; target was left unchanged")
    if not isinstance(manifest.get("entries"), list):
        fail("Invalid backup entries")
    entries = manifest["entries"]
    names = []
    for entry in entries:
        if not isinstance(entry, dict):
            fail("Invalid backup entry")
        name = entry.get("path")
        if not isinstance(name, str) or name not in ALLOWED or name in names:
            fail("Unknown or duplicate backup path")
        names.append(name)
        if entry.get("kind") != ("sqlite" if name in DATABASES else "manifest"):
            fail("Invalid backup entry kind")
        item = backup / name
        if item.parent != backup:
            directory(item.parent)
        regular(item, MANIFESTS.get(name))
        observed = digest(item)
        if type(entry.get("size")) is not int or entry.get("size") != observed["size"] or entry.get("sha256") != observed["sha256"]:
            fail(f"Backup file failed verification: {name}")
        if name in DATABASES:
            actual_version = database_check(item, name)
            if type(entry.get("schema")) is not int or entry.get("schema") != actual_version:
                fail(f"Backup database version changed: {name}")
        elif name.endswith(".json"):
            strict_json(item.read_bytes())
    if "sessions.sqlite" not in names:
        fail("Backup lacks its profile database")
    if manifest.get("excluded") != EXCLUSIONS:
        fail("Backup exclusion declaration is unsupported")
    if manifest.get("limitations") != LIMITATIONS:
        fail("Backup limitation declaration is unsupported")
    return manifest


def restore(backup, target):
    manifest = validate(backup)
    core = next(entry for entry in manifest["entries"] if entry["path"] == "sessions.sqlite")
    if core["schema"] < 12:
        fail("Restore requires a schema-12 backup with an execution fence; target was left unchanged")
    directory(target.parent)
    if target.exists() or target.is_symlink():
        fail("Restore target must not exist; it was left unchanged")
    # All archive data and target preconditions have been checked before this
    # point. Stage beside the target so publication is one rename.
    stage = Path(tempfile.mkdtemp(prefix=f".{target.name}.restore-", dir=target.parent))
    os.chmod(stage, 0o700)
    try:
        for entry in manifest["entries"]:
            name = entry["path"]
            destination = stage / name
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            shutil.copyfile(backup / name, destination)
            os.chmod(destination, 0o600)
            sync_file(destination)
            if digest(destination) != {"sha256": entry["sha256"], "size": entry["size"]}:
                fail(f"Backup file changed while restoring: {name}")
        # Metadata records account identities, but native credentials are
        # intentionally absent. Provide empty private homes for public reads;
        # account verification must happen separately before provider use.
        connection = sqlite3.connect(stage / "sessions.sqlite")
        try:
            connection.execute("PRAGMA journal_mode=DELETE")
            if database_check(stage / "sessions.sqlite", "sessions.sqlite") >= 9:
                accounts = connection.execute("SELECT id,data FROM accounts").fetchall()
                for account_id, encoded in accounts:
                    if not isinstance(account_id, str) or not re.fullmatch(
                        r"account_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", account_id
                    ):
                        fail("Backup account identity is invalid")
                    native = stage / "provider-accounts" / account_id
                    (stage / "provider-accounts").mkdir(mode=0o700, exist_ok=True)
                    os.chmod(stage / "provider-accounts", 0o700)
                    native.mkdir(parents=True, exist_ok=False, mode=0o700)
                    value = strict_json(encoded)
                    if value.get("provider") == "codex":
                        config = native / "config.toml"
                        descriptor = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
                        with os.fdopen(descriptor, "wb") as stream:
                            stream.write(b'cli_auth_credentials_store = "file"\n')
                            stream.flush()
                            os.fsync(stream.fileno())
                        sync_dir(native)
                    value["native_home"] = str(target / "provider-accounts" / account_id)
                    value["state"] = "unverified"
                    value["generation"] = int(value.get("generation", 0)) + 1
                    value["claude_identity"] = None
                    value["codex_identity"] = None
                    value["omp_identity"] = None
                    connection.execute("UPDATE accounts SET data=? WHERE id=?", (json.dumps(value, separators=(",", ":")), account_id))
                connection.commit()
            # The snapshot keeps absolute source paths for readable history. A
            # restored daemon must not execute against those paths, even when
            # the source checkout is still mounted on this machine.
            connection.execute("BEGIN IMMEDIATE")
            if connection.execute(
                "UPDATE restore_fence SET worktree_lifecycle_needs_rebind=1,restored_from_backup=1 WHERE id=1"
            ).rowcount != 1:
                fail("Backup restore fence marker is missing")
            connection.execute("UPDATE send_intents SET restore_hold=1 WHERE state IN ('pending','rejected')")
            for table in ("repositories", "workspaces"):
                for record_id, encoded in connection.execute(f"SELECT id,data FROM {table}").fetchall():
                    record = strict_json(encoded)
                    if not isinstance(record, dict):
                        fail(f"Backup {table} record is invalid: {record_id}")
                    record["needs_rebind"] = True
                    record["worktree_lifecycle_needs_rebind"] = True
                    connection.execute(f"UPDATE {table} SET data=? WHERE id=?",
                        (json.dumps(record, separators=(",", ":")), record_id))
            connection.commit()
        finally:
            connection.close()
        sync_file(stage / "sessions.sqlite")
        database_check(stage / "sessions.sqlite", "sessions.sqlite")
        lifecycle = stage / "sessions.worktrees" / "lifecycle.sqlite3"
        if lifecycle.exists():
            connection = sqlite3.connect(lifecycle)
            try:
                connection.execute("PRAGMA journal_mode=DELETE")
                connection.execute("BEGIN IMMEDIATE")
                for repository_id, encoded in connection.execute("SELECT id,data FROM repositories").fetchall():
                    record = strict_json(encoded)
                    if not isinstance(record, dict):
                        fail(f"Backup lifecycle repository is invalid: {repository_id}")
                    record["needs_rebind"] = True
                    connection.execute("UPDATE repositories SET data=? WHERE id=?",
                        (json.dumps(record, separators=(",", ":")), repository_id))
                connection.execute("DELETE FROM owned")
                for operation_id, encoded in connection.execute("SELECT id,data FROM operations").fetchall():
                    record = strict_json(encoded)
                    if record.get("status") == "running":
                        record["status"] = "interrupted"
                        record["error"] = "Source-profile lifecycle work was not resumed by restore; inspect the original repository"
                        record["code"] = "restored_without_runtime_owner"
                        record["recovery"] = "inspect_repository_before_retry"
                        record["finished_at"] = int(time.time() * 1000)
                        connection.execute("UPDATE operations SET data=? WHERE id=?",
                            (json.dumps(record, separators=(",", ":")), operation_id))
                connection.commit()
            finally:
                connection.close()
            sync_file(lifecycle)
            database_check(lifecycle, "sessions.worktrees/lifecycle.sqlite3")
        for nested in (stage / "provider-accounts", stage / "sessions.worktrees", stage):
            if nested.exists():
                sync_dir(nested)
        rename_no_replace(stage, target)
        sync_dir(target.parent)
        return manifest
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="operation", required=True)
    backup = commands.add_parser("create", help="Create an independently consistent backend snapshot")
    backup.add_argument("--data-dir", required=True, type=Path)
    backup.add_argument("--out", required=True, type=Path)
    inspect = commands.add_parser("inspect", help="Verify a backend snapshot")
    inspect.add_argument("--backup", required=True, type=Path)
    recovery = commands.add_parser("restore", help="Restore to a new offline data directory that does not exist")
    recovery.add_argument("--backup", required=True, type=Path)
    recovery.add_argument("--data-dir", required=True, type=Path)
    args = parser.parse_args()
    try:
        if args.operation == "create":
            result = create(args.data_dir.expanduser().absolute(), args.out.expanduser().absolute())
        elif args.operation == "inspect":
            result = validate(args.backup.expanduser().absolute())
        else:
            result = restore(args.backup.expanduser().absolute(), args.data_dir.expanduser().absolute())
        print(json.dumps({"type": "managed_backup", "operation": args.operation, "manifest": result}, separators=(",", ":")))
    except (OSError, ValueError, sqlite3.Error, json.JSONDecodeError) as error:
        print(json.dumps({"type": "error", "message": str(error)}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
