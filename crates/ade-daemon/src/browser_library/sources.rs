//! Browser import sources (F093, decision D10): where each supported file
//! lives, which formats and versions are accepted, what is never imported,
//! and how entries are filtered and bounded. Pure: paths, bytes and rows in,
//! entries out. File and SQLite access lives in the parent module.
//!
//! Supported, on macOS only:
//!
//! | Source | Class | File | Accepted format |
//! |---|---|---|---|
//! | Chrome | bookmarks | `<profile>/Bookmarks` | JSON, `version` 1 |
//! | Chrome | history | `<profile>/History` | SQLite, `meta.version` 40 to 99 |
//! | Safari | bookmarks | `~/Library/Safari/Bookmarks.plist` | bplist00, `WebBookmarkFileVersion` 1 |
//! | Safari | history | `~/Library/Safari/History.db` | SQLite, `history_items` and `history_visits` |
//!
//! Everything else is refused, and `refusals` says why: cookies and saved
//! passwords are encrypted with a key in the macOS Keychain or are live
//! session state; ADE never decrypts them or clones a signed-in session.
use super::bplist::{self, Plist};
use ade_core::contract::browser::{BrowserImportClass, BrowserImportRefusal, BrowserImportSource};
use anyhow::{Result, bail, ensure};
use serde_json::Value;
use std::ops::RangeInclusive;
use std::path::{Path, PathBuf};

pub const CHROME_HISTORY_VERSIONS: RangeInclusive<i64> = 40..=99;
/// The most bookmarks one import stores.
pub const BOOKMARK_LIMIT: usize = 100_000;
/// The most history URLs one import stores, most recent first.
pub const HISTORY_LIMIT: usize = 50_000;
/// History rows scanned at most, to bound the work on a huge database.
pub const HISTORY_SCAN_LIMIT: usize = 2_000_000;
pub const URL_LIMIT: usize = 8192;
pub const TITLE_LIMIT: usize = 1024;
pub const FOLDER_DEPTH_LIMIT: usize = 64;
/// Bookmark files larger than this are refused.
pub const BOOKMARK_FILE_LIMIT: u64 = 64 * 1024 * 1024;
/// History databases larger than this are refused; they are copied first.
pub const HISTORY_FILE_LIMIT: u64 = 1024 * 1024 * 1024;

/// Milliseconds between 1601-01-01 (Chrome's epoch) and 1970-01-01.
const CHROME_EPOCH_OFFSET_MS: i64 = 11_644_473_600_000;
/// Seconds between 1970-01-01 and 2001-01-01 (Safari's epoch).
const SAFARI_EPOCH_OFFSET_S: f64 = 978_307_200.0;

/// True for `Default` or `Profile N`, the Chrome profile directories ADE reads.
/// `Guest Profile`, `System Profile` and any path are refused.
pub fn valid_chrome_profile(name: &str) -> bool {
    if name == "Default" {
        return true;
    }
    name.strip_prefix("Profile ").is_some_and(|n| {
        !n.is_empty()
            && n.len() <= 4
            && !n.starts_with('0')
            && n.bytes().all(|b| b.is_ascii_digit())
    })
}

/// The source profile an import reads: Chrome defaults to `Default`; Safari
/// takes none. Anything else is an invalid request.
pub fn source_profile(
    source: BrowserImportSource,
    requested: Option<&str>,
) -> Result<Option<String>> {
    match (source, requested) {
        (BrowserImportSource::Chrome, None) => Ok(Some("Default".into())),
        (BrowserImportSource::Chrome, Some(name)) if valid_chrome_profile(name) => {
            Ok(Some(name.into()))
        }
        (BrowserImportSource::Chrome, Some(_)) => {
            bail!("source_profile must be Default or Profile N")
        }
        (BrowserImportSource::Safari, None) => Ok(None),
        (BrowserImportSource::Safari, Some(_)) => {
            bail!("Safari imports read the default Safari profile only; omit source_profile")
        }
    }
}

/// The file each class reads, under `home`.
pub fn source_path(
    home: &Path,
    source: BrowserImportSource,
    profile: Option<&str>,
    class: BrowserImportClass,
) -> PathBuf {
    match source {
        BrowserImportSource::Chrome => {
            let directory = home
                .join("Library/Application Support/Google/Chrome")
                .join(profile.unwrap_or("Default"));
            directory.join(match class {
                BrowserImportClass::Bookmarks => "Bookmarks",
                BrowserImportClass::History => "History",
            })
        }
        BrowserImportSource::Safari => home.join("Library/Safari").join(match class {
            BrowserImportClass::Bookmarks => "Bookmarks.plist",
            BrowserImportClass::History => "History.db",
        }),
    }
}

/// What ADE never imports from a source, and why.
pub fn refusals(source: BrowserImportSource) -> Vec<BrowserImportRefusal> {
    let refuse = |class: &str, reason: &str| BrowserImportRefusal {
        class: class.into(),
        reason: reason.into(),
    };
    let mut refused = match source {
        BrowserImportSource::Chrome => vec![
            refuse(
                "cookies",
                "Chrome encrypts cookie values with a key in the macOS Keychain, and cookies are live sign-in state; ADE never decrypts or clones them",
            ),
            refuse(
                "passwords",
                "Chrome encrypts saved passwords with a key in the macOS Keychain; ADE never reads them",
            ),
            refuse(
                "autofill_and_payment_methods",
                "Autofill and card data are encrypted or personal records ADE does not import",
            ),
        ],
        BrowserImportSource::Safari => vec![
            refuse(
                "cookies",
                "Safari cookies are live sign-in state; ADE never clones a session",
            ),
            refuse(
                "passwords",
                "Safari passwords live in the macOS Keychain; ADE never reads them",
            ),
        ],
    };
    refused.extend([
        refuse(
            "open_tabs_and_sessions",
            "Open tabs and session restore data are live browser state",
        ),
        refuse(
            "local_storage_and_indexeddb",
            "Site storage is live page state tied to the source browser",
        ),
        refuse(
            "extensions",
            "Extensions are programs for another browser engine",
        ),
        refuse(
            "history_visits",
            "Only the latest visit of each URL is imported, not every visit",
        ),
    ]);
    refused
}

/// One bookmark as ADE stores it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bookmark {
    /// Folder names from the root, outermost first.
    pub folder: Vec<String>,
    pub title: String,
    pub url: String,
    pub added_at_ms: Option<i64>,
}

/// One history URL as ADE stores it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryEntry {
    pub url: String,
    pub title: String,
    pub visit_count: i64,
    pub last_visit_ms: Option<i64>,
}

/// Entries read from one class, with what was left out.
#[derive(Debug, Clone, PartialEq)]
pub struct Parsed<T> {
    pub format: String,
    pub entries: Vec<T>,
    pub skipped: u64,
    pub truncated: u64,
}

/// The URL as stored, or `None` when it is not importable: only `http` and
/// `https` URLs of at most `URL_LIMIT` bytes without control characters or
/// embedded user information (which can carry a password).
pub fn importable_url(url: &str) -> Option<String> {
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    let rest = if lower.starts_with("https://") {
        &url[8..]
    } else if lower.starts_with("http://") {
        &url[7..]
    } else {
        return None;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if url.len() > URL_LIMIT
        || authority.is_empty()
        || authority.contains('@')
        || url.chars().any(|c| c.is_control() || c == ' ')
    {
        return None;
    }
    Some(url.to_owned())
}

/// A title cut to `TITLE_LIMIT` characters with control characters replaced.
pub fn clean_title(title: &str) -> String {
    title
        .chars()
        .take(TITLE_LIMIT)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

/// Chrome time (microseconds since 1601-01-01) as Unix milliseconds; `None`
/// for zero, negative or out-of-range values.
pub fn chrome_time_ms(micros: i64) -> Option<i64> {
    (micros > 0)
        .then(|| micros / 1000 - CHROME_EPOCH_OFFSET_MS)
        .filter(|ms| *ms > 0)
}

/// Safari time (seconds since 2001-01-01) as Unix milliseconds.
pub fn safari_time_ms(seconds: f64) -> Option<i64> {
    let ms = (seconds + SAFARI_EPOCH_OFFSET_S) * 1000.0;
    (seconds.is_finite() && ms > 0.0 && ms < 1e15).then_some(ms as i64)
}

struct Collector {
    entries: Vec<Bookmark>,
    skipped: u64,
    truncated: u64,
}

impl Collector {
    fn push(&mut self, folder: &[String], title: &str, url: &str, added_at_ms: Option<i64>) {
        let Some(url) = importable_url(url) else {
            self.skipped += 1;
            return;
        };
        if self.entries.len() >= BOOKMARK_LIMIT {
            self.truncated += 1;
            return;
        }
        self.entries.push(Bookmark {
            folder: folder.to_vec(),
            title: clean_title(title),
            url,
            added_at_ms,
        });
    }
}

fn chrome_node(node: &Value, folder: &mut Vec<String>, out: &mut Collector) -> Result<()> {
    ensure!(
        folder.len() <= FOLDER_DEPTH_LIMIT,
        "Chrome bookmarks nest too deeply"
    );
    let name = node["name"].as_str().unwrap_or("");
    match node["type"].as_str() {
        Some("url") => {
            let added = node["date_added"]
                .as_str()
                .and_then(|value| value.parse::<i64>().ok())
                .and_then(chrome_time_ms);
            out.push(folder, name, node["url"].as_str().unwrap_or(""), added);
        }
        Some("folder") => {
            let Some(children) = node["children"].as_array() else {
                bail!("Chrome bookmark folder has no children list");
            };
            folder.push(clean_title(name));
            for child in children {
                chrome_node(child, folder, out)?;
            }
            folder.pop();
        }
        // Unknown node types are future formats: count them, never guess.
        _ => out.skipped += 1,
    }
    Ok(())
}

/// Reads Chrome's `Bookmarks` JSON (format version 1). The checksum is not
/// verified: ADE only reads the file.
pub fn parse_chrome_bookmarks(bytes: &[u8]) -> Result<Parsed<Bookmark>> {
    let root: Value = serde_json::from_slice(bytes)
        .map_err(|_| anyhow::anyhow!("Chrome bookmarks file is not valid JSON"))?;
    ensure!(
        root["version"].as_i64() == Some(1),
        "Chrome bookmarks format version {} is not supported; version 1 is",
        root["version"]
    );
    let Some(roots) = root["roots"].as_object() else {
        bail!("Chrome bookmarks file has no roots");
    };
    let mut out = Collector {
        entries: Vec::new(),
        skipped: 0,
        truncated: 0,
    };
    // Fixed order so repeated reads of one file store the same positions.
    for key in ["bookmark_bar", "other", "synced"] {
        if let Some(node) = roots.get(key).filter(|node| node.is_object()) {
            chrome_node(node, &mut Vec::new(), &mut out)?;
        }
    }
    Ok(Parsed {
        format: "chrome-bookmarks-json-1".into(),
        entries: out.entries,
        skipped: out.skipped,
        truncated: out.truncated,
    })
}

fn safari_node(node: &Plist, folder: &mut Vec<String>, out: &mut Collector) -> Result<()> {
    ensure!(
        folder.len() <= FOLDER_DEPTH_LIMIT,
        "Safari bookmarks nest too deeply"
    );
    match node.get("WebBookmarkType").and_then(Plist::as_str) {
        Some("WebBookmarkTypeLeaf") => {
            let title = node
                .get("URIDictionary")
                .and_then(|uri| uri.get("title"))
                .and_then(Plist::as_str)
                .unwrap_or("");
            let url = node.get("URLString").and_then(Plist::as_str).unwrap_or("");
            out.push(folder, title, url, None);
        }
        Some("WebBookmarkTypeList") => {
            let title = match node.get("Title").and_then(Plist::as_str).unwrap_or("") {
                "com.apple.ReadingList" => "Reading List",
                "BookmarksBar" => "Favorites",
                "BookmarksMenu" => "Bookmarks Menu",
                other => other,
            };
            let children = match node.get("Children") {
                Some(Plist::Array(children)) => children.as_slice(),
                None => &[],
                Some(_) => bail!("Safari bookmark folder children are not a list"),
            };
            let nested = !folder.is_empty() || !title.is_empty();
            if nested {
                folder.push(clean_title(title));
            }
            for child in children {
                safari_node(child, folder, out)?;
            }
            if nested {
                folder.pop();
            }
        }
        // History and other proxies point at Safari features, not bookmarks.
        Some("WebBookmarkTypeProxy") => {}
        _ => out.skipped += 1,
    }
    Ok(())
}

/// Reads Safari's `Bookmarks.plist` (bplist00, `WebBookmarkFileVersion` 1).
pub fn parse_safari_bookmarks(bytes: &[u8]) -> Result<Parsed<Bookmark>> {
    let root = bplist::parse(bytes)?;
    ensure!(
        root.get("WebBookmarkFileVersion") == Some(&Plist::Int(1)),
        "Safari bookmarks file version is not supported; version 1 is"
    );
    let mut out = Collector {
        entries: Vec::new(),
        skipped: 0,
        truncated: 0,
    };
    safari_node(&root, &mut Vec::new(), &mut out)?;
    Ok(Parsed {
        format: "safari-bookmarks-bplist-1".into(),
        entries: out.entries,
        skipped: out.skipped,
        truncated: out.truncated,
    })
}

fn has_columns(columns: &[String], required: &[&str]) -> Result<()> {
    for column in required {
        ensure!(
            columns.iter().any(|c| c == column),
            "History database lacks the {column} column"
        );
    }
    Ok(())
}

/// Accepts a Chrome `History` database by its `meta.version` and `urls`
/// columns, and names its format.
pub fn chrome_history_format(version: Option<i64>, urls_columns: &[String]) -> Result<String> {
    let Some(version) = version else {
        bail!("Chrome history database has no schema version");
    };
    ensure!(
        CHROME_HISTORY_VERSIONS.contains(&version),
        "Chrome history schema version {version} is not supported; versions {} to {} are",
        CHROME_HISTORY_VERSIONS.start(),
        CHROME_HISTORY_VERSIONS.end()
    );
    has_columns(
        urls_columns,
        &["url", "title", "visit_count", "last_visit_time", "hidden"],
    )?;
    Ok(format!("chrome-history-sqlite-{version}"))
}

/// Accepts a Safari `History.db` by its table columns.
pub fn safari_history_format(items: &[String], visits: &[String]) -> Result<String> {
    has_columns(items, &["id", "url", "visit_count"])?;
    has_columns(visits, &["history_item", "visit_time", "title"])?;
    Ok("safari-history-sqlite".into())
}

/// Filters and bounds history rows, which arrive most recent first.
pub struct HistoryCollector {
    parsed: Parsed<HistoryEntry>,
    scanned: usize,
}

impl HistoryCollector {
    pub fn new(format: String) -> Self {
        Self {
            parsed: Parsed {
                format,
                entries: Vec::new(),
                skipped: 0,
                truncated: 0,
            },
            scanned: 0,
        }
    }

    /// Takes one row. False once the scan bound is reached; the caller stops.
    pub fn push(
        &mut self,
        url: &str,
        title: &str,
        visits: i64,
        last_visit_ms: Option<i64>,
    ) -> bool {
        self.scanned += 1;
        if self.scanned > HISTORY_SCAN_LIMIT {
            self.parsed.truncated += 1;
            return false;
        }
        let Some(url) = importable_url(url) else {
            self.parsed.skipped += 1;
            return true;
        };
        if self.parsed.entries.len() >= HISTORY_LIMIT {
            self.parsed.truncated += 1;
            return true;
        }
        self.parsed.entries.push(HistoryEntry {
            url,
            title: clean_title(title),
            visit_count: visits.max(0),
            last_visit_ms,
        });
        true
    }

    /// The entries, with `remaining` unscanned rows counted as truncated.
    pub fn finish(mut self, remaining: u64) -> Parsed<HistoryEntry> {
        self.parsed.truncated += remaining;
        self.parsed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser_library::bplist::tests::{SAFARI_BOOKMARKS, hex};
    use serde_json::json;

    #[test]
    fn only_named_chrome_profiles_and_the_default_safari_profile_are_read() {
        for good in ["Default", "Profile 1", "Profile 42", "Profile 9999"] {
            assert!(valid_chrome_profile(good), "{good}");
        }
        for bad in [
            "",
            "Guest Profile",
            "System Profile",
            "Profile 0",
            "Profile 01",
            "Profile 10000",
            "Profile ",
            "../Default",
            "Default/../../x",
            "/etc",
        ] {
            assert!(!valid_chrome_profile(bad), "{bad}");
        }
        use BrowserImportSource::*;
        assert_eq!(
            source_profile(Chrome, None).unwrap().as_deref(),
            Some("Default")
        );
        assert!(source_profile(Chrome, Some("..")).is_err());
        assert_eq!(source_profile(Safari, None).unwrap(), None);
        assert!(source_profile(Safari, Some("Default")).is_err());
        let home = Path::new("/Users/a");
        assert_eq!(
            source_path(home, Chrome, Some("Profile 2"), BrowserImportClass::History),
            Path::new("/Users/a/Library/Application Support/Google/Chrome/Profile 2/History")
        );
        assert_eq!(
            source_path(home, Safari, None, BrowserImportClass::Bookmarks),
            Path::new("/Users/a/Library/Safari/Bookmarks.plist")
        );
    }

    #[test]
    fn encrypted_and_live_classes_are_always_refused() {
        for source in [BrowserImportSource::Chrome, BrowserImportSource::Safari] {
            let refused: Vec<String> = refusals(source).into_iter().map(|r| r.class).collect();
            for class in ["cookies", "passwords", "open_tabs_and_sessions"] {
                assert!(refused.iter().any(|c| c == class), "{source:?} {class}");
            }
        }
    }

    #[test]
    fn only_plain_http_urls_are_importable() {
        assert!(importable_url("https://a.test/x?y#z").is_some());
        assert!(importable_url("HTTP://a.test").is_some());
        for bad in [
            "javascript:alert(1)",
            "chrome://settings",
            "file:///etc/passwd",
            "https://user:secret@a.test/",
            "https://",
            "https://a.test/\nx",
            "http://a.test/ x",
            "data:text/html,hi",
        ] {
            assert!(importable_url(bad).is_none(), "{bad}");
        }
        assert!(importable_url(&format!("https://a.test/{}", "x".repeat(URL_LIMIT))).is_none());
        assert_eq!(clean_title("a\u{7}b"), "a b");
        assert_eq!(clean_title(&"é".repeat(2000)).chars().count(), TITLE_LIMIT);
    }

    #[test]
    fn epochs_convert_to_unix_milliseconds() {
        // 2021-01-01T00:00:00Z in each browser's clock.
        assert_eq!(
            chrome_time_ms(13_253_932_800_000_000),
            Some(1_609_459_200_000)
        );
        assert_eq!(safari_time_ms(631_152_000.0), Some(1_609_459_200_000));
        assert_eq!(chrome_time_ms(0), None);
        assert_eq!(safari_time_ms(f64::NAN), None);
    }

    #[test]
    fn chrome_bookmarks_keep_folders_and_skip_other_schemes() {
        let file = json!({"version": 1, "checksum": "x", "roots": {
            "bookmark_bar": {"type": "folder", "name": "Bookmarks bar", "children": [
                {"type": "url", "name": "A", "url": "https://a.test/",
                    "date_added": "13253932800000000"},
                {"type": "folder", "name": "Dev", "children": [
                    {"type": "url", "name": "B", "url": "http://b.test/"},
                    {"type": "url", "name": "JS", "url": "javascript:void(0)"}
                ]}
            ]},
            "other": {"type": "folder", "name": "Other", "children": [
                {"type": "separator"}
            ]},
            "synced": {"type": "folder", "name": "Mobile", "children": []}
        }});
        let parsed = parse_chrome_bookmarks(&serde_json::to_vec(&file).unwrap()).unwrap();
        assert_eq!(parsed.format, "chrome-bookmarks-json-1");
        assert_eq!(parsed.entries.len(), 2);
        assert_eq!(parsed.entries[0].added_at_ms, Some(1_609_459_200_000));
        assert_eq!(parsed.entries[1].folder, vec!["Bookmarks bar", "Dev"]);
        assert_eq!(parsed.skipped, 2);
        assert_eq!(parsed.truncated, 0);
        for bad in [
            json!({"version": 2, "roots": {}}),
            json!({"roots": {}}),
            json!({"version": 1}),
        ] {
            assert!(parse_chrome_bookmarks(&serde_json::to_vec(&bad).unwrap()).is_err());
        }
        assert!(parse_chrome_bookmarks(b"{not json").is_err());
    }

    #[test]
    fn chrome_bookmarks_are_bounded() {
        let many: Vec<Value> = (0..BOOKMARK_LIMIT + 3)
            .map(|i| json!({"type": "url", "name": "x", "url": format!("https://a.test/{i}")}))
            .collect();
        let file = json!({"version": 1, "roots": {"other":
            {"type": "folder", "name": "Other", "children": many}}});
        let parsed = parse_chrome_bookmarks(&serde_json::to_vec(&file).unwrap()).unwrap();
        assert_eq!(parsed.entries.len(), BOOKMARK_LIMIT);
        assert_eq!(parsed.truncated, 3);
        let mut deep = json!({"type": "url", "name": "x", "url": "https://a.test/"});
        for _ in 0..FOLDER_DEPTH_LIMIT + 2 {
            deep = json!({"type": "folder", "name": "f", "children": [deep]});
        }
        let file = json!({"version": 1, "roots": {"other": deep}});
        assert!(parse_chrome_bookmarks(&serde_json::to_vec(&file).unwrap()).is_err());
    }

    #[test]
    fn safari_bookmarks_skip_proxies_and_other_schemes() {
        let parsed = parse_safari_bookmarks(&hex(SAFARI_BOOKMARKS)).unwrap();
        assert_eq!(parsed.format, "safari-bookmarks-bplist-1");
        assert_eq!(
            parsed.entries,
            vec![Bookmark {
                folder: vec!["Favorites".into()],
                title: "Exämple".into(),
                url: "https://example.test/".into(),
                added_at_ms: None,
            }]
        );
        assert_eq!(parsed.skipped, 1);
        assert!(parse_safari_bookmarks(b"<?xml version=\"1.0\"?><plist/>").is_err());
    }

    #[test]
    fn history_schemas_are_checked_before_reading() {
        let cols = |names: &[&str]| names.iter().map(|n| n.to_string()).collect::<Vec<_>>();
        let urls = cols(&[
            "id",
            "url",
            "title",
            "visit_count",
            "typed_count",
            "last_visit_time",
            "hidden",
        ]);
        assert_eq!(
            chrome_history_format(Some(68), &urls).unwrap(),
            "chrome-history-sqlite-68"
        );
        assert!(chrome_history_format(Some(39), &urls).is_err());
        assert!(chrome_history_format(Some(100), &urls).is_err());
        assert!(chrome_history_format(None, &urls).is_err());
        assert!(chrome_history_format(Some(68), &cols(&["url", "title"])).is_err());
        assert!(
            safari_history_format(
                &cols(&["id", "url", "visit_count"]),
                &cols(&["id", "history_item", "visit_time", "title"])
            )
            .is_ok()
        );
        assert!(safari_history_format(&cols(&["id", "url"]), &cols(&["history_item"])).is_err());
    }

    #[test]
    fn history_rows_are_filtered_and_bounded() {
        let mut collector = HistoryCollector::new("f".into());
        assert!(collector.push("https://a.test/", "A", 3, Some(5)));
        assert!(collector.push("chrome://newtab", "", 1, None));
        assert!(collector.push("https://b.test/", "B", -4, None));
        let parsed = collector.finish(7);
        assert_eq!(parsed.entries.len(), 2);
        assert_eq!(parsed.entries[1].visit_count, 0);
        assert_eq!(parsed.skipped, 1);
        assert_eq!(parsed.truncated, 7);
        let mut full = HistoryCollector::new("f".into());
        for i in 0..HISTORY_LIMIT + 2 {
            full.push(&format!("https://a.test/{i}"), "", 1, None);
        }
        let parsed = full.finish(0);
        assert_eq!(parsed.entries.len(), HISTORY_LIMIT);
        assert_eq!(parsed.truncated, 2);
    }
}
