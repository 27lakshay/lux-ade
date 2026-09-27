//! Native backend snapshots. This format intentionally excludes browser state,
//! credentials, external projects and running processes.
use super::{
    Lock, Profile, Registry, find_profile, private_dir, private_write, profile_path, profile_view,
    save_registry,
};
use anyhow::{Context, Result, bail, ensure};
use rusqlite::{
    Connection, OpenFlags,
    backup::{Backup, StepResult},
    params,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    ffi::CString,
    fs::{self, File},
    os::unix::{
        ffi::OsStrExt,
        fs::{MetadataExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

const FILES: &[(&str, &str, i64)] = &[
    ("sessions.sqlite", "sqlite", 17),
    ("sessions.review.sqlite3", "sqlite", 0),
    ("sessions.worktrees/lifecycle.sqlite3", "sqlite", 4),
    ("sessions.worktrees/empty.toml", "manifest", 0),
];
const EXCLUDED: &[&str] = &[
    "browser sessions, tabs, cookies and pending sends",
    "provider-native homes and credentials",
    "external projects, repositories and worktrees",
    "service routes, logs, owner locks, sockets and processes",
];

fn directory(path: &Path) -> Result<()> {
    ensure!(
        fs::symlink_metadata(path)?.file_type().is_dir(),
        "Directory is redirected: {}",
        path.display()
    );
    Ok(())
}
fn regular(path: &Path) -> Result<()> {
    ensure!(
        fs::symlink_metadata(path)?.file_type().is_file(),
        "File is redirected: {}",
        path.display()
    );
    Ok(())
}
fn sync(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}
fn hash(path: &Path) -> Result<Value> {
    regular(path)?;
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let size = std::io::copy(&mut file, &mut hash)?;
    let digest = hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(json!({"size":size,"sha256":digest}))
}
fn schema(path: &Path, name: &str) -> Result<i64> {
    regular(path)?;
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let version: i64 = db.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let expected = FILES
        .iter()
        .find(|(entry, _, _)| *entry == name)
        .context("Unknown database")?
        .2;
    // A versioned database may also be one schema behind; the daemon migrates it
    // when it opens. How much further back restore reaches is decision D15.
    ensure!(
        version == expected || (expected > 0 && version == expected - 1),
        "Unsupported {name} schema version {version}"
    );
    let check: String = db.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    ensure!(check == "ok", "Invalid SQLite database: {name}");
    Ok(version)
}
fn no_replace(from: &Path, to: &Path) -> Result<()> {
    let from = CString::new(from.as_os_str().as_bytes())?;
    let to = CString::new(to.as_os_str().as_bytes())?;
    #[cfg(target_os = "macos")]
    let result = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    ensure!(
        result == 0,
        "Publish failed: {}",
        std::io::Error::last_os_error()
    );
    Ok(())
}
fn stage(parent: &Path) -> Result<PathBuf> {
    directory(parent)?;
    let path = parent.join(format!(".ade-stage-{}", Uuid::new_v4()));
    fs::create_dir(&path)?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
    Ok(path)
}
fn snapshot(source: &Path, target: &Path, name: &str) -> Result<Value> {
    let expected = FILES
        .iter()
        .find(|(entry, _, _)| *entry == name)
        .context("Unknown backup file")?;
    let actual = if expected.1 == "sqlite" {
        schema(source, name)?;
        let reader = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut writer = Connection::open(target)?;
        {
            let copy = Backup::new(&reader, &mut writer)?;
            let deadline = Instant::now() + Duration::from_secs(30);
            loop {
                match copy.step(128)? {
                    StepResult::Done => break,
                    StepResult::More | StepResult::Busy | StepResult::Locked => {
                        ensure!(Instant::now() < deadline, "Online backup timed out");
                        thread::sleep(Duration::from_millis(25));
                    }
                    _ => bail!("Unsupported SQLite backup state"),
                }
            }
        }
        drop(writer);
        sync(target)?;
        Some(schema(target, name)?)
    } else {
        regular(source)?;
        ensure!(
            fs::metadata(source)?.len() <= 1024 * 1024,
            "Manifest exceeds 1 MiB"
        );
        fs::copy(source, target)?;
        sync(target)?;
        None
    };
    let mut info = hash(target)?;
    info["path"] = json!(name);
    info["kind"] = json!(expected.1);
    if let Some(version) = actual {
        info["schema"] = json!(version);
    }
    Ok(info)
}
fn create(source: &Path, output: &Path) -> Result<Value> {
    directory(source)?;
    ensure!(
        source.join("sessions.sqlite").exists(),
        "Profile database does not exist"
    );
    let parent = output.parent().context("Backup has no parent")?;
    directory(parent)?;
    ensure!(
        !output.exists() && !output.is_symlink(),
        "Backup destination already exists"
    );
    let temporary = stage(parent)?;
    let result = (|| -> Result<Value> {
        let mut entries = Vec::new();
        for (name, _, _) in FILES {
            let source_file = source.join(name);
            if !source_file.exists() && !source_file.is_symlink() {
                continue;
            }
            directory(source_file.parent().unwrap())?;
            let target = temporary.join(name);
            private_dir(target.parent().unwrap())?;
            entries.push(snapshot(&source_file, &target, name)?);
        }
        let manifest = json!({"format_version":2,"scope":"backend-snapshot-only",
            "entries":entries,"excluded":EXCLUDED});
        private_write(
            &temporary.join("manifest.json"),
            &serde_json::to_vec(&manifest)?,
        )?;
        if temporary.join("sessions.worktrees").exists() {
            sync(&temporary.join("sessions.worktrees"))?;
        }
        sync(&temporary)?;
        no_replace(&temporary, output)?;
        sync(parent)?;
        Ok(manifest)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&temporary);
    }
    result
}
fn validate(source: &Path) -> Result<Value> {
    directory(source)?;
    let marker = source.join("manifest.json");
    regular(&marker)?;
    ensure!(
        fs::metadata(&marker)?.len() <= 1024 * 1024,
        "Backup manifest exceeds 1 MiB"
    );
    let value: Value = serde_json::from_slice(&fs::read(marker)?)?;
    ensure!(
        value["format_version"] == 2
            && value["scope"] == "backend-snapshot-only"
            && value["excluded"] == json!(EXCLUDED),
        "Unsupported backend backup format or scope"
    );
    let entries = value["entries"]
        .as_array()
        .context("Invalid backup entries")?;
    let mut seen = std::collections::BTreeSet::new();
    for entry in entries {
        let name = entry["path"].as_str().context("Invalid backup path")?;
        let expected = FILES
            .iter()
            .find(|(path, _, _)| *path == name)
            .context("Unknown backup path")?;
        ensure!(
            seen.insert(name) && entry["kind"] == expected.1,
            "Duplicate or invalid backup entry"
        );
        let path = source.join(name);
        directory(path.parent().unwrap())?;
        let observed = hash(&path)?;
        ensure!(
            entry["size"] == observed["size"] && entry["sha256"] == observed["sha256"],
            "Backup file failed verification: {name}"
        );
        if expected.1 == "sqlite" {
            ensure!(
                entry["schema"] == schema(&path, name)?,
                "Backup schema changed"
            );
        } else {
            ensure!(
                entry["schema"].is_null()
                    && entry["size"].as_u64().unwrap_or(u64::MAX) <= 1024 * 1024,
                "Invalid manifest entry"
            );
        }
    }
    ensure!(
        seen.contains("sessions.sqlite"),
        "Backup lacks its profile database"
    );
    Ok(value)
}

fn rewrite(
    db: &Connection,
    table: &str,
    mut change: impl FnMut(&str, &mut Value) -> Result<()>,
) -> Result<()> {
    let mut query = db.prepare(&format!("SELECT id,data FROM {table}"))?;
    let rows = query
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(query);
    for (id, data) in rows {
        let mut value: Value = serde_json::from_str(&data)?;
        change(&id, &mut value)?;
        db.execute(
            &format!("UPDATE {table} SET data=?1 WHERE id=?2"),
            params![value.to_string(), id],
        )?;
    }
    Ok(())
}
fn fence(data: &Path, final_data: &Path) -> Result<()> {
    let core = data.join("sessions.sqlite");
    let mut db = Connection::open(&core)?;
    db.pragma_update(None, "journal_mode", "DELETE")?;
    let tx = db.transaction()?;
    ensure!(tx.execute("UPDATE restore_fence SET worktree_lifecycle_needs_rebind=1,restored_from_backup=1 WHERE id=1", [])? == 1,
        "Backup restore fence marker is missing");
    tx.execute(
        "UPDATE send_intents SET restore_hold=1 WHERE state IN ('pending','rejected')",
        [],
    )?;
    for table in ["repositories", "workspaces"] {
        rewrite(&tx, table, |_id, record| {
            record["needs_rebind"] = json!(true);
            record["worktree_lifecycle_needs_rebind"] = json!(true);
            Ok(())
        })?;
    }
    rewrite(&tx, "accounts", |id, record| {
        ensure!(
            id.starts_with("account_") && Uuid::parse_str(&id[8..]).is_ok(),
            "Invalid account identity"
        );
        let home = data.join("provider-accounts").join(id);
        private_dir(&home)?;
        if record["provider"] == "codex" {
            private_write(
                &home.join("config.toml"),
                b"cli_auth_credentials_store = \"file\"\n",
            )?;
        }
        record["native_home"] = json!(final_data.join("provider-accounts").join(id));
        record["state"] = json!("unverified");
        record["generation"] = json!(record["generation"].as_i64().unwrap_or(0) + 1);
        for key in ["claude_identity", "codex_identity", "omp_identity"] {
            record[key] = Value::Null;
        }
        Ok(())
    })?;
    tx.commit()?;
    drop(db);
    sync(&core)?;
    let lifecycle = data.join("sessions.worktrees/lifecycle.sqlite3");
    if lifecycle.exists() {
        let mut db = Connection::open(&lifecycle)?;
        db.pragma_update(None, "journal_mode", "DELETE")?;
        let tx = db.transaction()?;
        rewrite(&tx, "repositories", |_id, record| {
            record["needs_rebind"] = json!(true);
            Ok(())
        })?;
        tx.execute("DELETE FROM owned", [])?;
        // Schema 4 keeps the lifecycle ledger in `jobs` and gives `operations` to
        // receipts, which the daemon reconciles when it opens. Schema 3 kept the
        // ledger in `operations`.
        let version: i64 = tx.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        let ledger = if version >= 4 { "jobs" } else { "operations" };
        rewrite(&tx, ledger, |_id, record| {
            if record["status"] == "running" {
                record["status"] = json!("interrupted");
                record["code"] = json!("restored_without_runtime_owner");
                record["error"] = json!("Source-profile lifecycle work was not resumed by restore");
            }
            Ok(())
        })?;
        tx.commit()?;
        drop(db);
        sync(&lifecycle)?;
    }
    schema(&core, "sessions.sqlite")?;
    Ok(())
}
fn restore(source: &Path, target: &Path, final_data: &Path) -> Result<Value> {
    let manifest = validate(source)?;
    let parent = target.parent().context("Restore target has no parent")?;
    directory(parent)?;
    ensure!(
        !target.exists() && !target.is_symlink(),
        "Restore target already exists; it was left unchanged"
    );
    let temporary = stage(parent)?;
    let result = (|| -> Result<()> {
        for entry in manifest["entries"].as_array().unwrap() {
            let name = entry["path"].as_str().unwrap();
            let output = temporary.join(name);
            private_dir(output.parent().unwrap())?;
            fs::copy(source.join(name), &output)?;
            fs::set_permissions(&output, fs::Permissions::from_mode(0o600))?;
            let observed = hash(&output)?;
            ensure!(
                observed["size"] == entry["size"] && observed["sha256"] == entry["sha256"],
                "Backup changed while restoring: {name}"
            );
            sync(&output)?;
        }
        fence(&temporary, final_data)?;
        for nested in [
            temporary.join("provider-accounts"),
            temporary.join("sessions.worktrees"),
        ] {
            if nested.exists() {
                sync(&nested)?;
            }
        }
        sync(&temporary)?;
        no_replace(&temporary, target)?;
        sync(parent)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&temporary);
    }
    result?;
    Ok(manifest)
}
fn option(args: &[String], key: &str) -> Result<PathBuf> {
    let index = args
        .iter()
        .position(|item| item == key)
        .with_context(|| format!("Missing {key}"))?;
    Ok(PathBuf::from(
        args.get(index + 1).context("Missing option value")?,
    ))
}
pub(super) fn command(args: &[String]) -> Result<Value> {
    match args.first().map(String::as_str) {
        Some("create") => {
            let source = option(args, "--data-dir")?;
            let out = option(args, "--out")?;
            Ok(json!({"type":"backup","path":out,"manifest":create(&source,&out)?}))
        }
        Some("inspect") => {
            let bundle = option(args, "--backup")?;
            Ok(json!({"type":"backup","path":bundle,"manifest":validate(&bundle)?}))
        }
        Some("restore") => {
            let bundle = option(args, "--backup")?;
            let data = option(args, "--data-dir")?;
            Ok(json!({"type":"restored","path":data,"manifest":restore(&bundle,&data,&data)?}))
        }
        _ => bail!("Unknown backup action"),
    }
}

fn registered_bundle(bundle: &Path) -> Result<Value> {
    directory(bundle)?;
    let marker = bundle.join("manifest.json");
    regular(&marker)?;
    ensure!(
        fs::metadata(&marker)?.len() <= 1024 * 1024,
        "Profile backup manifest exceeds 1 MiB"
    );
    let value: Value = serde_json::from_slice(&fs::read(marker)?)?;
    ensure!(
        value["format_version"] == 2 && value["scope"] == "profile-backend-only",
        "Unsupported registered backend bundle"
    );
    let source_id = value["source_profile_id"]
        .as_str()
        .context("Missing source profile ID")?;
    Uuid::parse_str(source_id)?;
    ensure!(
        value["source_private_workspace"]
            .as_str()
            .is_some_and(|path| Path::new(path).is_absolute()),
        "Invalid source private workspace"
    );
    let backend = bundle.join("backend");
    ensure!(
        hash(&backend.join("manifest.json"))?["sha256"] == value["backend_manifest_sha256"],
        "Registered backend manifest changed"
    );
    validate(&backend)?;
    Ok(value)
}
fn profile_backup(home: &Path, item: &Profile, output: &Path) -> Result<Value> {
    let path = profile_path(home, &item.id)?;
    let runtime = path.join("runtime");
    let _lock = Lock::acquire(&runtime.join("launch.lock"), true)?;
    let data = runtime.join("data");
    directory(&data)?;
    let parent = output.parent().context("Backup has no parent")?;
    directory(parent)?;
    ensure!(
        !output.exists() && !output.is_symlink(),
        "Backup destination already exists"
    );
    let temporary = stage(parent)?;
    let result = (|| -> Result<Value> {
        let backend = temporary.join("backend");
        create(&data, &backend)?;
        let manifest = json!({"format_version":2,"scope":"profile-backend-only",
            "source_profile_id":item.id,"source_profile_name":item.name,
            "source_private_workspace":path.join("workspace"),
            "backend_manifest_sha256":hash(&backend.join("manifest.json"))?["sha256"]});
        private_write(
            &temporary.join("manifest.json"),
            &serde_json::to_vec(&manifest)?,
        )?;
        sync(&temporary)?;
        no_replace(&temporary, output)?;
        sync(parent)?;
        Ok(json!({"type":"profile_backend_backup","path":output,"manifest":manifest}))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&temporary);
    }
    result
}
fn remap_private(
    data: &Path,
    source: &Path,
    staged_target: &Path,
    final_target: &Path,
) -> Result<()> {
    let mut db = Connection::open(data.join("sessions.sqlite"))?;
    let tx = db.transaction()?;
    let metadata = fs::metadata(staged_target)?;
    let mut query = tx.prepare("SELECT id,data FROM workspaces WHERE root=?1")?;
    let rows = query
        .query_map([source.to_string_lossy().as_ref()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(query);
    for (id, data) in rows {
        let mut record: Value = serde_json::from_str(&data)?;
        ensure!(
            record["repository_id"].is_null(),
            "Private workspace is linked to a repository"
        );
        record["root"] = json!(final_target);
        record["needs_rebind"] = json!(false);
        record["worktree_lifecycle_needs_rebind"] = json!(false);
        tx.execute(
            "UPDATE workspaces SET root=?1,data=?2 WHERE id=?3",
            params![
                final_target.to_string_lossy().as_ref(),
                record.to_string(),
                id
            ],
        )?;
        ensure!(
            tx.execute(
                "UPDATE path_bindings SET device=?1,inode=?2 WHERE kind='workspace' AND id=?3",
                params![metadata.dev().to_string(), metadata.ino().to_string(), id]
            )? == 1,
            "Restored private workspace has no path binding"
        );
    }
    tx.commit()?;
    Ok(())
}
fn pending(home: &Path, value: &Registry) -> Result<Vec<Value>> {
    let profiles = home.join("profiles");
    if !profiles.exists() {
        return Ok(Vec::new());
    }
    directory(&profiles)?;
    let known = value
        .profiles
        .iter()
        .map(|item| item.id.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let mut result = Vec::new();
    for entry in fs::read_dir(profiles)? {
        let entry = entry?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if known.contains(id.as_str()) || Uuid::parse_str(&id).is_err() {
            continue;
        }
        let marker = entry.path().join("restore-intent.json");
        if directory(&entry.path()).is_err() || regular(&marker).is_err() {
            continue;
        }
        if let Ok(intent) = serde_json::from_slice::<Value>(&fs::read(marker)?)
            && intent["format_version"] == 2
            && intent["id"] == id
            && intent["source_profile_id"]
                .as_str()
                .is_some_and(|source| Uuid::parse_str(source).is_ok())
            && intent["name"]
                .as_str()
                .is_some_and(|name| !name.trim().is_empty() && name.len() <= 80)
        {
            result.push(json!({"id":id,"name":intent["name"],"source_profile_id":intent["source_profile_id"]}));
        }
    }
    Ok(result)
}
fn resume(home: &Path, value: &mut Registry, id: &str) -> Result<Value> {
    Uuid::parse_str(id)?;
    let item = pending(home, value)?
        .into_iter()
        .find(|item| item["id"] == id)
        .context("No validated unpublished profile restore has that identity")?;
    let path = profile_path(home, id)?;
    for part in [
        path.clone(),
        path.join("workspace"),
        path.join("runtime"),
        path.join("runtime/data"),
    ] {
        directory(&part)?;
    }
    let data = path.join("runtime/data");
    let binding = path.join("runtime/runtime.json");
    regular(&binding)?;
    let bound: Value = serde_json::from_slice(&fs::read(binding)?)?;
    ensure!(
        bound
            == json!({"format_version":2,"runtime_home":path.join("runtime"),
        "data_directory":data}),
        "Unpublished runtime binding is invalid"
    );
    schema(&data.join("sessions.sqlite"), "sessions.sqlite")?;
    for name in [
        "sessions.review.sqlite3",
        "sessions.worktrees/lifecycle.sqlite3",
    ] {
        let candidate = data.join(name);
        if candidate.exists() || candidate.is_symlink() {
            schema(&candidate, name)?;
        }
    }
    let db = Connection::open_with_flags(
        data.join("sessions.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let fence: (i64, i64) = db.query_row(
        "SELECT worktree_lifecycle_needs_rebind,restored_from_backup FROM restore_fence WHERE id=1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    ensure!(fence == (1, 1), "Unpublished profile has no restore fence");
    let mut accounts = db.prepare("SELECT id,data FROM accounts")?;
    for row in accounts.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        let (account_id, encoded) = row?;
        let account: Value = serde_json::from_str(&encoded)?;
        ensure!(
            account["state"] == "unverified"
                && account["native_home"]
                    == json!(data.join("provider-accounts").join(&account_id)),
            "Unpublished account is not isolated"
        );
        directory(&data.join("provider-accounts").join(account_id))?;
    }
    for table in ["repositories", "workspaces"] {
        let mut statement = db.prepare(&format!("SELECT root,data FROM {table}"))?;
        for row in statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (root, encoded) = row?;
            let record: Value = serde_json::from_str(&encoded)?;
            let private = table == "workspaces" && root == path.join("workspace").to_string_lossy();
            ensure!(
                record["root"] == root && record["needs_rebind"] == !private,
                "Unpublished {table} lost its restore fence"
            );
        }
    }
    let lifecycle = data.join("sessions.worktrees/lifecycle.sqlite3");
    if lifecycle.exists() {
        let db = Connection::open_with_flags(&lifecycle, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut statement = db.prepare("SELECT data FROM repositories")?;
        for row in statement.query_map([], |row| row.get::<_, String>(0))? {
            let record: Value = serde_json::from_str(&row?)?;
            ensure!(
                record["needs_rebind"] == true,
                "Unpublished lifecycle repository lost its restore fence"
            );
        }
        let owned: i64 = db.query_row("SELECT COUNT(*) FROM owned", [], |row| row.get(0))?;
        ensure!(owned == 0, "Unpublished lifecycle has active ownership");
    }
    let profile = Profile {
        id: id.into(),
        name: item["name"].as_str().unwrap().into(),
    };
    value.profiles.push(profile.clone());
    save_registry(home, value)?;
    Ok(
        json!({"type":"profile_backend_restored","profile":profile_view(home,&profile,value.selected_id.as_deref())?,
        "scope":"profile-backend-only","source_profile_id":item["source_profile_id"]}),
    )
}
fn profile_restore(home: &Path, value: &mut Registry, bundle: &Path, name: &str) -> Result<Value> {
    ensure!(
        !name.trim().is_empty() && name.chars().count() <= 80,
        "Profile name must contain 1 to 80 characters"
    );
    let source = registered_bundle(bundle)?;
    let profiles = home.join("profiles");
    private_dir(&profiles)?;
    let id = Uuid::new_v4().to_string();
    let final_path = profile_path(home, &id)?;
    let temporary = stage(&profiles)?;
    let mut published = false;
    let result = (|| -> Result<Value> {
        let runtime = temporary.join("runtime");
        private_dir(&runtime)?;
        let workspace = temporary.join("workspace");
        private_dir(&workspace)?;
        let data = runtime.join("data");
        restore(
            &bundle.join("backend"),
            &data,
            &final_path.join("runtime/data"),
        )?;
        remap_private(
            &data,
            Path::new(source["source_private_workspace"].as_str().unwrap()),
            &workspace,
            &final_path.join("workspace"),
        )?;
        private_write(
            &runtime.join("runtime.json"),
            &serde_json::to_vec(&json!({
                "format_version":2,"runtime_home":final_path.join("runtime"),
                "data_directory":final_path.join("runtime/data")
            }))?,
        )?;
        let intent = json!({"format_version":2,"id":id,"name":name.trim(),
            "source_profile_id":source["source_profile_id"]});
        private_write(
            &temporary.join("restore-intent.json"),
            &serde_json::to_vec(&intent)?,
        )?;
        sync(&runtime)?;
        sync(&temporary)?;
        no_replace(&temporary, &final_path)?;
        published = true;
        sync(&profiles)?;
        if let (Ok(signal), Ok(release)) = (
            std::env::var("ADE_E2E_RESTORE_PUBLISHED_SIGNAL"),
            std::env::var("ADE_E2E_RESTORE_PUBLISHED_RELEASE"),
        ) {
            fs::write(signal, &id)?;
            let deadline = Instant::now() + Duration::from_secs(10);
            while !Path::new(&release).exists() {
                ensure!(
                    Instant::now() < deadline,
                    "Backend restore pause timed out; resume unpublished profile"
                );
                thread::sleep(Duration::from_millis(10));
            }
        }
        resume(home, value, &id)
    })();
    if result.is_err() && !published {
        let _ = fs::remove_dir_all(&temporary);
    }
    result
}
pub(super) fn profile_command(
    home: &Path,
    value: &mut Registry,
    action: &str,
    args: &[String],
) -> Result<Value> {
    match action {
        "backup-backend" => {
            let output = option(args, "--out")?;
            let item = find_profile(
                value,
                args.last()
                    .filter(|arg| !arg.starts_with("--") && Path::new(arg) != output)
                    .map(String::as_str),
            )?;
            profile_backup(home, item, &output)
        }
        "restore-backend" => {
            let bundle = option(args, "--backup")?;
            let index = args
                .iter()
                .position(|item| item == "--name")
                .context("Missing --name")?;
            profile_restore(
                home,
                value,
                &bundle,
                args.get(index + 1).context("Missing name")?,
            )
        }
        "pending-restores" => {
            Ok(json!({"type":"pending_restores","profiles":pending(home,value)?}))
        }
        "resume-restore" => resume(home, value, args.first().context("Missing profile ID")?),
        _ => bail!("Unknown profile backup action"),
    }
}
