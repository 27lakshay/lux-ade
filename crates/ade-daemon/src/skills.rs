//! The profile skill catalog (F132): complete pinned bundles stored as managed
//! blobs in the profile database, plus read-only references to skills that
//! providers read from their own paths.
//!
//! Filesystem reads happen before the database lock and never inside a
//! transaction. Bundle blobs and the catalog row that references them commit
//! in one transaction, with the effect receipt. Only `skill.place` writes
//! outside the database, into an absent or catalog-owned provider path, and
//! only after its dispatched receipt is recorded.
//!
//! Pattern references: Orca `src/main/skills/skill-bundle-install-service.ts`
//! and `skill-removable-placement.ts` (keep externally owned files), OpenCode
//! v2 `config/plugin/skill.ts` (provider roots). No code was copied.
use crate::receipts::{self, Admission, Status};
use ade_core::contract::skills::{
    SkillDiscovery, SkillFile, SkillInspection, SkillInstalled, SkillList, SkillManifest,
    SkillPlaceOutcome, SkillPlaceRequest, SkillPlaced, SkillProjection, SkillProvenance,
    SkillReference, SkillReferenceStatus, SkillRemoved, SkillRoot, SkillRootStatus, SkillScope,
    SkillSourceKind, SkillSummary,
};
use anyhow::{Context, Result, anyhow, bail, ensure};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::Value;
use std::{
    fs,
    io::Read,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

pub mod bundle;
pub mod placement;

use bundle::{Bundle, Entry};
use placement::{AdoptionPlan, InstallPlan, PlacePlan, Root, Seen};

/// Entries read from one provider root during discovery.
const MAX_ROOT_ENTRIES: usize = 512;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS skill_bundles(name TEXT PRIMARY KEY, content_hash TEXT NOT NULL, manifest TEXT NOT NULL, provenance TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS skill_blobs(content_hash TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(content_hash, path));
CREATE TABLE IF NOT EXISTS skill_adoptions(path TEXT PRIMARY KEY, name TEXT NOT NULL, content_hash TEXT NOT NULL, adopted_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS skill_references(scope_key TEXT NOT NULL, provider TEXT NOT NULL, path TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope_key, provider, path));
";

/// Creates the catalog tables in the profile database if they are missing.
pub fn ensure_tables(connection: &Connection) -> Result<()> {
    connection.execute_batch(SCHEMA)?;
    receipts::ensure(connection)
}

/// Why a directory could not become a bundle.
#[derive(Debug)]
pub enum ReadError {
    /// The filesystem refused a read.
    Io(String),
    /// The directory was read but is not a complete, valid bundle.
    Invalid(String),
}

impl std::fmt::Display for ReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(text) | Self::Invalid(text) => f.write_str(text),
        }
    }
}

/// A bundle read from disk and the entries the read skipped.
pub struct ReadBundle {
    pub bundle: Bundle,
    pub excluded: Vec<String>,
    pub resolved: PathBuf,
}

/// Reads a complete skill directory. The top-level path may be a link; any
/// link or special file inside the bundle fails the read, because a bundle
/// must hold every resource it references.
pub fn read_bundle(path: &Path, entry: &str) -> Result<ReadBundle, ReadError> {
    let io = |error: std::io::Error| ReadError::Io(format!("{}: {error}", path.display()));
    let resolved = fs::canonicalize(path).map_err(io)?;
    ensure_dir(&resolved)?;
    let mut files = Vec::new();
    let mut excluded = Vec::new();
    let mut total = 0u64;
    walk(&resolved, "", 0, &mut files, &mut excluded, &mut total)?;
    let bundle = bundle::validate(entry, files).map_err(ReadError::Invalid)?;
    excluded.sort();
    Ok(ReadBundle {
        bundle,
        excluded,
        resolved,
    })
}

fn ensure_dir(path: &Path) -> Result<(), ReadError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| ReadError::Io(format!("{}: {error}", path.display())))?;
    if !metadata.is_dir() {
        return Err(ReadError::Invalid(format!(
            "{} is not a directory",
            path.display()
        )));
    }
    Ok(())
}

fn walk(
    directory: &Path,
    prefix: &str,
    depth: usize,
    files: &mut Vec<Entry>,
    excluded: &mut Vec<String>,
    total: &mut u64,
) -> Result<(), ReadError> {
    if depth > bundle::MAX_DEPTH {
        return Err(ReadError::Invalid(format!(
            "Bundle nests deeper than {} directories",
            bundle::MAX_DEPTH
        )));
    }
    let io = |error: std::io::Error| ReadError::Io(format!("{}: {error}", directory.display()));
    let mut entries = fs::read_dir(directory)
        .map_err(io)?
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(io)?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name();
        let name = name.to_str().ok_or_else(|| {
            ReadError::Invalid(format!(
                "Bundle has a non-UTF-8 name in {}",
                directory.display()
            ))
        })?;
        let relative = if prefix.is_empty() {
            name.to_owned()
        } else {
            format!("{prefix}/{name}")
        };
        if bundle::excluded_entry(name) {
            excluded.push(relative);
            continue;
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(io)?;
        let kind = metadata.file_type();
        if kind.is_dir() {
            walk(&path, &relative, depth + 1, files, excluded, total)?;
        } else if kind.is_file() {
            if files.len() >= bundle::MAX_FILES {
                return Err(ReadError::Invalid(format!(
                    "Bundle has more than {} files",
                    bundle::MAX_FILES
                )));
            }
            *total += metadata.len();
            if *total > bundle::MAX_TOTAL_BYTES {
                return Err(ReadError::Invalid("Bundle exceeds 32 MiB".into()));
            }
            let mut data = Vec::with_capacity(metadata.len() as usize);
            fs::File::open(&path)
                .and_then(|file| {
                    file.take(bundle::MAX_TOTAL_BYTES + 1)
                        .read_to_end(&mut data)
                })
                .map_err(io)?;
            if data.len() as u64 != metadata.len() {
                return Err(ReadError::Io(format!(
                    "{relative} changed while it was read"
                )));
            }
            files.push(Entry {
                path: relative,
                data,
                executable: metadata.permissions().mode() & 0o111 != 0,
            });
        } else if kind.is_symlink() {
            return Err(ReadError::Invalid(format!(
                "Bundle contains a symbolic link: {relative}"
            )));
        } else {
            return Err(ReadError::Invalid(format!(
                "Bundle contains a special file: {relative}"
            )));
        }
    }
    Ok(())
}

/// What is at a provider path, reading it without following a top-level link.
pub fn observe(path: &Path, entry: &str) -> Seen {
    observe_read(path, entry).0
}

/// [`observe`], also returning the bundle it read, so a caller can act on
/// exactly the content it observed.
pub fn observe_read(path: &Path, entry: &str) -> (Seen, Option<ReadBundle>) {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (Seen::Absent, None),
        Err(_) => (Seen::Unreadable, None),
        Ok(metadata) if !metadata.is_dir() => (Seen::Other, None),
        Ok(_) => match read_bundle(path, entry) {
            Ok(read) => (
                Seen::Directory {
                    content_hash: Some(read.bundle.manifest.content_hash.clone()),
                },
                Some(read),
            ),
            Err(ReadError::Invalid(_)) => (Seen::Directory { content_hash: None }, None),
            Err(ReadError::Io(_)) => (Seen::Unreadable, None),
        },
    }
}

fn scope_key(scope: SkillScope, workspace_id: Option<&str>) -> String {
    match (scope, workspace_id) {
        (SkillScope::Workspace, Some(id)) => format!("workspace:{id}"),
        _ => "global".into(),
    }
}

/// Scans provider roots. Reads only; never follows a link out of a bundle.
pub fn scan(
    roots: &[Root],
    workspace_id: Option<&str>,
    now: i64,
) -> (Vec<SkillRoot>, Vec<SkillReference>) {
    let mut scanned = Vec::new();
    let mut references = Vec::new();
    for root in roots {
        let status = match fs::symlink_metadata(&root.path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => SkillRootStatus::Missing,
            Err(_) => SkillRootStatus::Unreadable,
            // A root that is itself a link is followed: providers read through it.
            Ok(_) if !root.path.is_dir() => SkillRootStatus::NotDirectory,
            Ok(_) => SkillRootStatus::Present,
        };
        let mut status = status;
        if status == SkillRootStatus::Present {
            match fs::read_dir(&root.path) {
                Err(_) => status = SkillRootStatus::Unreadable,
                Ok(entries) => {
                    let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
                    entries.sort_by_key(|entry| entry.file_name());
                    for entry in entries.into_iter().take(MAX_ROOT_ENTRIES) {
                        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                            continue;
                        };
                        if name.starts_with('.') {
                            continue;
                        }
                        references.push(reference(root, workspace_id, &name, now));
                    }
                }
            }
        }
        scanned.push(SkillRoot {
            provider: root.provider.into(),
            scope: root.scope,
            path: root.path.display().to_string(),
            status,
        });
    }
    (scanned, references)
}

fn reference(root: &Root, workspace_id: Option<&str>, entry: &str, now: i64) -> SkillReference {
    let path = root.path.join(entry);
    let symlink_target = fs::read_link(&path)
        .ok()
        .map(|target| target.display().to_string());
    let mut reference = SkillReference {
        provider: root.provider.into(),
        scope: root.scope,
        workspace_id: match root.scope {
            SkillScope::Workspace => workspace_id.map(str::to_owned),
            SkillScope::Global => None,
        },
        root: root.path.display().to_string(),
        path: path.display().to_string(),
        entry: entry.into(),
        status: SkillReferenceStatus::Valid,
        problem: None,
        name: None,
        description: None,
        content_hash: None,
        symlink_target,
        adopted_by: None,
        discovered_at: now,
    };
    if !path.is_dir() {
        reference.status = SkillReferenceStatus::Invalid;
        reference.problem = Some("Not a skill directory".into());
        return reference;
    }
    match read_bundle(&path, entry) {
        Ok(read) => {
            let manifest = read.bundle.manifest;
            reference.name = Some(manifest.name);
            reference.description = Some(manifest.description);
            reference.content_hash = Some(manifest.content_hash);
        }
        Err(ReadError::Invalid(problem)) => {
            reference.status = SkillReferenceStatus::Invalid;
            reference.problem = Some(problem);
        }
        Err(ReadError::Io(problem)) => {
            reference.status = SkillReferenceStatus::Unreadable;
            reference.problem = Some(problem);
        }
    }
    reference
}

fn transaction(connection: &Connection) -> Result<Transaction<'_>> {
    Ok(Transaction::new_unchecked(
        connection,
        TransactionBehavior::Immediate,
    )?)
}

fn installed_hash(connection: &Connection, name: &str) -> Result<Option<String>> {
    Ok(connection
        .query_row(
            "SELECT content_hash FROM skill_bundles WHERE name=?1",
            [name],
            |row| row.get(0),
        )
        .optional()?)
}

fn adopted_paths(connection: &Connection, name: &str) -> Result<Vec<String>> {
    let mut statement =
        connection.prepare("SELECT path FROM skill_adoptions WHERE name=?1 ORDER BY path")?;
    let paths = statement
        .query_map([name], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(paths)
}

fn summary(connection: &Connection, name: &str) -> Result<(SkillSummary, SkillManifest)> {
    let (manifest, provenance): (String, String) = connection
        .query_row(
            "SELECT manifest,provenance FROM skill_bundles WHERE name=?1",
            [name],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .with_context(|| format!("No skill named {name} is installed"))?;
    let manifest: SkillManifest = serde_json::from_str(&manifest)?;
    let provenance: SkillProvenance = serde_json::from_str(&provenance)?;
    Ok((
        SkillSummary {
            name: manifest.name.clone(),
            description: manifest.description.clone(),
            content_hash: manifest.content_hash.clone(),
            file_count: manifest.files.len() as u64,
            total_bytes: manifest.total_bytes,
            provenance,
            adopted_paths: adopted_paths(connection, name)?,
        },
        manifest,
    ))
}

/// Checks that every manifest file has its blob with the recorded digest and size.
fn verify_blobs(connection: &Connection, manifest: &SkillManifest) -> Result<()> {
    let mut statement = connection.prepare(
        "SELECT path,sha256,length(data) FROM skill_blobs WHERE content_hash=?1 ORDER BY path",
    )?;
    let blobs = statement
        .query_map([&manifest.content_hash], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut files: Vec<_> = manifest.files.iter().collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    ensure!(
        blobs.len() == files.len()
            && blobs.iter().zip(&files).all(|((path, sha, size), file)| {
                *path == file.path && *sha == file.sha256 && *size as u64 == file.size
            }),
        "Skill {} blobs do not match its manifest",
        manifest.name
    );
    Ok(())
}

fn write_bundle(
    tx: &Transaction,
    read: &ReadBundle,
    kind: SkillSourceKind,
    source_path: &str,
    now: i64,
) -> Result<SkillProvenance> {
    let manifest = &read.bundle.manifest;
    // Blobs first; the catalog row that references them commits with them.
    for (file, data) in manifest.files.iter().zip(&read.bundle.data) {
        tx.execute(
            "INSERT OR IGNORE INTO skill_blobs(content_hash,path,sha256,data) VALUES(?1,?2,?3,?4)",
            params![manifest.content_hash, file.path, file.sha256, data],
        )?;
    }
    let provenance = SkillProvenance {
        kind,
        source_path: source_path.into(),
        resolved_path: read.resolved.display().to_string(),
        pinned_content_hash: manifest.content_hash.clone(),
        excluded: read.excluded.clone(),
        installed_at: now,
    };
    let previous = installed_hash(tx, &manifest.name)?;
    tx.execute(
        "INSERT INTO skill_bundles(name,content_hash,manifest,provenance,updated_at) VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(name) DO UPDATE SET content_hash=excluded.content_hash, manifest=excluded.manifest,
         provenance=excluded.provenance, updated_at=excluded.updated_at",
        params![
            manifest.name,
            manifest.content_hash,
            serde_json::to_string(manifest)?,
            serde_json::to_string(&provenance)?,
            now
        ],
    )?;
    if let Some(previous) = previous {
        release_blobs(tx, &previous)?;
    }
    verify_blobs(tx, manifest)?;
    Ok(provenance)
}

/// Drops a bundle's blobs once no catalog row references its hash.
fn release_blobs(tx: &Transaction, content_hash: &str) -> Result<()> {
    tx.execute(
        "DELETE FROM skill_blobs WHERE content_hash=?1 AND NOT EXISTS(SELECT 1 FROM skill_bundles WHERE content_hash=?1)",
        [content_hash],
    )?;
    Ok(())
}

/// Admits an effect command, running `apply` only for a new operation ID.
/// `apply` runs inside the transaction that writes the receipt; an error
/// rolls both back, so a failed command leaves no receipt and no change.
fn effect(
    connection: &Connection,
    op: &str,
    request: &Value,
    now: i64,
    apply: impl FnOnce(&Transaction) -> Result<Value>,
) -> Result<Value> {
    let operation_id = request[receipts::OPERATION_ID_FIELD]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 512)
        .context("Missing operation_id")?;
    let tx = transaction(connection)?;
    match receipts::begin(&tx, operation_id, op, request, None, now)? {
        Admission::New => {}
        Admission::Replay(receipt) => {
            ensure!(
                receipt.status == Status::Settled,
                "Operation {operation_id} did not settle"
            );
            return receipt
                .result
                .context("Settled operation has no stored result");
        }
        Admission::Conflict => bail!("Operation ID was already used for different parameters"),
        Admission::Expired => {
            bail!("Operation ID is past its 30-day receipt retention; use a new operation ID")
        }
    }
    let result = apply(&tx)?;
    receipts::settle(&tx, operation_id, Status::Settled, Some(&result), now)?;
    tx.commit()?;
    Ok(result)
}

/// `skill.install` after the source directory was read.
pub fn install(
    connection: &Connection,
    request: &Value,
    source_path: &str,
    read: &ReadBundle,
    expected: Option<&str>,
    replace: Option<&str>,
    now: i64,
) -> Result<Value> {
    effect(connection, "skill.install", request, now, |tx| {
        let manifest = &read.bundle.manifest;
        let current = installed_hash(tx, &manifest.name)?;
        let plan = placement::plan_install(
            current.as_deref(),
            &manifest.content_hash,
            expected,
            replace,
        )
        .map_err(|error| anyhow!(error))?;
        if plan != InstallPlan::Unchanged {
            write_bundle(tx, read, SkillSourceKind::LocalDirectory, source_path, now)?;
        }
        let (skill, _) = summary(tx, &manifest.name)?;
        Ok(serde_json::to_value(SkillInstalled {
            tag: Default::default(),
            skill,
            changed: plan != InstallPlan::Unchanged,
            replaced_content_hash: (plan == InstallPlan::Replace)
                .then(|| current.unwrap_or_default()),
        })?)
    })
}

/// `skill.adopt` after the provider path was read and observed.
#[allow(clippy::too_many_arguments)]
pub fn adopt(
    connection: &Connection,
    request: &Value,
    roots: &[Root],
    path: &Path,
    seen: &Seen,
    read: Option<&ReadBundle>,
    expected: &str,
    now: i64,
) -> Result<Value> {
    effect(connection, "skill.adopt", request, now, |tx| {
        let entry = path
            .file_name()
            .and_then(|name| name.to_str())
            .context("Skill path has no directory name")?;
        let path_text = path.display().to_string();
        let installed = installed_hash(tx, entry)?;
        let adopted_by: Option<String> = tx
            .query_row(
                "SELECT name FROM skill_adoptions WHERE path=?1",
                [&path_text],
                |row| row.get(0),
            )
            .optional()?;
        let plan = placement::plan_adoption(&placement::AdoptionContext {
            roots,
            path,
            seen,
            expected_hash: expected,
            name: entry,
            installed: installed.as_deref(),
            adopted_by: adopted_by.as_deref(),
        })
        .map_err(|error| anyhow!(error))?;
        if plan == AdoptionPlan::InstallAndOwn {
            let read = read.context("The skill directory could not be read")?;
            ensure!(
                read.bundle.manifest.content_hash == expected,
                "The directory changed while it was read; discover it again"
            );
            write_bundle(tx, read, SkillSourceKind::Adopted, &path_text, now)?;
        }
        if plan != AdoptionPlan::Unchanged {
            tx.execute(
                "INSERT INTO skill_adoptions(path,name,content_hash,adopted_at) VALUES(?1,?2,?3,?4)",
                params![path_text, entry, expected, now],
            )?;
        }
        let (skill, _) = summary(tx, entry)?;
        Ok(serde_json::to_value(SkillInstalled {
            tag: Default::default(),
            skill,
            changed: plan != AdoptionPlan::Unchanged,
            replaced_content_hash: None,
        })?)
    })
}

/// `skill.remove`: drops the bundle and its blobs and releases adopted paths.
/// Files at those paths stay where they are.
pub fn remove(
    connection: &Connection,
    request: &Value,
    name: &str,
    expected: &str,
    now: i64,
) -> Result<Value> {
    effect(connection, "skill.remove", request, now, |tx| {
        placement::check_remove(installed_hash(tx, name)?.as_deref(), expected)
            .map_err(|error| anyhow!(error))?;
        let released = adopted_paths(tx, name)?;
        tx.execute("DELETE FROM skill_adoptions WHERE name=?1", [name])?;
        tx.execute("DELETE FROM skill_bundles WHERE name=?1", [name])?;
        release_blobs(tx, expected)?;
        Ok(serde_json::to_value(SkillRemoved {
            tag: Default::default(),
            name: name.into(),
            content_hash: expected.into(),
            released_paths: released,
        })?)
    })
}

fn annotate(connection: &Connection, references: &mut [SkillReference]) -> Result<()> {
    for reference in references {
        reference.adopted_by = connection
            .query_row(
                "SELECT name FROM skill_adoptions WHERE path=?1",
                [&reference.path],
                |row| row.get(0),
            )
            .optional()?;
    }
    Ok(())
}

/// `skill.discover` after the scan: replaces the stored references of each
/// scanned scope, so repeating it converges on what is on disk.
pub fn record_discovery(
    connection: &Connection,
    workspace_id: Option<&str>,
    roots: Vec<SkillRoot>,
    mut references: Vec<SkillReference>,
) -> Result<Value> {
    let tx = transaction(connection)?;
    let mut scopes = vec![scope_key(SkillScope::Global, None)];
    if let Some(id) = workspace_id {
        scopes.push(scope_key(SkillScope::Workspace, Some(id)));
    }
    for scope in &scopes {
        tx.execute("DELETE FROM skill_references WHERE scope_key=?1", [scope])?;
    }
    for reference in &references {
        tx.execute(
            "INSERT OR REPLACE INTO skill_references(scope_key,provider,path,data) VALUES(?1,?2,?3,?4)",
            params![
                scope_key(reference.scope, reference.workspace_id.as_deref()),
                reference.provider,
                reference.path,
                serde_json::to_string(reference)?
            ],
        )?;
    }
    tx.commit()?;
    annotate(connection, &mut references)?;
    Ok(serde_json::to_value(SkillDiscovery {
        tag: Default::default(),
        roots,
        references,
    })?)
}

/// `skill.list`.
pub fn list(connection: &Connection) -> Result<Value> {
    let names = connection
        .prepare("SELECT name FROM skill_bundles ORDER BY name")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let skills = names
        .iter()
        .map(|name| summary(connection, name).map(|(skill, _)| skill))
        .collect::<Result<Vec<_>>>()?;
    let mut references = connection
        .prepare("SELECT data FROM skill_references ORDER BY scope_key,provider,path")?
        .query_map([], |row| row.get::<_, String>(0))?
        .map(|row| Ok(serde_json::from_str::<SkillReference>(&row?)?))
        .collect::<Result<Vec<_>>>()?;
    annotate(connection, &mut references)?;
    Ok(serde_json::to_value(SkillList {
        tag: Default::default(),
        skills,
        references,
    })?)
}

/// The stored state `skill.inspect` needs before it looks at provider paths.
pub struct Inspected {
    pub skill: SkillSummary,
    pub manifest: SkillManifest,
    pub adoptions: Vec<(String, String)>,
}

pub fn load(connection: &Connection, name: &str) -> Result<Inspected> {
    let (skill, manifest) = summary(connection, name)?;
    verify_blobs(connection, &manifest)?;
    let adoptions = connection
        .prepare("SELECT path,content_hash FROM skill_adoptions WHERE name=?1")?
        .query_map([name], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Inspected {
        skill,
        manifest,
        adoptions,
    })
}

/// `skill.inspect` once stored state is loaded: observes each provider path
/// and reports what a placement there would need. Reads only.
pub fn inspection(inspected: Inspected, roots: &[Root]) -> Result<Value> {
    let name = inspected.manifest.name.as_str();
    let projection = roots
        .iter()
        .map(|root| {
            let path = root.path.join(name);
            let path_text = path.display().to_string();
            let adopted = inspected
                .adoptions
                .iter()
                .find(|(adopted, _)| *adopted == path_text)
                .map(|(_, hash)| hash.as_str());
            let (observed, decision, reason) = placement::decide(
                &observe(&path, name),
                adopted,
                &inspected.manifest.content_hash,
            );
            SkillProjection {
                provider: root.provider.into(),
                scope: root.scope,
                root: root.path.display().to_string(),
                path: path_text,
                observed,
                decision,
                reason: reason.map(str::to_owned),
            }
        })
        .collect();
    Ok(serde_json::to_value(SkillInspection {
        tag: Default::default(),
        skill: inspected.skill,
        manifest: inspected.manifest,
        projection,
    })?)
}

/// Where `provider` reads skills of `scope`: its first root of that scope.
pub fn place_root<'a>(roots: &'a [Root], provider: &str, scope: SkillScope) -> Option<&'a Root> {
    roots
        .iter()
        .find(|root| root.provider == provider && root.scope == scope)
}

/// What admission decided for a `skill.place`.
pub enum PlaceAdmission {
    /// Reply without writing: a replay, or a placement with nothing to write.
    Done(Value),
    /// Write `files` at the path; the receipt is dispatched.
    Write {
        files: Vec<(SkillFile, Vec<u8>)>,
        plan: PlacePlan,
        reply: SkillPlaced,
    },
}

/// Records the path as catalog-owned and settles the receipt with `reply`.
fn settle_place(
    tx: &Transaction,
    operation_id: &str,
    reply: &SkillPlaced,
    now: i64,
) -> Result<Value> {
    if reply.outcome != SkillPlaceOutcome::ExternalIdentical {
        tx.execute(
            "INSERT INTO skill_adoptions(path,name,content_hash,adopted_at) VALUES(?1,?2,?3,?4)
             ON CONFLICT(path) DO UPDATE SET name=excluded.name,content_hash=excluded.content_hash,adopted_at=excluded.adopted_at",
            params![reply.path, reply.name, reply.content_hash, now],
        )?;
    }
    let value = serde_json::to_value(reply)?;
    receipts::settle(tx, operation_id, Status::Settled, Some(&value), now)?;
    Ok(value)
}

fn unknown_placement(message: String) -> anyhow::Error {
    ade_core::error::OperationOutcomeUnknown(message).into()
}

/// `skill.place` admission, after the provider path was observed as `seen`.
/// A new placement checks the installed hash and the path, then records a
/// dispatched receipt before any file is written. A replay of a dispatched
/// receipt, left by a crash, settles only when the path holds exactly the
/// bundle; otherwise its outcome is unknown and it never runs again.
#[allow(clippy::too_many_arguments)]
pub fn begin_place(
    connection: &Connection,
    request: &Value,
    place: &SkillPlaceRequest,
    workspace_id: Option<&str>,
    target: &Path,
    seen: &Seen,
    now: i64,
) -> Result<PlaceAdmission> {
    let operation_id = place.operation_id.as_str();
    ensure!(
        !operation_id.is_empty() && operation_id.len() <= 512,
        "Missing operation_id"
    );
    let path_text = target.display().to_string();
    let tx = transaction(connection)?;
    match receipts::begin(&tx, operation_id, "skill.place", request, None, now)? {
        Admission::New => {}
        Admission::Replay(receipt) => match receipt.status {
            Status::Settled => {
                return Ok(PlaceAdmission::Done(
                    receipt
                        .result
                        .context("Settled operation has no stored result")?,
                ));
            }
            Status::Unknown => {
                return Err(unknown_placement(format!(
                    "Placement {operation_id} was interrupted; its outcome is unknown and it will not run again. Inspect {path_text} before placing again."
                )));
            }
            _ => {
                let reply: SkillPlaced = serde_json::from_value(
                    receipt
                        .result
                        .context("Dispatched placement has no record")?,
                )?;
                if placement::placement_finished(seen, &reply.content_hash) {
                    let value = settle_place(&tx, operation_id, &reply, now)?;
                    tx.commit()?;
                    return Ok(PlaceAdmission::Done(value));
                }
                receipts::settle(&tx, operation_id, Status::Unknown, None, now)?;
                tx.commit()?;
                return Err(unknown_placement(format!(
                    "Placement {operation_id} was interrupted and {path_text} does not hold the bundle; its outcome is unknown and it will not run again. Inspect the path before placing again."
                )));
            }
        },
        Admission::Conflict => bail!("Operation ID was already used for different parameters"),
        Admission::Expired => {
            bail!("Operation ID is past its 30-day receipt retention; use a new operation ID")
        }
    }
    // Any refusal below returns before commit, so it leaves no receipt.
    placement::check_remove(
        installed_hash(&tx, &place.name)?.as_deref(),
        &place.expected_content_hash,
    )
    .map_err(|error| anyhow!(error))?;
    let adopted: Option<String> = tx
        .query_row(
            "SELECT content_hash FROM skill_adoptions WHERE path=?1",
            [&path_text],
            |row| row.get(0),
        )
        .optional()?;
    let (observed, decision, reason) =
        placement::decide(seen, adopted.as_deref(), &place.expected_content_hash);
    let plan =
        placement::plan_place(observed, decision, reason).map_err(|error| anyhow!(error))?;
    let reply = SkillPlaced {
        tag: Default::default(),
        name: place.name.clone(),
        content_hash: place.expected_content_hash.clone(),
        provider: place.provider.clone(),
        scope: place.scope,
        workspace_id: workspace_id.map(str::to_owned),
        path: path_text,
        outcome: match plan {
            PlacePlan::Create => SkillPlaceOutcome::Created,
            PlacePlan::Replace => SkillPlaceOutcome::Replaced,
            PlacePlan::UpToDate => SkillPlaceOutcome::UpToDate,
            PlacePlan::ExternalIdentical => SkillPlaceOutcome::ExternalIdentical,
        },
    };
    if matches!(plan, PlacePlan::UpToDate | PlacePlan::ExternalIdentical) {
        let value = settle_place(&tx, operation_id, &reply, now)?;
        tx.commit()?;
        return Ok(PlaceAdmission::Done(value));
    }
    let manifest: SkillManifest = serde_json::from_str(&tx.query_row(
        "SELECT manifest FROM skill_bundles WHERE name=?1",
        [&place.name],
        |row| row.get::<_, String>(0),
    )?)?;
    verify_blobs(&tx, &manifest)?;
    let mut files = Vec::with_capacity(manifest.files.len());
    for file in &manifest.files {
        let data: Vec<u8> = tx.query_row(
            "SELECT data FROM skill_blobs WHERE content_hash=?1 AND path=?2",
            params![manifest.content_hash, file.path],
            |row| row.get(0),
        )?;
        ensure!(
            bundle::sha256_hex(&data) == file.sha256,
            "Skill {} blob {} does not match its manifest",
            manifest.name,
            file.path
        );
        files.push((file.clone(), data));
    }
    receipts::settle(
        &tx,
        operation_id,
        Status::Dispatched,
        Some(&serde_json::to_value(&reply)?),
        now,
    )?;
    tx.commit()?;
    Ok(PlaceAdmission::Write { files, plan, reply })
}

/// Settles a placement whose files were written.
pub fn finish_place(
    connection: &Connection,
    reply: &SkillPlaced,
    operation_id: &str,
    now: i64,
) -> Result<Value> {
    let tx = transaction(connection)?;
    let value = settle_place(&tx, operation_id, reply, now)?;
    tx.commit()?;
    Ok(value)
}

/// Drops the receipt of a placement that failed before it changed the path,
/// so the same operation ID may run again.
pub fn abandon_place(connection: &Connection, operation_id: &str) -> Result<()> {
    connection.execute(
        "DELETE FROM operations WHERE id=?1 AND status=?2",
        params![operation_id, Status::Dispatched.as_str()],
    )?;
    Ok(())
}

/// Marks a placement whose write may have changed the path as unknown.
pub fn unknown_place(connection: &Connection, operation_id: &str, now: i64) -> Result<()> {
    receipts::settle(connection, operation_id, Status::Unknown, None, now)
}

/// Why [`write_placement`] failed, and whether the provider path changed.
pub enum WriteFailure {
    /// The path is as it was, and no staging directory is left behind.
    Untouched(anyhow::Error),
    /// A rename happened; the path may hold either bundle.
    Uncertain(anyhow::Error),
}

/// Writes the bundle into a hidden staging directory beside `target`, then
/// renames it into place. A replacement first moves ADE's own old placement
/// aside and deletes it only once the new one is in place. Discovery skips
/// dot-prefixed entries, so a staging directory is never read as a skill.
pub fn write_placement(
    root: &Path,
    target: &Path,
    operation_id: &str,
    files: &[(SkillFile, Vec<u8>)],
    plan: PlacePlan,
) -> std::result::Result<(), WriteFailure> {
    use std::io::Write as _;
    let key = &bundle::sha256_hex(operation_id.as_bytes())[..16];
    let stage = root.join(format!(".ade-place-{key}"));
    let aside = root.join(format!(".ade-replaced-{key}"));
    let staged = (|| -> Result<()> {
        fs::create_dir_all(root)?;
        if fs::symlink_metadata(&stage).is_ok() {
            fs::remove_dir_all(&stage)?;
        }
        fs::create_dir(&stage)?;
        for (file, data) in files {
            ensure!(
                bundle::valid_path(&file.path),
                "Invalid bundle path {}",
                file.path
            );
            let path = stage.join(&file.path);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut out = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(if file.executable { 0o755 } else { 0o644 })
                .open(&path)?;
            out.write_all(data)?;
            out.sync_all()?;
        }
        Ok(())
    })();
    if let Err(error) = staged {
        let _ = fs::remove_dir_all(&stage);
        return Err(WriteFailure::Untouched(error));
    }
    match plan {
        PlacePlan::Create => {
            if fs::symlink_metadata(target).is_ok() {
                let _ = fs::remove_dir_all(&stage);
                return Err(WriteFailure::Untouched(anyhow!(
                    "{} appeared while the skill was staged; nothing was placed",
                    target.display()
                )));
            }
            fs::rename(&stage, target).map_err(|error| {
                let _ = fs::remove_dir_all(&stage);
                WriteFailure::Untouched(error.into())
            })
        }
        PlacePlan::Replace => {
            if let Err(error) = fs::rename(target, &aside) {
                let _ = fs::remove_dir_all(&stage);
                return Err(WriteFailure::Untouched(error.into()));
            }
            if let Err(error) = fs::rename(&stage, target) {
                // Put ADE's old placement back; the path is then as it was.
                return match fs::rename(&aside, target) {
                    Ok(()) => {
                        let _ = fs::remove_dir_all(&stage);
                        Err(WriteFailure::Untouched(error.into()))
                    }
                    Err(_) => Err(WriteFailure::Uncertain(error.into())),
                };
            }
            let _ = fs::remove_dir_all(&aside);
            Ok(())
        }
        PlacePlan::UpToDate | PlacePlan::ExternalIdentical => Ok(()),
    }
}
