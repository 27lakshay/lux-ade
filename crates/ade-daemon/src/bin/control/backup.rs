//! Native backend snapshots. This format intentionally excludes browser sessions,
//! credentials, external projects and running processes. [`coverage`] lists
//! every profile store and whether a backup copies, rebuilds or excludes it.
use super::{
    Lock, Profile, Registry, find_profile, private_dir, private_write, profile_path, profile_view,
    save_registry,
};
use anyhow::{Context, Result, anyhow, bail, ensure};
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

mod coverage;
use coverage::{Decision, FileRecord, Kind, Observed, PLUGIN_ARTIFACTS, PLUGINS_DB, Plan, STORES};

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
/// Decides whether a database schema version is readable: only the schema
/// this build uses. Nothing restores an older schema until ADE launches
/// (decision D19).
fn supported_schema(name: &str, version: i64, expected: i64) -> Result<()> {
    ensure!(
        version == expected,
        "Unsupported {name} schema version {version}; this build restores only schema {expected}"
    );
    Ok(())
}
/// Decides whether a restored profile database may bind a fresh runtime home.
/// It needs both restore fence marks and the current schema.
pub(super) fn bind_verdict(version: i64, fence: (i64, i64)) -> Result<()> {
    let current = coverage::store("sessions.sqlite")
        .context("Unknown database")?
        .schema;
    ensure!(
        fence == (1, 1) && version == current,
        "Only a fenced restore of the current schema can bind a fresh runtime home"
    );
    Ok(())
}
fn schema(path: &Path, name: &str) -> Result<i64> {
    regular(path)?;
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let version: i64 = db.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let expected = coverage::store(name)
        .filter(|store| store.kind == Kind::Sqlite)
        .context("Unknown database")?
        .schema;
    supported_schema(name, version, expected)?;
    let check: String = db.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    ensure!(check == "ok", "Invalid SQLite database: {name}");
    if name == "sessions.sqlite" {
        attachments(&db)?;
        skills(&db)?;
    }
    Ok(version)
}
fn tables(db: &Connection) -> Result<Vec<String>> {
    let mut query = db.prepare("SELECT name FROM sqlite_master WHERE type='table'")?;
    let names = query
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(names)
}
fn hex_sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
/// Checks every stored skill bundle has each blob its manifest names, with the
/// recorded digest and size. The skill catalog lives in `sessions.sqlite` and is
/// created on first use, so a profile without it has nothing to check.
fn skills(db: &Connection) -> Result<()> {
    let names = tables(db)?;
    if !names.iter().any(|name| name == "skill_bundles") {
        return Ok(());
    }
    ensure!(
        names.iter().any(|name| name == "skill_blobs"),
        "Skill catalog has no blob table"
    );
    let mut bundles = db.prepare("SELECT name,content_hash,manifest FROM skill_bundles")?;
    let rows = bundles
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut blobs = db.prepare("SELECT path,sha256,data FROM skill_blobs WHERE content_hash=?1")?;
    for (name, content_hash, manifest) in rows {
        let observed = blobs
            .query_map([&content_hash], |row| {
                let data: Vec<u8> = row.get(2)?;
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    hex_sha256(&data),
                    data.len() as u64,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        coverage::skill_verdict(&name, &content_hash, &manifest, &observed)?;
    }
    Ok(())
}
/// Leaves the history search index out of a copied profile database. It is a
/// projection of `messages`: dropping its tables and triggers and zeroing its
/// version makes the daemon rebuild it under a new epoch when it next opens.
/// The copy is compacted so the dropped index takes no space.
fn exclude_projection(path: &Path) -> Result<()> {
    let mut db = Connection::open(path)?;
    db.pragma_update(None, "journal_mode", "DELETE")?;
    let tx = db.transaction()?;
    tx.execute_batch(
        "DROP TRIGGER IF EXISTS history_journal_insert;
         DROP TRIGGER IF EXISTS history_journal_update;
         DROP TRIGGER IF EXISTS history_journal_delete;
         DROP TABLE IF EXISTS history_fts;
         DROP TABLE IF EXISTS history_docs;
         DROP TABLE IF EXISTS history_journal;",
    )?;
    if tables(&tx)?
        .iter()
        .any(|name| name == "history_index_state")
    {
        tx.execute(
            "UPDATE history_index_state SET version=0,applied=0,rebuilding=1,backfill_after=NULL",
            [],
        )?;
    }
    tx.commit()?;
    db.execute_batch("VACUUM")?;
    drop(db);
    sync(path)?;
    projection_excluded(path)
}
/// Replaces every secret service environment value in a copied profile
/// database with the redaction placeholder (D15: a bundle holds no secret).
/// The restored service refuses to start until its secrets are sent again.
fn withhold_secrets(path: &Path) -> Result<()> {
    let mut db = Connection::open(path)?;
    if !tables(&db)?.iter().any(|name| name == "services") {
        return Ok(());
    }
    db.pragma_update(None, "secure_delete", "ON")?;
    let tx = db.transaction()?;
    let rows = {
        let mut query = tx.prepare("SELECT rowid,data FROM services")?;
        query
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (row, data) in rows {
        let mut record: Value =
            serde_json::from_str(&data).context("Profile holds an unreadable service record")?;
        ade_core::services::withhold_secret_values(&mut record)?;
        tx.execute(
            "UPDATE services SET data=?1 WHERE rowid=?2",
            params![record.to_string(), row],
        )?;
    }
    tx.commit()?;
    Ok(())
}
/// Drops every plugin setting that names an item ADE made, as services drop
/// theirs. A bundle then never names an item another profile owns, so a
/// profile restored beside the original cannot reach it; the restored
/// plugin's credential is unset until it is sent again. References the user
/// made stay. Backup applies it to the copy it takes, and restore to the
/// copy it places, which covers a bundle made before this rule.
fn withhold_plugin_credentials(path: &Path) -> Result<()> {
    let mut db = Connection::open(path)?;
    if !tables(&db)?.iter().any(|name| name == "plugin_settings") {
        return Ok(());
    }
    db.pragma_update(None, "secure_delete", "ON")?;
    let tx = db.transaction()?;
    let rows = {
        let mut query = tx.prepare("SELECT rowid,value FROM plugin_settings")?;
        query
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (row, value) in rows {
        if serde_json::from_str::<ade_core::credentials::CredentialReference>(&value)
            .is_ok_and(|reference| reference.ade_owned())
        {
            tx.execute("DELETE FROM plugin_settings WHERE rowid=?1", [row])?;
        }
    }
    tx.commit()?;
    db.execute_batch("VACUUM")?;
    Ok(())
}
/// Refuses a plugin registry that still names an item ADE made.
fn plugin_credentials_withheld(path: &Path) -> Result<()> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    if !tables(&db)?.iter().any(|name| name == "plugin_settings") {
        return Ok(());
    }
    let mut query = db.prepare("SELECT value FROM plugin_settings")?;
    let values = query
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    ensure!(
        !values.iter().any(|value| {
            serde_json::from_str::<ade_core::credentials::CredentialReference>(value)
                .is_ok_and(|reference| reference.ade_owned())
        }),
        "Backup holds a plugin credential reference it declares excluded"
    );
    Ok(())
}
fn secrets_withheld(path: &Path) -> Result<()> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    if !tables(&db)?.iter().any(|name| name == "services") {
        return Ok(());
    }
    let mut query = db.prepare("SELECT data FROM services")?;
    let records = query
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    coverage::secrets_verdict(records.iter().map(String::as_str))
}
fn projection_excluded(path: &Path) -> Result<()> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let names = tables(&db)?;
    let version = if names.iter().any(|name| name == "history_index_state") {
        Some(db.query_row(
            "SELECT COALESCE(MAX(version),0) FROM history_index_state",
            [],
            |row| row.get(0),
        )?)
    } else {
        None
    };
    coverage::projection_verdict(&names, version)
}
/// Checks one attachment row: its metadata names it, a live payload is exactly
/// the declared size, a discarded payload is empty, and it has a generation.
fn attachment_verdict(
    id: &str,
    metadata: &str,
    length: i64,
    generation: &str,
    state: &str,
) -> Result<()> {
    let value: Value = serde_json::from_str(metadata)
        .with_context(|| format!("Attachment record is invalid: {id}"))?;
    ensure!(
        value["id"] == id && matches!(state, "live" | "discarded"),
        "Attachment record is invalid: {id}"
    );
    ensure!(
        !generation.is_empty(),
        "Attachment generation is invalid: {id}"
    );
    let complete = match state {
        "live" => value["size"].as_i64() == Some(length),
        _ => length == 0,
    };
    ensure!(complete, "Attachment payload is incomplete: {id}");
    Ok(())
}
fn attachments(db: &Connection) -> Result<()> {
    let mut query =
        db.prepare("SELECT id,metadata,length(data),generation,state FROM attachments")?;
    let rows = query.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;
    for row in rows {
        let (id, metadata, length, generation, state) = row?;
        attachment_verdict(&id, &metadata, length, &generation, &state)?;
    }
    Ok(())
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
/// A test-only hold on a running online backup of `sessions.sqlite`. After the
/// first page is copied it writes the signal file, then waits up to 10 s for the
/// release file. It exists only in debug builds and only when
/// `ADE_E2E_BACKUP_PAUSE_ENABLED=1` names it; release builds compile it out.
struct Pause {
    signal: PathBuf,
    release: PathBuf,
}
impl Pause {
    fn wait(self) -> Result<()> {
        fs::write(&self.signal, "sqlite-backup-active\n")?;
        let deadline = Instant::now() + Duration::from_secs(10);
        while !self.release.exists() {
            ensure!(Instant::now() < deadline, "Backup test pause timed out");
            thread::sleep(Duration::from_millis(10));
        }
        Ok(())
    }
}
/// Decides whether a backup pause is armed. The build flag and the enable
/// variable must both hold, the database must be `sessions.sqlite`, and both
/// paths must be present and absolute; a half-configured pause is refused.
fn pause_plan(
    compiled: bool,
    enabled: Option<&str>,
    name: &str,
    signal: Option<&str>,
    release: Option<&str>,
) -> Result<Option<Pause>> {
    if !compiled || enabled != Some("1") || name != "sessions.sqlite" {
        return Ok(None);
    }
    let (Some(signal), Some(release)) = (signal, release) else {
        ensure!(
            signal.is_none() && release.is_none(),
            "Backup test pause needs both a signal and a release path"
        );
        return Ok(None);
    };
    let (signal, release) = (PathBuf::from(signal), PathBuf::from(release));
    ensure!(
        signal.is_absolute() && release.is_absolute(),
        "Backup test pause paths must be absolute"
    );
    Ok(Some(Pause { signal, release }))
}
fn test_pause(name: &str) -> Result<Option<Pause>> {
    let read = |key: &str| std::env::var(key).ok();
    pause_plan(
        cfg!(debug_assertions),
        read("ADE_E2E_BACKUP_PAUSE_ENABLED").as_deref(),
        name,
        read("ADE_E2E_BACKUP_PAUSE_SIGNAL").as_deref(),
        read("ADE_E2E_BACKUP_PAUSE_RELEASE").as_deref(),
    )
}
/// Pages per online-backup step. A step of `-1` copies the whole database
/// under one read transaction, so writes from the daemon cannot restart it
/// part-way. Only an armed test pause copies one page at a time, so the copy
/// is still unfinished when the pause holds.
fn step_pages(pause_armed: bool) -> i32 {
    if pause_armed { 1 } else { -1 }
}
/// The time allowed for one online SQLite copy. It grows with the size of the
/// database, so a large profile is not refused by a fixed limit.
fn backup_deadline(bytes: u64) -> Duration {
    const BASE_SECS: u64 = 30;
    // A conservative 8 MiB per second, far below local disk throughput.
    const BYTES_PER_SEC: u64 = 8 * 1024 * 1024;
    Duration::from_secs(BASE_SECS.saturating_add(bytes.div_ceil(BYTES_PER_SEC)))
}
/// The bytes a SQLite database holds on disk, counting its write-ahead log.
fn stored_bytes(path: &Path) -> u64 {
    let size = |path: &Path| fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let mut wal = path.as_os_str().to_owned();
    wal.push("-wal");
    size(path).saturating_add(size(Path::new(&wal)))
}
fn snapshot(source: &Path, target: &Path, name: &str) -> Result<Value> {
    let expected = coverage::store(name)
        .filter(|store| store.kind != Kind::Directory)
        .context("Unknown backup file")?;
    let actual = if expected.kind == Kind::Sqlite {
        schema(source, name)?;
        let reader = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut writer = Connection::open(target)?;
        let mut pause = test_pause(name)?;
        {
            let copy = Backup::new(&reader, &mut writer)?;
            let deadline = Instant::now() + backup_deadline(stored_bytes(source));
            loop {
                let step = copy.step(step_pages(pause.is_some()))?;
                if step == StepResult::More
                    && copy.progress().remaining > 0
                    && let Some(hold) = pause.take()
                {
                    hold.wait()?;
                }
                match step {
                    StepResult::Done => break,
                    // Only the armed test pause copies in parts; the next step
                    // copies the rest at once.
                    StepResult::More => {
                        ensure!(Instant::now() < deadline, "Online backup timed out");
                    }
                    // A writer holds a lock the copy needs; wait briefly.
                    StepResult::Busy | StepResult::Locked => {
                        ensure!(Instant::now() < deadline, "Online backup timed out");
                        thread::sleep(Duration::from_millis(25));
                    }
                    _ => bail!("Unsupported SQLite backup state"),
                }
            }
        }
        // A copy of a WAL database keeps WAL mode; a rollback-journal copy is
        // one self-contained file that the entry's hash covers.
        writer.pragma_update(None, "journal_mode", "DELETE")?;
        drop(writer);
        sync(target)?;
        if name == "sessions.sqlite" {
            // Withhold secrets first: the projection step's VACUUM then
            // rewrites the file, so no freed page keeps an old value.
            withhold_secrets(target)?;
            exclude_projection(target)?;
            secrets_withheld(target)?;
        }
        if name == PLUGINS_DB {
            withhold_plugin_credentials(target)?;
            sync(target)?;
            plugin_credentials_withheld(target)?;
        }
        Some(schema(target, name)?)
    } else {
        regular(source)?;
        ensure!(
            fs::metadata(source)?.len() <= coverage::MAX_MANIFEST_BYTES,
            "Manifest exceeds 1 MiB"
        );
        fs::copy(source, target)?;
        sync(target)?;
        None
    };
    let mut info = hash(target)?;
    info["path"] = json!(name);
    info["kind"] = json!(expected.kind.name());
    if let Some(version) = actual {
        info["schema"] = json!(version);
    }
    Ok(info)
}
fn file_hash(path: &Path) -> Result<(u64, String)> {
    let observed = hash(path)?;
    Ok((
        observed["size"].as_u64().context("Invalid file size")?,
        observed["sha256"]
            .as_str()
            .context("Invalid file digest")?
            .into(),
    ))
}
/// Lists the files of `sessions.plugins/` that a backup takes, relative to
/// `artifacts/`. [`coverage::decide`] rules on every entry.
fn plugin_files(store: &Path) -> Result<Vec<String>> {
    let mut taken = Vec::new();
    let mut pending = vec![(store.to_owned(), String::new())];
    while let Some((folder, prefix)) = pending.pop() {
        for entry in fs::read_dir(&folder)? {
            let entry = entry?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow!("Plugin store has a file name that is not UTF-8"))?;
            let relative = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            let kind = entry.file_type()?;
            let observed = if kind.is_dir() {
                Observed::Directory
            } else if kind.is_file() {
                Observed::File
            } else {
                Observed::Other
            };
            match coverage::decide(&relative, observed)? {
                Decision::Skip => {}
                Decision::Descend => pending.push((entry.path(), relative)),
                Decision::Take => {
                    ensure!(
                        taken.len() < coverage::MAX_DIRECTORY_FILES,
                        "Plugin artifact store holds too many files"
                    );
                    let inside = relative
                        .strip_prefix("artifacts/")
                        .context("Plugin artifact path is invalid")?;
                    taken.push(inside.to_owned());
                }
            }
        }
    }
    taken.sort();
    Ok(taken)
}
/// Creates every directory that `files` needs under `root`, parents first and
/// each private. Returns them deepest first, for syncing.
fn file_directories<'a>(root: &Path, files: impl Iterator<Item = &'a str>) -> Result<Vec<PathBuf>> {
    let mut needed = std::collections::BTreeSet::new();
    for file in files {
        let mut prefix = file;
        while let Some((parent, _)) = prefix.rsplit_once('/') {
            needed.insert(parent.to_owned());
            prefix = parent;
        }
    }
    private_dir(root)?;
    let mut created = vec![root.to_owned()];
    for folder in needed {
        let path = root.join(folder);
        private_dir(&path)?;
        created.push(path);
    }
    created.reverse();
    Ok(created)
}
fn copy_private(from: &Path, to: &Path, executable: bool) -> Result<()> {
    regular(from)?;
    ensure!(
        !to.exists() && !to.is_symlink(),
        "Backup file already exists: {}",
        to.display()
    );
    fs::copy(from, to)?;
    let mode = if executable { 0o700 } else { 0o600 };
    fs::set_permissions(to, fs::Permissions::from_mode(mode))?;
    sync(to)
}
/// Copies the plugin artifact store file by file. Each copy is hashed and the
/// source hashed again afterwards, so a file that changed mid-copy fails the
/// backup instead of entering it.
fn snapshot_directory(source: &Path, target: &Path) -> Result<Vec<FileRecord>> {
    directory(source)?;
    let names = plugin_files(source.parent().context("Plugin store has no parent")?)?;
    let folders = file_directories(target, names.iter().map(String::as_str))?;
    let mut records = Vec::with_capacity(names.len());
    let mut total = 0u64;
    for name in names {
        let from = source.join(&name);
        let to = target.join(&name);
        let executable = fs::symlink_metadata(&from)?.permissions().mode() & 0o100 != 0;
        copy_private(&from, &to, executable)?;
        let (size, sha256) = file_hash(&to)?;
        ensure!(
            file_hash(&from)? == (size, sha256.clone()),
            "Plugin artifact changed during backup; retry: {name}"
        );
        total = total.saturating_add(size);
        ensure!(
            total <= coverage::MAX_DIRECTORY_BYTES,
            "Plugin artifact store exceeds the backup directory limit"
        );
        records.push(FileRecord {
            path: name,
            size,
            sha256,
            executable,
        });
    }
    for path in folders {
        sync(&path)?;
    }
    Ok(records)
}
/// Checks every installed plugin in a copied registry against the copied
/// artifact files. Returns each plugin's ID and its artifact directory
/// relative to the artifact store.
fn plugin_artifacts(database: &Path, files: &[FileRecord]) -> Result<Vec<(String, String)>> {
    let db = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    if !tables(&db)?.iter().any(|name| name == "plugins") {
        return Ok(Vec::new());
    }
    let mut query = db.prepare("SELECT id,artifact_path,artifact_digest FROM plugins")?;
    let rows = query
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(id, path, digest)| {
            let relative = coverage::plugin_verdict(&id, &path, &digest, files)?;
            Ok((id, relative))
        })
        .collect()
}
/// Checks a bundle's copied directory holds exactly the files its entry lists,
/// each a regular file with the recorded size and digest.
fn verify_directory(root: &Path, files: &[FileRecord]) -> Result<()> {
    directory(root)?;
    let mut observed = Vec::new();
    let mut pending = vec![(root.to_owned(), String::new())];
    while let Some((folder, prefix)) = pending.pop() {
        for entry in fs::read_dir(&folder)? {
            let entry = entry?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow!("Backup directory has a file name that is not UTF-8"))?;
            let relative = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            let kind = entry.file_type()?;
            if kind.is_dir() {
                pending.push((entry.path(), relative));
            } else {
                ensure!(
                    kind.is_file() && observed.len() < coverage::MAX_DIRECTORY_FILES,
                    "Backup directory holds an unexpected entry: {relative}"
                );
                observed.push(relative);
            }
        }
    }
    observed.sort();
    ensure!(
        observed.iter().eq(files.iter().map(|file| &file.path)),
        "Backup directory does not match its manifest"
    );
    for file in files {
        ensure!(
            file_hash(&root.join(&file.path))? == (file.size, file.sha256.clone()),
            "Backup file failed verification: {}",
            file.path
        );
    }
    Ok(())
}
/// Refuses a backup destination inside a directory the backup copies. Both
/// paths must already be canonical; a bundle nested in its own source would copy
/// itself on the next backup and move with the profile it protects.
fn outside(destination: &Path, source: &Path) -> Result<()> {
    ensure!(
        !destination.starts_with(source),
        "Backup destination must be outside the profile it copies: {}",
        destination.display()
    );
    Ok(())
}
/// Resolves a destination that does not exist yet through its existing parent.
fn resolved_destination(output: &Path) -> Result<PathBuf> {
    let parent = output.parent().context("Backup has no parent")?;
    let name = output.file_name().context("Backup has no name")?;
    Ok(fs::canonicalize(parent)?.join(name))
}
fn create(source: &Path, output: &Path) -> Result<Value> {
    directory(source)?;
    ensure!(
        source.join("sessions.sqlite").exists(),
        "Profile database does not exist"
    );
    let parent = output.parent().context("Backup has no parent")?;
    directory(parent)?;
    outside(&resolved_destination(output)?, &fs::canonicalize(source)?)?;
    ensure!(
        !output.exists() && !output.is_symlink(),
        "Backup destination already exists"
    );
    let temporary = stage(parent)?;
    let result = (|| -> Result<Value> {
        let mut entries: Vec<Value> = Vec::new();
        for store in STORES {
            let name = store.path;
            let source_file = source.join(name);
            let target = temporary.join(name);
            if store.kind == Kind::Directory {
                // The artifact store is only meaningful beside its registry;
                // without one the daemon discards every artifact when it opens.
                if !entries.iter().any(|entry| entry["path"] == PLUGINS_DB) {
                    continue;
                }
                private_dir(target.parent().unwrap())?;
                let files = if source_file.exists() || source_file.is_symlink() {
                    directory(source_file.parent().unwrap())?;
                    snapshot_directory(&source_file, &target)?
                } else {
                    private_dir(&target)?;
                    Vec::new()
                };
                plugin_artifacts(&temporary.join(PLUGINS_DB), &files)?;
                entries.push(directory_entry(&files));
                continue;
            }
            if !source_file.exists() && !source_file.is_symlink() {
                continue;
            }
            directory(source_file.parent().unwrap())?;
            private_dir(target.parent().unwrap())?;
            entries.push(snapshot(&source_file, &target, name)?);
        }
        let manifest = json!({"format_version":coverage::FORMAT,"scope":coverage::SCOPE,
            "entries":entries,"excluded":coverage::EXCLUDED,"coverage":coverage::coverage()});
        // Prove the bundle reads back before it is published.
        coverage::check_manifest(&manifest)?;
        private_write(
            &temporary.join("manifest.json"),
            &serde_json::to_vec(&manifest)?,
        )?;
        for nested in ["sessions.worktrees", "sessions.plugins"] {
            if temporary.join(nested).exists() {
                sync(&temporary.join(nested))?;
            }
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
fn directory_entry(files: &[FileRecord]) -> Value {
    let total: u64 = files.iter().map(|file| file.size).sum();
    let tree = coverage::tree_digest(
        files
            .iter()
            .map(|file| (file.path.as_str(), file.sha256.as_str())),
    );
    json!({"path":PLUGIN_ARTIFACTS,"kind":Kind::Directory.name(),"size":total,
        "sha256":tree.strip_prefix("sha256:").unwrap_or_default(),
        "files":files.iter().map(FileRecord::to_json).collect::<Vec<_>>()})
}
/// Validates a bundle: [`coverage::check_manifest`] rules on the manifest,
/// then every entry is checked against the files on disk. The bundle must
/// also hold no history index, no secret service value, and a registry whose
/// plugins all have their artifacts and name no credential ADE made.
fn validate(source: &Path) -> Result<(Value, Plan)> {
    directory(source)?;
    let marker = source.join("manifest.json");
    regular(&marker)?;
    ensure!(
        fs::metadata(&marker)?.len() <= coverage::MAX_MANIFEST_BYTES * 64,
        "Backup manifest exceeds 64 MiB"
    );
    let value: Value = serde_json::from_slice(&fs::read(marker)?)?;
    let plan = coverage::check_manifest(&value)?;
    for entry in &plan.entries {
        let name = entry.path.as_str();
        let path = source.join(name);
        directory(path.parent().unwrap())?;
        if entry.kind == Kind::Directory {
            verify_directory(&path, &entry.files)?;
            continue;
        }
        ensure!(
            file_hash(&path)? == (entry.size, entry.sha256.clone()),
            "Backup file failed verification: {name}"
        );
        if entry.kind == Kind::Sqlite {
            ensure!(
                entry.schema == Some(schema(&path, name)?),
                "Backup schema changed"
            );
        }
    }
    projection_excluded(&source.join("sessions.sqlite"))?;
    secrets_withheld(&source.join("sessions.sqlite"))?;
    if plan.has(PLUGINS_DB) {
        plugin_artifacts(&source.join(PLUGINS_DB), plan.artifact_files())?;
        plugin_credentials_withheld(&source.join(PLUGINS_DB))?;
    }
    Ok((value, plan))
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
/// Marks a lifecycle operation that was running in the source profile as
/// interrupted. Restore does not resume it, so the daemon reports that the
/// original repository needs inspection before a retry.
fn interrupt(record: &mut Value, now_ms: i64) {
    if record["status"] == "running" {
        record["status"] = json!("interrupted");
        record["code"] = json!("restored_without_runtime_owner");
        record["error"] = json!(
            "Source-profile lifecycle work was not resumed by restore; inspect the original repository"
        );
        record["recovery"] = json!("inspect_repository_before_retry");
        record["finished_at"] = json!(now_ms);
    }
}
/// Pauses a restored Conversation's prompt queue when prompts wait in it. The
/// source profile may send the same prompts, so the restored daemon sends none
/// until the user continues the queue.
fn hold_queue(record: &mut Value, queued: bool) {
    if !queued {
        return;
    }
    record["queue_paused"] = json!(true);
    if record["error"].is_null() {
        record["error"] = json!(
            "Prompt queue paused: this profile was restored from a backup, and the source profile may also send these prompts. Review them before continuing the queue."
        );
    }
}
/// Clears a restored service's run reservation. The run belongs to the source
/// profile's runtime, which the restored profile never owned, so the restored
/// service starts stopped.
fn release_service(record: &mut Value) {
    if let Some(fields) = record.as_object_mut() {
        fields.insert("terminal_owner".into(), Value::Null);
        fields.remove("launch_peers");
    }
}
fn release_services(db: &Connection) -> Result<()> {
    let mut query = db.prepare("SELECT rowid,data FROM services")?;
    let rows = query
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(query);
    for (row, data) in rows {
        let mut record: Value = serde_json::from_str(&data)?;
        release_service(&mut record);
        db.execute(
            "UPDATE services SET data=?1 WHERE rowid=?2",
            params![record.to_string(), row],
        )?;
    }
    Ok(())
}
fn fence(data: &Path, final_data: &Path, plan: &Plan) -> Result<()> {
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
    // The restored profile never owned the source profile's runtime. Its
    // incarnations and process records would make the restored daemon treat
    // the source's live processes as its own and quarantine their leases.
    let present = tables(&tx)?;
    for table in [
        "runtime_incarnations",
        "runtime_attempt_records",
        "runtime_attempt_descendants",
        "runtime_recovery_reports",
    ] {
        if present.iter().any(|name| name == table) {
            tx.execute(&format!("DELETE FROM {table}"), [])?;
        }
    }
    let queued: std::collections::HashSet<String> = {
        let mut query = tx
            .prepare("SELECT DISTINCT conversation_id FROM queued_prompts WHERE status='queued'")?;
        query
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<_>>()?
    };
    rewrite(&tx, "conversations", |id, record| {
        hold_queue(record, queued.contains(id));
        Ok(())
    })?;
    release_services(&tx)?;
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
        // The daemon refuses every account while the account root is readable
        // by others, and `private_dir` makes only the leaf private.
        private_dir(&data.join("provider-accounts"))?;
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
        // The HostResources registry is host-owned and not in the backup. A
        // stale binding would block the restored profile as "registry
        // replaced", so it binds afresh to the registry on its host.
        if tables(&tx)?
            .iter()
            .any(|name| name == "host_resources_binding")
        {
            tx.execute("DELETE FROM host_resources_binding", [])?;
        }
        // Schema 4 keeps the lifecycle ledger in `jobs` and gives `operations` to
        // receipts, which the daemon reconciles when it opens. Schema 3 kept the
        // ledger in `operations`.
        let version: i64 = tx.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        let ledger = if version >= 4 { "jobs" } else { "operations" };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis();
        let now = i64::try_from(now)?;
        rewrite(&tx, ledger, |_id, record| {
            interrupt(record, now);
            Ok(())
        })?;
        tx.commit()?;
        drop(db);
        sync(&lifecycle)?;
    }
    let plugins = data.join(PLUGINS_DB);
    if plugins.exists() {
        rebase_plugins(&plugins, plan.artifact_files(), final_data)?;
    }
    schema(&core, "sessions.sqlite")?;
    Ok(())
}
/// Points each restored plugin at its artifact in the restored profile. The
/// recorded path names the source profile's data directory; left alone, the
/// restored profile would load another profile's artifacts.
fn rebase_plugins(database: &Path, files: &[FileRecord], final_data: &Path) -> Result<()> {
    let placed = plugin_artifacts(database, files)?;
    withhold_plugin_credentials(database)?;
    let mut db = Connection::open(database)?;
    db.pragma_update(None, "journal_mode", "DELETE")?;
    let tx = db.transaction()?;
    let store = final_data.join(PLUGIN_ARTIFACTS);
    for (id, relative) in placed {
        let path = store.join(relative);
        ensure!(
            tx.execute(
                "UPDATE plugins SET artifact_path=?1 WHERE id=?2",
                params![path.to_string_lossy().as_ref(), id],
            )? == 1,
            "Restored plugin {id} disappeared"
        );
    }
    tx.commit()?;
    drop(db);
    sync(database)?;
    schema(database, PLUGINS_DB)?;
    Ok(())
}
fn restore(source: &Path, target: &Path, final_data: &Path) -> Result<Value> {
    let (manifest, plan) = validate(source)?;
    let parent = target.parent().context("Restore target has no parent")?;
    directory(parent)?;
    ensure!(
        !target.exists() && !target.is_symlink(),
        "Restore target already exists; it was left unchanged"
    );
    let temporary = stage(parent)?;
    let result = (|| -> Result<()> {
        for entry in &plan.entries {
            let name = entry.path.as_str();
            let output = temporary.join(name);
            private_dir(output.parent().unwrap())?;
            if entry.kind == Kind::Directory {
                let folders =
                    file_directories(&output, entry.files.iter().map(|file| file.path.as_str()))?;
                for file in &entry.files {
                    let copied = output.join(&file.path);
                    copy_private(
                        &source.join(name).join(&file.path),
                        &copied,
                        file.executable,
                    )?;
                    ensure!(
                        file_hash(&copied)? == (file.size, file.sha256.clone()),
                        "Backup changed while restoring: {name}/{}",
                        file.path
                    );
                }
                for folder in folders {
                    sync(&folder)?;
                }
                continue;
            }
            copy_private(&source.join(name), &output, false)?;
            ensure!(
                file_hash(&output)? == (entry.size, entry.sha256.clone()),
                "Backup changed while restoring: {name}"
            );
        }
        fence(&temporary, final_data, &plan)?;
        for nested in [
            temporary.join("provider-accounts"),
            temporary.join("sessions.worktrees"),
            temporary.join("sessions.plugins"),
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
            Ok(json!({"type":"backup","path":bundle,"manifest":validate(&bundle)?.0}))
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
    let destination = resolved_destination(output)?;
    outside(&destination, &fs::canonicalize(&path)?)?;
    outside(&destination, &fs::canonicalize(&data)?)?;
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
    let mut query = tx.prepare(
        "SELECT id,data,project_id IN (SELECT id FROM repositories) FROM workspaces WHERE root=?1",
    )?;
    let rows = query
        .query_map([source.to_string_lossy().as_ref()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, bool>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(query);
    for (id, data, in_repository) in rows {
        let mut record: Value = serde_json::from_str(&data)?;
        ensure!(
            !in_repository,
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
        PLUGINS_DB,
        coverage::ENVELOPE_DB,
        coverage::BROWSER_OPERATIONS,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bind_needs_the_current_schema_and_the_fence() {
        let current = coverage::store("sessions.sqlite").unwrap().schema;
        assert!(bind_verdict(current, (1, 1)).is_ok());
        for (version, fence) in [
            (current - 1, (1, 1)),
            (current + 1, (1, 1)),
            (current, (0, 1)),
            (current, (1, 0)),
            (current, (0, 0)),
        ] {
            let error = bind_verdict(version, fence).unwrap_err().to_string();
            assert!(
                error.starts_with("Only a fenced restore"),
                "{version} {fence:?}: {error}"
            );
        }
    }

    #[test]
    fn restore_reads_only_the_current_schema() {
        assert!(supported_schema("sessions.sqlite", 21, 21).is_ok());
        for version in [20, 11, 99] {
            let error = supported_schema("sessions.sqlite", version, 21).unwrap_err();
            assert_eq!(
                error.to_string(),
                format!(
                    "Unsupported sessions.sqlite schema version {version}; this build restores only schema 21"
                )
            );
        }
        assert!(supported_schema("sessions.review.sqlite3", 0, 0).is_ok());
        assert!(supported_schema("sessions.review.sqlite3", 1, 0).is_err());
        assert!(supported_schema("sessions.worktrees/lifecycle.sqlite3", 5, 5).is_ok());
        assert!(supported_schema("sessions.worktrees/lifecycle.sqlite3", 4, 5).is_err());
    }

    #[test]
    fn attachment_payloads_must_be_complete() {
        let meta = r#"{"id":"a1","name":"x","media_type":"text/plain","size":3}"#;
        assert!(attachment_verdict("a1", meta, 3, "g", "live").is_ok());
        assert!(attachment_verdict("a1", meta, 0, "g", "discarded").is_ok());
        let cases = [
            ("a1", meta, 2, "g", "live", "incomplete"),
            ("a1", meta, 3, "g", "discarded", "incomplete"),
            ("a2", meta, 3, "g", "live", "record is invalid"),
            ("a1", meta, 3, "g", "gone", "record is invalid"),
            ("a1", meta, 3, "", "live", "generation is invalid"),
            ("a1", "not json", 3, "g", "live", "record is invalid"),
            ("a1", r#"{"id":"a1"}"#, 0, "g", "live", "incomplete"),
        ];
        for (id, metadata, length, generation, state, expected) in cases {
            let error = attachment_verdict(id, metadata, length, generation, state).unwrap_err();
            assert!(
                error.to_string().contains(expected),
                "{id} {state} {length}: {error}"
            );
        }
    }

    #[test]
    fn destination_must_be_outside_the_source() {
        let profile = Path::new("/home/p/profiles/one");
        assert!(outside(Path::new("/home/p/backups/b"), profile).is_ok());
        assert!(outside(Path::new("/home/p/profiles/one-backup"), profile).is_ok());
        assert!(outside(Path::new("/home/p/profiles/one/b"), profile).is_err());
        assert!(outside(Path::new("/home/p/profiles/one/runtime/data/b"), profile).is_err());
        assert!(outside(profile, profile).is_err());
    }

    #[test]
    fn pause_is_armed_only_when_compiled_enabled_and_fully_configured() {
        let armed = |compiled, enabled, name, signal, release| {
            pause_plan(compiled, enabled, name, signal, release).map(|plan| plan.is_some())
        };
        let (s, r) = (Some("/tmp/signal"), Some("/tmp/release"));
        assert!(armed(true, Some("1"), "sessions.sqlite", s, r).unwrap());
        assert!(!armed(false, Some("1"), "sessions.sqlite", s, r).unwrap());
        assert!(!armed(true, None, "sessions.sqlite", s, r).unwrap());
        assert!(!armed(true, Some("0"), "sessions.sqlite", s, r).unwrap());
        assert!(!armed(true, Some("1"), "sessions.review.sqlite3", s, r).unwrap());
        assert!(!armed(true, Some("1"), "sessions.sqlite", None, None).unwrap());
        assert!(armed(true, Some("1"), "sessions.sqlite", s, None).is_err());
        assert!(armed(true, Some("1"), "sessions.sqlite", Some("rel"), r).is_err());
    }

    #[test]
    fn online_copy_takes_the_whole_database_in_one_step_with_a_size_bound_deadline() {
        assert_eq!(step_pages(false), -1);
        assert_eq!(step_pages(true), 1);
        assert_eq!(backup_deadline(0), Duration::from_secs(30));
        // A 1 GiB profile timed out under the fixed 30 s limit.
        let large = backup_deadline(1024 * 1024 * 1024);
        assert_eq!(large, Duration::from_secs(30 + 128));
        assert!(backup_deadline(u64::MAX) > large);
    }

    #[test]
    fn restore_pauses_only_queues_that_hold_prompts() {
        let mut child = json!({"id":"c1","status":"idle","queue_paused":false,"error":null});
        hold_queue(&mut child, true);
        assert_eq!(child["queue_paused"], true);
        assert!(
            child["error"]
                .as_str()
                .unwrap()
                .starts_with("Prompt queue paused:")
        );
        let mut failed = json!({"queue_paused":false,"error":"Provider failed"});
        hold_queue(&mut failed, true);
        assert_eq!(failed["queue_paused"], true);
        assert_eq!(failed["error"], "Provider failed");
        let mut empty = json!({"queue_paused":false,"error":null});
        hold_queue(&mut empty, false);
        assert_eq!(empty, json!({"queue_paused":false,"error":null}));
    }

    #[test]
    fn restored_service_does_not_keep_the_source_runtime_run() {
        let mut running = json!({
            "name":"web",
            "terminal_id":"service-web",
            "terminal_owner":{"terminal_id":"service-web","transfer_id":"t1","runtime_instance":"source"},
            "launch_peers":{"API_URL":"http://api"},
        });
        release_service(&mut running);
        assert!(running["terminal_owner"].is_null());
        assert!(running.get("launch_peers").is_none());
        assert_eq!(running["terminal_id"], "service-web");
    }

    #[test]
    fn restore_interrupts_running_lifecycle_work_with_recovery_fields() {
        let mut running = json!({"status":"running","finished_at":null});
        interrupt(&mut running, 42);
        assert_eq!(running["status"], "interrupted");
        assert_eq!(running["code"], "restored_without_runtime_owner");
        assert_eq!(running["recovery"], "inspect_repository_before_retry");
        assert_eq!(running["finished_at"], 42);
        let mut done = json!({"status":"succeeded","finished_at":7});
        interrupt(&mut done, 42);
        assert_eq!(done, json!({"status":"succeeded","finished_at":7}));
    }
}
