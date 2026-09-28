//! What a backend backup holds and the pure checks on its manifest (D15).
//!
//! Every profile store is backed up, rebuilt from backed-up data, or excluded
//! with a stated reason. The manifest records that coverage, so a bundle never
//! implies it holds more than it does. The filesystem work lives in the parent
//! module; this module decides.
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

/// The format this build writes. Format 3 adds directory entries and the
/// plugin stores, and leaves the history search index out. Format 4 adds the
/// browser library. Format 5 withholds secret service environment values.
/// Format 6 drops plugin credential references to items ADE made. Format 7
/// adds the two receipt stores kept outside the profile database: the
/// effect-command envelope and the browser operation journal.
pub const FORMAT: i64 = 7;
/// The oldest format restore still reads. Formats 4 to 7 add no store a
/// restore needs, so restore keeps reading formats 2 and 3. A bundle without
/// a receipt store restores with an empty one, as before format 7.
pub const OLDEST_FORMAT: i64 = 2;
/// The first format that leaves the history search index out.
pub const PROJECTION_EXCLUDED_SINCE: i64 = 3;
/// The first format whose `sessions.sqlite` holds no secret service value.
pub const SECRETS_WITHHELD_SINCE: i64 = 5;
/// The first format whose plugin registry names no item ADE made.
pub const PLUGIN_CREDENTIALS_WITHHELD_SINCE: i64 = 6;
pub const SCOPE: &str = "backend-snapshot-only";
/// A non-SQLite manifest file stays small.
pub const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
/// Files and bytes one directory entry may hold. The plugin artifact store
/// caps each artifact at 20,000 files and 512 MiB; these bound the whole store.
pub const MAX_DIRECTORY_FILES: usize = 100_000;
pub const MAX_DIRECTORY_BYTES: u64 = 8 * 1024 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Sqlite,
    Manifest,
    Directory,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Sqlite => "sqlite",
            Kind::Manifest => "manifest",
            Kind::Directory => "directory",
        }
    }
}

/// One store a backup copies, relative to the data directory.
pub struct Store {
    pub path: &'static str,
    pub kind: Kind,
    /// The current schema (`PRAGMA user_version`); 0 for an unversioned store.
    pub schema: i64,
    /// The first backup format that holds it.
    pub since: i64,
}

pub const PLUGINS_DB: &str = "sessions.plugins.sqlite3";
/// `browser_library::LIBRARY_FILE`: named partitions, imported bookmarks and
/// history, and held design captures.
pub const BROWSER_LIBRARY: &str = "browser-library.sqlite3";
pub const PLUGIN_ARTIFACTS: &str = "sessions.plugins/artifacts";
/// `receipts::envelope_store`: receipts of the effect commands the envelope
/// records (`envelope::OPERATIONS`), which keep no receipt of their own.
pub const ENVELOPE_DB: &str = "sessions.envelope.sqlite3";
/// The daemon's browser mutation receipts (`browser_journal`).
pub const BROWSER_OPERATIONS: &str = "browser-operations.sqlite3";

/// Stores in copy order. The plugin registry is copied before its artifacts:
/// install places an artifact before its row commits, so every row in the
/// copied registry names an artifact that already existed. An uninstall that
/// lands between the two copies fails the backup's consistency check.
pub const STORES: &[Store] = &[
    Store {
        path: "sessions.sqlite",
        kind: Kind::Sqlite,
        schema: 19,
        since: 2,
    },
    Store {
        path: "sessions.review.sqlite3",
        kind: Kind::Sqlite,
        schema: 0,
        since: 2,
    },
    Store {
        path: "sessions.worktrees/lifecycle.sqlite3",
        kind: Kind::Sqlite,
        schema: 4,
        since: 2,
    },
    Store {
        path: "sessions.worktrees/empty.toml",
        kind: Kind::Manifest,
        schema: 0,
        since: 2,
    },
    Store {
        path: PLUGINS_DB,
        kind: Kind::Sqlite,
        schema: 0,
        since: 3,
    },
    Store {
        path: PLUGIN_ARTIFACTS,
        kind: Kind::Directory,
        schema: 0,
        since: 3,
    },
    Store {
        path: BROWSER_LIBRARY,
        kind: Kind::Sqlite,
        schema: 0,
        since: 4,
    },
    Store {
        path: ENVELOPE_DB,
        kind: Kind::Sqlite,
        schema: 0,
        since: 7,
    },
    Store {
        path: BROWSER_OPERATIONS,
        kind: Kind::Sqlite,
        schema: 0,
        since: 7,
    },
];

pub fn store(path: &str) -> Option<&'static Store> {
    STORES.iter().find(|store| store.path == path)
}

/// Exclusions a format-2 bundle declares.
pub const EXCLUDED_V2: &[&str] = &[
    "browser sessions, tabs, cookies and pending sends",
    "provider-native homes and credentials",
    "external projects, repositories and worktrees",
    "service routes, logs, owner locks, sockets and processes",
];
/// Exclusions a format-3 bundle declares.
pub const EXCLUDED_V3: &[&str] = &[
    "browser sessions, tabs, cookies and pending sends",
    "provider-native homes and credentials",
    "external projects, repositories and worktrees",
    "service routes, logs, owner locks, sockets and processes",
    "history search index: a rebuildable projection of sessions.sqlite; the daemon rebuilds it after restore",
    "host-level HostResources registry and its claims: host-owned, not profile-owned; the restored profile binds to the registry on its host",
    "plugin install staging and plugin-private files outside the plugin registry",
];
/// Exclusions a format-4 bundle declares.
pub const EXCLUDED_V4: &[&str] = &[
    "browser sessions, tabs, cookies and pending sends",
    "provider-native homes and credentials",
    "external projects, repositories and worktrees",
    "service routes, logs, owner locks, sockets and processes",
    "history search index: a rebuildable projection of sessions.sqlite; the daemon rebuilds it after restore",
    "host-level HostResources registry and its claims: host-owned, not profile-owned; the restored profile binds to the registry on its host",
    "plugin install staging and plugin-private files outside the plugin registry",
    "browser import staging: transient copies of import sources",
];
/// Exclusions a format-5 bundle declares.
pub const EXCLUDED_V5: &[&str] = &[
    "browser sessions, tabs, cookies and pending sends",
    "provider-native homes and credentials",
    "external projects, repositories and worktrees",
    "service routes, logs, owner locks, sockets and processes",
    "history search index: a rebuildable projection of sessions.sqlite; the daemon rebuilds it after restore",
    "host-level HostResources registry and its claims: host-owned, not profile-owned; the restored profile binds to the registry on its host",
    "plugin install staging and plugin-private files outside the plugin registry",
    "browser import staging: transient copies of import sources",
    "secret service environment values: each is stored as [redacted]; configure it again before starting the service",
];
/// Exclusions this format declares, including what restore rebuilds.
pub const EXCLUDED: &[&str] = &[
    "browser sessions, tabs, cookies and pending sends",
    "provider-native homes and credentials",
    "external projects, repositories and worktrees",
    "service routes, logs, owner locks, sockets and processes",
    "history search index: a rebuildable projection of sessions.sqlite; the daemon rebuilds it after restore",
    "host-level HostResources registry and its claims: host-owned, not profile-owned; the restored profile binds to the registry on its host",
    "plugin install staging and plugin-private files outside the plugin registry",
    "browser import staging: transient copies of import sources",
    "secret service environment values: each is stored as [redacted]; configure it again before starting the service",
    "plugin credential references to items ADE made: the bundle drops each; send the credential again after restore",
];

/// How a format-3 bundle treats each profile store.
pub const COVERAGE_V3: &[(&str, &str, &str)] = &[
    (
        "sessions.sqlite",
        "backed_up",
        "conversations, attachments, activity and notification deliveries, the MCP catalog, and the skill catalog with its bundle blobs",
    ),
    ("sessions.review.sqlite3", "backed_up", "review feedback"),
    (
        "sessions.worktrees/lifecycle.sqlite3",
        "backed_up",
        "worktree lifecycle ledger; restore fences it",
    ),
    (
        "sessions.worktrees/empty.toml",
        "backed_up",
        "worktree manifest",
    ),
    (
        PLUGINS_DB,
        "backed_up",
        "plugin registry, records and settings",
    ),
    (
        PLUGIN_ARTIFACTS,
        "backed_up",
        "installed plugin artifacts, one hash per file",
    ),
    (
        "sessions.sqlite#history_index",
        "rebuilt",
        "the history search index is a projection of messages",
    ),
    (
        "host-resources.sqlite3",
        "excluded",
        "host-owned registry shared by every profile on the host",
    ),
    (
        "sessions.plugins/staging",
        "excluded",
        "transient install scratch",
    ),
];

/// How a format-4 bundle treats each profile store.
pub const COVERAGE_V4: &[(&str, &str, &str)] = &[
    (
        "sessions.sqlite",
        "backed_up",
        "conversations, attachments, activity and notification deliveries, the MCP catalog, and the skill catalog with its bundle blobs",
    ),
    ("sessions.review.sqlite3", "backed_up", "review feedback"),
    (
        "sessions.worktrees/lifecycle.sqlite3",
        "backed_up",
        "worktree lifecycle ledger; restore fences it",
    ),
    (
        "sessions.worktrees/empty.toml",
        "backed_up",
        "worktree manifest",
    ),
    (
        PLUGINS_DB,
        "backed_up",
        "plugin registry, records and settings",
    ),
    (
        PLUGIN_ARTIFACTS,
        "backed_up",
        "installed plugin artifacts, one hash per file",
    ),
    (
        "sessions.sqlite#history_index",
        "rebuilt",
        "the history search index is a projection of messages",
    ),
    (
        "host-resources.sqlite3",
        "excluded",
        "host-owned registry shared by every profile on the host",
    ),
    (
        "sessions.plugins/staging",
        "excluded",
        "transient install scratch",
    ),
    (
        BROWSER_LIBRARY,
        "backed_up",
        "named browser partitions, imported bookmarks and history, and held design captures",
    ),
    (
        "browser-import-staging",
        "excluded",
        "transient copies of import sources",
    ),
];
/// How a format-5 bundle treats each profile store.
pub const COVERAGE_V5: &[(&str, &str, &str)] = &[
    (
        "sessions.sqlite",
        "backed_up",
        "conversations, attachments, activity and notification deliveries, the MCP catalog, and the skill catalog with its bundle blobs",
    ),
    ("sessions.review.sqlite3", "backed_up", "review feedback"),
    (
        "sessions.worktrees/lifecycle.sqlite3",
        "backed_up",
        "worktree lifecycle ledger; restore fences it",
    ),
    (
        "sessions.worktrees/empty.toml",
        "backed_up",
        "worktree manifest",
    ),
    (
        PLUGINS_DB,
        "backed_up",
        "plugin registry, records and settings",
    ),
    (
        PLUGIN_ARTIFACTS,
        "backed_up",
        "installed plugin artifacts, one hash per file",
    ),
    (
        "sessions.sqlite#history_index",
        "rebuilt",
        "the history search index is a projection of messages",
    ),
    (
        "host-resources.sqlite3",
        "excluded",
        "host-owned registry shared by every profile on the host",
    ),
    (
        "sessions.plugins/staging",
        "excluded",
        "transient install scratch",
    ),
    (
        BROWSER_LIBRARY,
        "backed_up",
        "named browser partitions, imported bookmarks and history, and held design captures",
    ),
    (
        "browser-import-staging",
        "excluded",
        "transient copies of import sources",
    ),
    (
        "sessions.sqlite#service_secrets",
        "excluded",
        "secret service environment values; the bundle stores each as [redacted]",
    ),
];
/// How a format-6 bundle treats each profile store. It declares the same
/// exclusions as format 7.
pub const COVERAGE_V6: &[(&str, &str, &str)] = &[
    (
        "sessions.sqlite",
        "backed_up",
        "conversations, attachments, activity and notification deliveries, the MCP catalog, and the skill catalog with its bundle blobs",
    ),
    ("sessions.review.sqlite3", "backed_up", "review feedback"),
    (
        "sessions.worktrees/lifecycle.sqlite3",
        "backed_up",
        "worktree lifecycle ledger; restore fences it",
    ),
    (
        "sessions.worktrees/empty.toml",
        "backed_up",
        "worktree manifest",
    ),
    (
        PLUGINS_DB,
        "backed_up",
        "plugin registry, records and settings",
    ),
    (
        PLUGIN_ARTIFACTS,
        "backed_up",
        "installed plugin artifacts, one hash per file",
    ),
    (
        "sessions.sqlite#history_index",
        "rebuilt",
        "the history search index is a projection of messages",
    ),
    (
        "host-resources.sqlite3",
        "excluded",
        "host-owned registry shared by every profile on the host",
    ),
    (
        "sessions.plugins/staging",
        "excluded",
        "transient install scratch",
    ),
    (
        BROWSER_LIBRARY,
        "backed_up",
        "named browser partitions, imported bookmarks and history, and held design captures",
    ),
    (
        "browser-import-staging",
        "excluded",
        "transient copies of import sources",
    ),
    (
        "sessions.sqlite#service_secrets",
        "excluded",
        "secret service environment values; the bundle stores each as [redacted]",
    ),
    (
        "sessions.plugins.sqlite3#plugin_credentials",
        "excluded",
        "plugin credential references to items ADE made; the bundle drops each",
    ),
];
/// How a backup treats each profile store: `backed_up`, `rebuilt` or `excluded`.
pub const COVERAGE: &[(&str, &str, &str)] = &[
    (
        "sessions.sqlite",
        "backed_up",
        "conversations, attachments, activity and notification deliveries, the MCP catalog, and the skill catalog with its bundle blobs",
    ),
    ("sessions.review.sqlite3", "backed_up", "review feedback"),
    (
        "sessions.worktrees/lifecycle.sqlite3",
        "backed_up",
        "worktree lifecycle ledger; restore fences it",
    ),
    (
        "sessions.worktrees/empty.toml",
        "backed_up",
        "worktree manifest",
    ),
    (
        PLUGINS_DB,
        "backed_up",
        "plugin registry, records and settings",
    ),
    (
        PLUGIN_ARTIFACTS,
        "backed_up",
        "installed plugin artifacts, one hash per file",
    ),
    (
        "sessions.sqlite#history_index",
        "rebuilt",
        "the history search index is a projection of messages",
    ),
    (
        "host-resources.sqlite3",
        "excluded",
        "host-owned registry shared by every profile on the host",
    ),
    (
        "sessions.plugins/staging",
        "excluded",
        "transient install scratch",
    ),
    (
        BROWSER_LIBRARY,
        "backed_up",
        "named browser partitions, imported bookmarks and history, and held design captures",
    ),
    (
        "browser-import-staging",
        "excluded",
        "transient copies of import sources",
    ),
    (
        "sessions.sqlite#service_secrets",
        "excluded",
        "secret service environment values; the bundle stores each as [redacted]",
    ),
    (
        "sessions.plugins.sqlite3#plugin_credentials",
        "excluded",
        "plugin credential references to items ADE made; the bundle drops each",
    ),
    (
        ENVELOPE_DB,
        "backed_up",
        "effect receipts of enveloped commands; a retried operation ID replays its recorded outcome, and one still open settles as not applied or unknown, so none runs again",
    ),
    (
        BROWSER_OPERATIONS,
        "backed_up",
        "browser mutation receipts; a retried request ID replays its recorded reply, and one still open reopens as unknown, so none runs again",
    ),
];

pub fn coverage() -> Value {
    coverage_of(COVERAGE)
}

fn coverage_of(list: &[(&str, &str, &str)]) -> Value {
    Value::Array(
        list.iter()
            .map(|(store, disposition, reason)| {
                json!({"store":store,"disposition":disposition,"reason":reason})
            })
            .collect(),
    )
}

/// One file inside a directory entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileRecord {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    pub executable: bool,
}

impl FileRecord {
    pub fn to_json(&self) -> Value {
        json!({"path":self.path,"size":self.size,"sha256":self.sha256,"executable":self.executable})
    }
}

/// A validated manifest entry.
#[derive(Debug)]
pub struct Entry {
    pub path: String,
    pub kind: Kind,
    pub size: u64,
    pub sha256: String,
    pub schema: Option<i64>,
    pub files: Vec<FileRecord>,
}

/// A validated manifest.
#[derive(Debug)]
pub struct Plan {
    pub format: i64,
    pub entries: Vec<Entry>,
}

impl Plan {
    /// The files of the plugin artifact entry; empty when the bundle has none.
    pub fn artifact_files(&self) -> &[FileRecord] {
        self.entries
            .iter()
            .find(|entry| entry.path == PLUGIN_ARTIFACTS)
            .map_or(&[], |entry| entry.files.as_slice())
    }
    pub fn has(&self, path: &str) -> bool {
        self.entries.iter().any(|entry| entry.path == path)
    }
}

fn is_hex_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// A relative path that stays inside its root: no absolute path, empty,
/// `.` or `..` component, backslash or control character.
pub fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1024
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.chars().any(char::is_control)
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// SHA-256 over each path sorted, a NUL, the file's SHA-256 hex and a newline.
/// This is the plugin artifact digest, so a directory entry's files prove each
/// installed artifact's recorded digest.
pub fn tree_digest<'a>(files: impl IntoIterator<Item = (&'a str, &'a str)>) -> String {
    let mut sorted: Vec<_> = files.into_iter().collect();
    sorted.sort();
    let mut tree = Sha256::new();
    for (path, sha) in sorted {
        tree.update(path.as_bytes());
        tree.update([0]);
        tree.update(sha.as_bytes());
        tree.update(b"\n");
    }
    format!("sha256:{}", hex(&tree.finalize()))
}

/// What the plugin directory walk does with one entry below `sessions.plugins/`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Observed {
    Directory,
    File,
    /// A symbolic link, socket, device or FIFO.
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Descend,
    Take,
    Skip,
}

/// Decides one entry of `sessions.plugins/`, by its path relative to that
/// directory. `artifacts/` is backed up whole. `staging/` is install scratch
/// and is skipped. Anything else is refused, so a store added later cannot be
/// left out silently. Inside `artifacts/` a link or special file is refused:
/// the artifact store never holds one.
pub fn decide(relative: &str, observed: Observed) -> Result<Decision> {
    ensure!(
        safe_relative(relative),
        "Plugin store path is not a safe relative path: {relative:?}"
    );
    let mut parts = relative.splitn(2, '/');
    let top = parts.next().unwrap_or_default();
    let nested = parts.next().is_some();
    match (top, nested, observed) {
        ("staging", false, _) => Ok(Decision::Skip),
        ("artifacts", _, Observed::Directory) => Ok(Decision::Descend),
        ("artifacts", true, Observed::File) => Ok(Decision::Take),
        ("artifacts", _, _) => {
            bail!("Plugin artifact store holds a link or special file: {relative}")
        }
        _ => bail!("Plugin store holds an entry backup does not cover: {relative}"),
    }
}

/// The artifact directory relative to the artifact store, `<id>/<leaf>`,
/// from a recorded absolute `artifact_path`. The recorded path names the
/// source profile's data directory, which restore replaces.
pub fn artifact_relative(artifact_path: &str, id: &str) -> Result<String> {
    // Leaf, plugin ID, `artifacts`, `sessions.plugins`, then the data directory.
    let parts: Vec<&str> = artifact_path.rsplitn(5, '/').collect();
    ensure!(
        parts.len() == 5
            && !parts[4].is_empty()
            && parts[3] == "sessions.plugins"
            && parts[2] == "artifacts"
            && parts[1] == id
            && safe_relative(id)
            && safe_relative(parts[0]),
        "Plugin {id} records an artifact outside its profile's artifact store"
    );
    Ok(format!("{id}/{}", parts[0]))
}

/// The tree digest of the files under `relative/`, or `None` when there are none.
pub fn artifact_digest(files: &[FileRecord], relative: &str) -> Option<String> {
    let prefix = format!("{relative}/");
    let inside: Vec<_> = files
        .iter()
        .filter_map(|file| {
            file.path
                .strip_prefix(&prefix)
                .map(|path| (path, file.sha256.as_str()))
        })
        .collect();
    (!inside.is_empty()).then(|| tree_digest(inside))
}

/// Checks one installed plugin against the backed-up artifact files.
pub fn plugin_verdict(
    id: &str,
    artifact_path: &str,
    digest: &str,
    files: &[FileRecord],
) -> Result<String> {
    let relative = artifact_relative(artifact_path, id)?;
    ensure!(
        artifact_digest(files, &relative).as_deref() == Some(digest),
        "Plugin {id} artifact is missing or changed during backup; retry the backup, or reinstall the plugin"
    );
    Ok(relative)
}

/// Checks one stored skill bundle against its blobs: every manifest file has a
/// blob with the recorded path, digest and size, and there are no others.
/// `blobs` holds each blob's path, recorded SHA-256, and the SHA-256 and
/// length of its bytes.
pub fn skill_verdict(
    name: &str,
    content_hash: &str,
    manifest: &str,
    blobs: &[(String, String, String, u64)],
) -> Result<()> {
    let value: Value = serde_json::from_str(manifest)
        .with_context(|| format!("Skill {name} manifest is invalid"))?;
    ensure!(
        value["content_hash"] == content_hash,
        "Skill {name} manifest does not match its catalog row"
    );
    let mut expected = value["files"]
        .as_array()
        .with_context(|| format!("Skill {name} manifest is invalid"))?
        .iter()
        .map(|file| {
            Some((
                file["path"].as_str()?.to_owned(),
                file["sha256"].as_str()?.to_owned(),
                file["size"].as_u64()?,
            ))
        })
        .collect::<Option<Vec<_>>>()
        .with_context(|| format!("Skill {name} manifest is invalid"))?;
    expected.sort();
    let mut observed = Vec::with_capacity(blobs.len());
    for (path, recorded, actual, size) in blobs {
        ensure!(recorded == actual, "Skill {name} blob is damaged: {path}");
        observed.push((path.clone(), recorded.clone(), *size));
    }
    observed.sort();
    ensure!(expected == observed, "Skill {name} blobs are incomplete");
    Ok(())
}

/// Checks a bundle's `sessions.sqlite` holds no secret service value: every
/// stored service record, as its JSON, withholds each secret.
pub fn secrets_verdict<'a>(records: impl IntoIterator<Item = &'a str>) -> Result<()> {
    for record in records {
        let value: Value =
            serde_json::from_str(record).context("Backup holds an unreadable service record")?;
        ensure!(
            !ade_core::services::holds_secret_values(&value),
            "Backup holds a secret service value it declares excluded"
        );
    }
    Ok(())
}

/// Checks the history search index was left out: its tables are gone and any
/// index state asks the daemon for a rebuild.
pub fn projection_verdict(tables: &[String], index_version: Option<i64>) -> Result<()> {
    const PROJECTION: [&str; 3] = ["history_fts", "history_docs", "history_journal"];
    ensure!(
        !tables
            .iter()
            .any(|table| PROJECTION.contains(&table.as_str())),
        "Backup holds the history search index it declares excluded"
    );
    ensure!(
        index_version.is_none_or(|version| version == 0),
        "Backup history index state does not request a rebuild"
    );
    Ok(())
}

fn size(value: &Value) -> Result<u64> {
    value.as_u64().context("Invalid backup entry size")
}

fn digest(value: &Value) -> Result<String> {
    let text = value.as_str().context("Invalid backup entry digest")?;
    ensure!(is_hex_digest(text), "Invalid backup entry digest");
    Ok(text.into())
}

fn files(value: &Value) -> Result<Vec<FileRecord>> {
    let items = value.as_array().context("Invalid backup directory entry")?;
    ensure!(
        items.len() <= MAX_DIRECTORY_FILES,
        "Backup directory entry holds too many files"
    );
    let mut records = Vec::with_capacity(items.len());
    for item in items {
        let path = item["path"].as_str().context("Invalid backup file path")?;
        ensure!(safe_relative(path), "Invalid backup file path: {path:?}");
        records.push(FileRecord {
            path: path.into(),
            size: size(&item["size"])?,
            sha256: digest(&item["sha256"])?,
            executable: item["executable"]
                .as_bool()
                .context("Invalid backup file mode")?,
        });
    }
    ensure!(
        records.windows(2).all(|pair| pair[0].path < pair[1].path),
        "Backup directory files must be unique and sorted"
    );
    // A file path may not also be a directory prefix of another file.
    let names: BTreeSet<&str> = records.iter().map(|file| file.path.as_str()).collect();
    for file in &records {
        let mut prefix = file.path.as_str();
        while let Some((parent, _)) = prefix.rsplit_once('/') {
            ensure!(
                !names.contains(parent),
                "Backup directory file is also a directory: {parent}"
            );
            prefix = parent;
        }
    }
    Ok(records)
}

/// Validates a backend manifest's structure without touching the filesystem.
/// It accepts this format and the one before it, each with its own declared
/// exclusions, and checks every entry's shape. A directory entry's size and
/// digest must be the sum and tree digest of its files.
pub fn check_manifest(value: &Value) -> Result<Plan> {
    let format = value["format_version"].as_i64().unwrap_or(-1);
    let (excluded, coverage) = match format {
        FORMAT => (EXCLUDED, Some(COVERAGE)),
        6 => (EXCLUDED, Some(COVERAGE_V6)),
        5 => (EXCLUDED_V5, Some(COVERAGE_V5)),
        4 => (EXCLUDED_V4, Some(COVERAGE_V4)),
        3 => (EXCLUDED_V3, Some(COVERAGE_V3)),
        OLDEST_FORMAT => (EXCLUDED_V2, None),
        _ => bail!("Unsupported backend backup format or scope"),
    };
    ensure!(
        value["scope"] == SCOPE && value["excluded"] == json!(excluded),
        "Unsupported backend backup format or scope"
    );
    if let Some(list) = coverage {
        ensure!(
            value["coverage"] == coverage_of(list),
            "Backup coverage does not match this format"
        );
    }
    let raw = value["entries"]
        .as_array()
        .context("Invalid backup entries")?;
    let mut seen = BTreeSet::new();
    let mut entries = Vec::with_capacity(raw.len());
    for entry in raw {
        let name = entry["path"].as_str().context("Invalid backup path")?;
        let store = store(name)
            .filter(|store| store.since <= format)
            .context("Unknown backup path")?;
        ensure!(
            seen.insert(name) && entry["kind"] == store.kind.name(),
            "Duplicate or invalid backup entry"
        );
        let size = size(&entry["size"])?;
        let sha256 = digest(&entry["sha256"])?;
        let (schema, files) = match store.kind {
            Kind::Sqlite => (
                Some(entry["schema"].as_i64().context("Invalid backup schema")?),
                Vec::new(),
            ),
            Kind::Manifest => {
                ensure!(
                    entry["schema"].is_null() && size <= MAX_MANIFEST_BYTES,
                    "Invalid manifest entry"
                );
                (None, Vec::new())
            }
            Kind::Directory => {
                ensure!(entry["schema"].is_null(), "Invalid directory entry");
                let files = files(&entry["files"])?;
                let total = files
                    .iter()
                    .try_fold(0u64, |sum, file| sum.checked_add(file.size))
                    .context("Backup directory size overflows")?;
                ensure!(
                    total == size && total <= MAX_DIRECTORY_BYTES,
                    "Backup directory size does not match its files"
                );
                let tree = tree_digest(
                    files
                        .iter()
                        .map(|file| (file.path.as_str(), file.sha256.as_str())),
                );
                ensure!(
                    tree.strip_prefix("sha256:") == Some(sha256.as_str()),
                    "Backup directory digest does not match its files"
                );
                (None, files)
            }
        };
        entries.push(Entry {
            path: name.into(),
            kind: store.kind,
            size,
            sha256,
            schema,
            files,
        });
    }
    ensure!(
        seen.contains("sessions.sqlite"),
        "Backup lacks its profile database"
    );
    ensure!(
        seen.contains(PLUGINS_DB) == seen.contains(PLUGIN_ARTIFACTS),
        "Backup holds only half of the plugin registry"
    );
    Ok(Plan { format, entries })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sha(byte: char) -> String {
        byte.to_string().repeat(64)
    }
    fn file(path: &str, size: u64, byte: char) -> FileRecord {
        FileRecord {
            path: path.into(),
            size,
            sha256: sha(byte),
            executable: false,
        }
    }
    fn directory_entry(files: &[FileRecord]) -> Value {
        let tree = tree_digest(files.iter().map(|f| (f.path.as_str(), f.sha256.as_str())));
        json!({"path":PLUGIN_ARTIFACTS,"kind":"directory",
            "size":files.iter().map(|f| f.size).sum::<u64>(),
            "sha256":tree.strip_prefix("sha256:").unwrap(),
            "files":files.iter().map(FileRecord::to_json).collect::<Vec<_>>()})
    }
    fn manifest(entries: Vec<Value>) -> Value {
        json!({"format_version":FORMAT,"scope":SCOPE,"entries":entries,
            "excluded":EXCLUDED,"coverage":coverage()})
    }
    fn core() -> Value {
        json!({"path":"sessions.sqlite","kind":"sqlite","size":4096,"sha256":sha('a'),"schema":18})
    }
    fn plugins_db() -> Value {
        json!({"path":PLUGINS_DB,"kind":"sqlite","size":4096,"sha256":sha('b'),"schema":0})
    }

    #[test]
    fn plugin_store_entries_are_selected_skipped_or_refused() {
        use Decision::*;
        use Observed::*;
        assert_eq!(decide("artifacts", Directory).unwrap(), Descend);
        assert_eq!(decide("artifacts/p/1.0.0-ab", Directory).unwrap(), Descend);
        assert_eq!(
            decide("artifacts/p/1.0.0-ab/plugin.json", File).unwrap(),
            Take
        );
        assert_eq!(decide("staging", Directory).unwrap(), Skip);
        assert_eq!(decide("staging", File).unwrap(), Skip);
        let refused = [
            ("artifacts", File, "link or special file"),
            ("artifacts/p/link", Other, "link or special file"),
            ("artifacts", Other, "link or special file"),
            ("private", Directory, "does not cover"),
            ("notes.txt", File, "does not cover"),
            ("staging2", Directory, "does not cover"),
            ("artifacts/../x", File, "safe relative"),
            ("/artifacts/x", File, "safe relative"),
            ("artifacts//x", File, "safe relative"),
        ];
        for (path, observed, expected) in refused {
            let error = decide(path, observed).unwrap_err().to_string();
            assert!(error.contains(expected), "{path}: {error}");
        }
    }

    #[test]
    fn tree_digest_matches_the_plugin_artifact_scheme_and_ignores_order() {
        let a = tree_digest([("b.js", "22"), ("a.json", "11")]);
        let b = tree_digest([("a.json", "11"), ("b.js", "22")]);
        assert_eq!(a, b);
        let mut expected = Sha256::new();
        expected.update(b"a.json\x0011\nb.js\x0022\n");
        assert_eq!(a, format!("sha256:{}", hex(&expected.finalize())));
        assert_ne!(a, tree_digest([("a.json", "11"), ("b.js", "23")]));
    }

    #[test]
    fn artifact_paths_are_rebased_only_inside_the_artifact_store() {
        let path = "/p/runtime/data/sessions.plugins/artifacts/acme.x/1.0.0-0123456789abcdef";
        assert_eq!(
            artifact_relative(path, "acme.x").unwrap(),
            "acme.x/1.0.0-0123456789abcdef"
        );
        for (bad, id) in [
            (path, "other"),
            ("/p/data/elsewhere/artifacts/acme.x/1.0.0", "acme.x"),
            ("/p/data/sessions.plugins/staging/acme.x/1.0.0", "acme.x"),
            ("/p/data/sessions.plugins/artifacts/acme.x/..", "acme.x"),
            ("sessions.plugins/artifacts/acme.x", "acme.x"),
        ] {
            assert!(artifact_relative(bad, id).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_plugin_needs_its_whole_artifact_with_the_recorded_digest() {
        let files = vec![
            file("acme.x/1.0.0-ab/main.js", 3, 'c'),
            file("acme.x/1.0.0-ab/plugin.json", 2, 'd'),
            file("other/2.0.0-cd/plugin.json", 2, 'e'),
        ];
        let path = "/d/sessions.plugins/artifacts/acme.x/1.0.0-ab";
        let digest = tree_digest([
            ("main.js", sha('c').as_str()),
            ("plugin.json", sha('d').as_str()),
        ]);
        assert_eq!(
            plugin_verdict("acme.x", path, &digest, &files).unwrap(),
            "acme.x/1.0.0-ab"
        );
        let missing = plugin_verdict("acme.x", path, &digest, &files[2..]).unwrap_err();
        assert!(missing.to_string().contains("missing or changed"));
        let partial = plugin_verdict("acme.x", path, &digest, &files[1..]).unwrap_err();
        assert!(partial.to_string().contains("missing or changed"));
    }

    #[test]
    fn skill_bundles_need_every_blob_intact() {
        let manifest = json!({"content_hash":"h1","files":[
            {"path":"SKILL.md","sha256":"s1","size":10},{"path":"a/b.txt","sha256":"s2","size":4}]})
        .to_string();
        let blob = |path: &str, recorded: &str, actual: &str, size| {
            (
                path.to_owned(),
                recorded.to_owned(),
                actual.to_owned(),
                size,
            )
        };
        let whole = [
            blob("a/b.txt", "s2", "s2", 4),
            blob("SKILL.md", "s1", "s1", 10),
        ];
        assert!(skill_verdict("x", "h1", &manifest, &whole).is_ok());
        let cases: [(&str, Vec<_>, &str); 5] = [
            ("h1", vec![whole[1].clone()], "incomplete"),
            (
                "h1",
                vec![whole[0].clone(), blob("SKILL.md", "s1", "zz", 10)],
                "damaged",
            ),
            (
                "h1",
                vec![whole[0].clone(), blob("SKILL.md", "s1", "s1", 9)],
                "incomplete",
            ),
            (
                "h1",
                [whole.to_vec(), vec![blob("extra", "s3", "s3", 1)]].concat(),
                "incomplete",
            ),
            ("h2", whole.to_vec(), "does not match"),
        ];
        for (hash, blobs, expected) in cases {
            let error = skill_verdict("x", hash, &manifest, &blobs).unwrap_err();
            assert!(error.to_string().contains(expected), "{expected}: {error}");
        }
        assert!(skill_verdict("x", "h1", "not json", &whole).is_err());
    }

    #[test]
    fn the_history_index_must_be_left_for_a_rebuild() {
        let tables = |names: &[&str]| names.iter().map(|n| n.to_string()).collect::<Vec<_>>();
        assert!(projection_verdict(&tables(&["messages", "history_index_state"]), Some(0)).is_ok());
        assert!(projection_verdict(&tables(&["messages"]), None).is_ok());
        assert!(projection_verdict(&tables(&["messages", "history_fts"]), Some(0)).is_err());
        assert!(projection_verdict(&tables(&["history_docs"]), None).is_err());
        assert!(projection_verdict(&tables(&["messages"]), Some(1)).is_err());
    }

    #[test]
    fn manifests_declare_their_format_exclusions_and_coverage() {
        let files = [
            file("p/1-ab/plugin.json", 2, 'c'),
            file("p/1-ab/x/y.js", 5, 'd'),
        ];
        let plan = check_manifest(&manifest(vec![
            core(),
            plugins_db(),
            directory_entry(&files),
        ]))
        .unwrap();
        assert_eq!(plan.format, FORMAT);
        assert_eq!(plan.artifact_files(), &files);
        assert!(plan.has(PLUGINS_DB));

        let previous =
            json!({"format_version":2,"scope":SCOPE,"entries":[core()],"excluded":EXCLUDED_V2});
        assert_eq!(check_manifest(&previous).unwrap().format, 2);
        let mut previous_with_plugins = previous.clone();
        previous_with_plugins["entries"] = json!([core(), plugins_db()]);
        assert!(check_manifest(&previous_with_plugins).is_err());

        let mut wrong_exclusions = manifest(vec![core()]);
        wrong_exclusions["excluded"] = json!(EXCLUDED_V2);
        let mut no_coverage = manifest(vec![core()]);
        no_coverage["coverage"] = Value::Null;
        let mut future = manifest(vec![core()]);
        future["format_version"] = json!(FORMAT + 1);
        for (value, expected) in [
            (wrong_exclusions, "format or scope"),
            (no_coverage, "coverage"),
            (future, "format or scope"),
            (json!({"format_version":1}), "format or scope"),
            (manifest(vec![]), "lacks its profile database"),
            (manifest(vec![core(), core()]), "Duplicate"),
            (
                manifest(vec![core(), plugins_db()]),
                "half of the plugin registry",
            ),
            (
                manifest(vec![core(), json!({"path":"x.sqlite","kind":"sqlite"})]),
                "Unknown",
            ),
        ] {
            let error = check_manifest(&value).unwrap_err().to_string();
            assert!(error.contains(expected), "{expected}: {error}");
        }
    }

    #[test]
    fn the_browser_library_is_backed_up_from_format_4() {
        // The daemon creates the library beside sessions.sqlite; a backup that
        // leaves it out drops the profile's partitions and imports.
        let library = ade_daemon::browser_library::LIBRARY_FILE;
        assert_eq!(library, BROWSER_LIBRARY);
        let entry = store(library).expect("browser library is a backup store");
        assert_eq!(
            (entry.kind, entry.schema, entry.since),
            (Kind::Sqlite, 0, 4)
        );
        assert!(
            COVERAGE
                .iter()
                .any(|(path, disposition, _)| *path == library && *disposition == "backed_up")
        );
        let library_entry = json!({"path":library,"kind":"sqlite","size":4096,
            "sha256":sha('e'),"schema":0});
        let plan = check_manifest(&manifest(vec![core(), library_entry.clone()])).unwrap();
        assert!(plan.has(library));

        // A format-3 bundle keeps its own exclusions and coverage, and may not
        // claim the library.
        let v3 = |entries: Vec<Value>| {
            json!({"format_version":3,"scope":SCOPE,"entries":entries,
                "excluded":EXCLUDED_V3,"coverage":coverage_of(COVERAGE_V3)})
        };
        assert_eq!(check_manifest(&v3(vec![core()])).unwrap().format, 3);
        let error = check_manifest(&v3(vec![core(), library_entry]))
            .unwrap_err()
            .to_string();
        assert!(error.contains("Unknown"), "{error}");
        let mut v3_with_v4_coverage = v3(vec![core()]);
        v3_with_v4_coverage["coverage"] = coverage();
        assert!(check_manifest(&v3_with_v4_coverage).is_err());
    }

    #[test]
    fn format_5_declares_withheld_service_secrets_and_format_4_still_reads() {
        assert!(
            EXCLUDED
                .iter()
                .any(|item| item.starts_with("secret service environment values"))
        );
        assert!(COVERAGE.iter().any(|(store, disposition, _)| {
            *store == "sessions.sqlite#service_secrets" && *disposition == "excluded"
        }));
        let v4 = json!({"format_version":4,"scope":SCOPE,"entries":[core()],
            "excluded":EXCLUDED_V4,"coverage":coverage_of(COVERAGE_V4)});
        assert_eq!(check_manifest(&v4).unwrap().format, 4);
        // A format-5 manifest may not drop the secrets exclusion.
        let mut understated = manifest(vec![core()]);
        understated["excluded"] = json!(EXCLUDED_V4);
        assert!(check_manifest(&understated).is_err());

        let withheld =
            r#"{"config":{"env":{"TOKEN":"[redacted]","MODE":"dev"},"secret_env":["TOKEN"]}}"#;
        let plain = r#"{"config":{"env":{"MODE":"dev"}}}"#;
        let leaked = r#"{"config":{"env":{"TOKEN":"s3cret"},"secret_env":["TOKEN"]}}"#;
        assert!(secrets_verdict([withheld, plain]).is_ok());
        let error = secrets_verdict([withheld, leaked]).unwrap_err().to_string();
        assert!(error.contains("secret service value"), "{error}");
        assert!(secrets_verdict(["not json"]).is_err());
    }

    #[test]
    fn format_6_declares_dropped_plugin_credentials_and_format_5_still_reads() {
        assert!(
            EXCLUDED
                .iter()
                .any(|item| item.starts_with("plugin credential references"))
        );
        assert!(COVERAGE.iter().any(|(store, disposition, _)| {
            *store == "sessions.plugins.sqlite3#plugin_credentials" && *disposition == "excluded"
        }));
        let v5 = json!({"format_version":5,"scope":SCOPE,"entries":[core()],
            "excluded":EXCLUDED_V5,"coverage":coverage_of(COVERAGE_V5)});
        assert_eq!(check_manifest(&v5).unwrap().format, 5);
        // A format-6 manifest may not drop the plugin credential exclusion.
        let mut understated = manifest(vec![core()]);
        understated["excluded"] = json!(EXCLUDED_V5);
        assert!(check_manifest(&understated).is_err());
        let mut uncovered = manifest(vec![core()]);
        uncovered["coverage"] = coverage_of(COVERAGE_V5);
        assert!(check_manifest(&uncovered).is_err());
    }

    #[test]
    fn format_7_backs_up_both_receipt_stores_and_format_6_still_reads() {
        // The envelope store's name comes from the daemon, so they cannot drift.
        let envelope =
            ade_daemon::receipts::envelope_store(std::path::Path::new("sessions.sqlite"));
        assert_eq!(envelope.to_str(), Some(ENVELOPE_DB));
        let entry = |path: &str| json!({"path":path,"kind":"sqlite","size":4096,"sha256":sha('e'),"schema":0});
        for path in [ENVELOPE_DB, BROWSER_OPERATIONS] {
            let store = store(path).expect("receipt store is a backup store");
            assert_eq!(
                (store.kind, store.schema, store.since),
                (Kind::Sqlite, 0, 7)
            );
            assert!(COVERAGE.iter().any(|(covered, disposition, _)| {
                *covered == path && *disposition == "backed_up"
            }));
            assert!(
                check_manifest(&manifest(vec![core(), entry(path)]))
                    .unwrap()
                    .has(path)
            );
        }
        // A format-6 bundle reads with its own coverage, and may not claim a
        // receipt store.
        let v6 = |entries: Vec<Value>| {
            json!({"format_version":6,"scope":SCOPE,"entries":entries,
                "excluded":EXCLUDED,"coverage":coverage_of(COVERAGE_V6)})
        };
        assert_eq!(check_manifest(&v6(vec![core()])).unwrap().format, 6);
        let error = check_manifest(&v6(vec![core(), entry(ENVELOPE_DB)]))
            .unwrap_err()
            .to_string();
        assert!(error.contains("Unknown"), "{error}");
        // A format-7 manifest may not drop the receipt stores from its coverage.
        let mut understated = manifest(vec![core()]);
        understated["coverage"] = coverage_of(COVERAGE_V6);
        assert!(check_manifest(&understated).is_err());
    }

    #[test]
    fn directory_entries_must_add_up_to_their_files() {
        let files = [file("p/a", 2, 'c'), file("p/b", 3, 'd')];
        let check = |entry: Value| check_manifest(&manifest(vec![core(), plugins_db(), entry]));
        assert!(check(directory_entry(&files)).is_ok());
        assert!(check(directory_entry(&[])).is_ok());

        let mut size = directory_entry(&files);
        size["size"] = json!(4);
        let mut digest = directory_entry(&files);
        digest["sha256"] = json!(sha('f'));
        let mut unsorted = directory_entry(&files);
        unsorted["files"] = json!([files[1].to_json(), files[0].to_json()]);
        let mut escaping = directory_entry(&[file("../x", 1, 'c')]);
        escaping["files"][0]["path"] = json!("../x");
        let nested = directory_entry(&[file("p", 1, 'c'), file("p/a", 1, 'd')]);
        let mut mode = directory_entry(&files);
        mode["files"][0]["executable"] = Value::Null;
        let mut schema = directory_entry(&files);
        schema["schema"] = json!(1);
        for (entry, expected) in [
            (size, "size does not match"),
            (digest, "digest does not match"),
            (unsorted, "unique and sorted"),
            (escaping, "Invalid backup file path"),
            (nested, "also a directory"),
            (mode, "mode"),
            (schema, "Invalid directory entry"),
        ] {
            let error = check(entry).unwrap_err().to_string();
            assert!(error.contains(expected), "{expected}: {error}");
        }
    }
}
