//! Bounded, read-only workspace inspection. Opened directory descriptors, rather
//! than re-resolved paths, are the authority for every child lookup.
use crate::scripts::decode;
use ade_core::contract::files::{
    FileEntry, FileKind, FileList, FileListRequest, FilePreview, FilePreviewRequest, FileSearch,
    FileSearchRequest, PreviewKind,
};
use ade_core::error::NeedsRebind;
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::Value;
use std::{
    collections::HashMap,
    ffi::{CStr, CString},
    fs::File,
    io::Read,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::ffi::OsStrExt,
    },
    path::{Component, Path},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

const PREVIEW_LIMIT: usize = 256 * 1024;
const PAGE_LIMIT: usize = 100;
const SEARCH_SCAN_LIMIT: usize = 1000;
const LIST_SCAN_LIMIT: usize = 10_000;
const SEARCH_DEPTH_LIMIT: usize = 32;
const SEARCH_VISITED_LIMIT: usize = 1024;
const MAX_SCANS: usize = 8;
const SCAN_LIFETIME: Duration = Duration::from_secs(60);
const RAW_NAME_PREFIX: &str = "\u{e000}";

fn encode_name(raw: &[u8]) -> String {
    if let Ok(name) = std::str::from_utf8(raw)
        && !name.starts_with(RAW_NAME_PREFIX)
    {
        return name.to_owned();
    }
    format!("{RAW_NAME_PREFIX}{}", URL_SAFE_NO_PAD.encode(raw))
}

fn decode_name(name: &str) -> Result<Vec<u8>> {
    let bytes = if let Some(encoded) = name.strip_prefix(RAW_NAME_PREFIX) {
        URL_SAFE_NO_PAD
            .decode(encoded)
            .context("Invalid encoded file name")?
    } else {
        name.as_bytes().to_vec()
    };
    ensure!(
        !bytes.is_empty()
            && bytes != b"."
            && bytes != b".."
            && !bytes.contains(&0)
            && !bytes.contains(&b'/'),
        "Invalid file name"
    );
    Ok(bytes)
}

fn display_name(name: &str) -> Result<String> {
    Ok(String::from_utf8_lossy(&decode_name(name)?).into_owned())
}

#[derive(Clone)]
struct Frame {
    path: String,
    device: u64,
    inode: u64,
    mtime_seconds: i64,
    mtime_nanos: i64,
    ctime_seconds: i64,
    ctime_nanos: i64,
}

pub struct Files {
    scans: Arc<Mutex<HashMap<String, Scan>>>,
    lifetime: Duration,
}
struct Scan {
    workspace_id: String,
    identity: (u64, u64),
    root: Frame,
    operation: ScanOperation,
    touched: Instant,
}
enum ScanOperation {
    List {
        path: String,
        current: LiveFrame,
    },
    Search {
        query: String,
        stack: Vec<LiveFrame>,
        visited: Vec<Frame>,
        incomplete: bool,
    },
}

struct Directory(*mut libc::DIR);
// A directory stream moves between request threads only while exclusively owned
// by a Scan. No two threads ever call readdir on the same stream concurrently.
unsafe impl Send for Directory {}
struct LiveFrame {
    frame: Frame,
    fd: OwnedFd,
    directory: Directory,
}
impl Drop for Directory {
    fn drop(&mut self) {
        unsafe { libc::closedir(self.0) };
    }
}
impl Directory {
    fn from_fd(fd: &OwnedFd) -> Result<Self> {
        let duplicate = unsafe { libc::dup(fd.as_raw_fd()) };
        if duplicate < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let directory = unsafe { libc::fdopendir(duplicate) };
        if directory.is_null() {
            unsafe { libc::close(duplicate) };
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(Self(directory))
    }
    fn next(&mut self) -> Result<Option<String>> {
        loop {
            #[cfg(target_os = "macos")]
            unsafe {
                *libc::__error() = 0
            };
            #[cfg(target_os = "linux")]
            unsafe {
                *libc::__errno_location() = 0
            };
            let entry = unsafe { libc::readdir(self.0) };
            if entry.is_null() {
                let error = std::io::Error::last_os_error();
                return if error.raw_os_error() == Some(0) {
                    Ok(None)
                } else {
                    Err(error.into())
                };
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
            let raw = name.to_bytes();
            if raw == b"." || raw == b".." {
                continue;
            }
            return Ok(Some(encode_name(raw)));
        }
    }
}
fn live_frame(root: &OwnedFd, frame: Frame) -> Result<LiveFrame> {
    let fd = open_directory(root, &frame.path)?;
    ensure!(
        same_stamp(&frame, &stat(fd.as_raw_fd())?),
        "File search changed; refresh"
    );
    let directory = Directory::from_fd(&fd)?;
    Ok(LiveFrame {
        frame,
        fd,
        directory,
    })
}

fn stat(fd: RawFd) -> Result<libc::stat> {
    let mut value = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut value) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(value)
}
fn child_stat(fd: RawFd, name: &str) -> Result<libc::stat> {
    let name = CString::new(decode_name(name)?)?;
    let mut value = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstatat(fd, name.as_ptr(), &mut value, libc::AT_SYMLINK_NOFOLLOW) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(value)
}
fn kind(metadata: &libc::stat) -> FileKind {
    match metadata.st_mode & libc::S_IFMT {
        libc::S_IFDIR => FileKind::Directory,
        libc::S_IFREG => FileKind::File,
        libc::S_IFLNK => FileKind::Symlink,
        _ => FileKind::Other,
    }
}
fn entry(parent: &str, name: &str, metadata: &libc::stat) -> FileEntry {
    let path = if parent.is_empty() {
        name.to_owned()
    } else {
        format!("{parent}/{name}")
    };
    let kind = kind(metadata);
    FileEntry {
        name: display_name(name).unwrap_or_else(|_| name.to_owned()),
        path,
        kind,
        size: (kind == FileKind::File).then(|| metadata.st_size.max(0) as u64),
    }
}
fn stamp(path: String, metadata: &libc::stat) -> Frame {
    Frame {
        path,
        device: metadata.st_dev as u64,
        inode: metadata.st_ino,
        mtime_seconds: metadata.st_mtime,
        mtime_nanos: metadata.st_mtime_nsec,
        ctime_seconds: metadata.st_ctime,
        ctime_nanos: metadata.st_ctime_nsec,
    }
}
fn same_stamp(frame: &Frame, metadata: &libc::stat) -> bool {
    frame.device == metadata.st_dev as u64
        && frame.inode == metadata.st_ino
        && frame.mtime_seconds == metadata.st_mtime
        && frame.mtime_nanos == metadata.st_mtime_nsec
        && frame.ctime_seconds == metadata.st_ctime
        && frame.ctime_nanos == metadata.st_ctime_nsec
}
impl Files {
    pub fn new() -> Self {
        let lifetime = std::env::var("ADE_E2E_FILE_SCAN_TTL_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| (10..=1000).contains(value))
            .map(Duration::from_millis)
            .unwrap_or(SCAN_LIFETIME);
        let scans = Arc::new(Mutex::new(HashMap::<String, Scan>::new()));
        let weak = Arc::downgrade(&scans);
        thread::spawn(move || {
            loop {
                thread::sleep(lifetime.min(Duration::from_secs(5)));
                let Some(scans) = weak.upgrade() else { break };
                scans
                    .lock()
                    .unwrap()
                    .retain(|_, scan| scan.touched.elapsed() < lifetime);
            }
        });
        Self { scans, lifetime }
    }

    fn take(
        &self,
        token: &str,
        workspace_id: &str,
        identity: (u64, u64),
        operation: &str,
        target: &str,
    ) -> Result<Scan> {
        ensure!(
            token.len() == 32 && token.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "Invalid file cursor"
        );
        let mut scans = self.scans.lock().unwrap();
        scans.retain(|_, scan| scan.touched.elapsed() < self.lifetime);
        let saved = scans
            .get(token)
            .context("File cursor expired or was already used; refresh")?;
        ensure!(
            saved.workspace_id == workspace_id && saved.identity == identity,
            "File cursor belongs to another workspace"
        );
        let matches = match &saved.operation {
            ScanOperation::List { path, .. } => operation == "file.list" && path == target,
            ScanOperation::Search { query, .. } => operation == "file.search" && query == target,
        };
        ensure!(
            matches,
            "File cursor belongs to another file operation or target"
        );
        scans
            .remove(token)
            .context("File cursor expired or was already used; refresh")
    }

    fn save(&self, mut scan: Scan) -> Result<String> {
        scan.touched = Instant::now();
        let mut scans = self.scans.lock().unwrap();
        scans.retain(|_, saved| saved.touched.elapsed() < self.lifetime);
        if scans.len() >= MAX_SCANS
            && let Some(oldest) = scans
                .iter()
                .min_by_key(|(_, saved)| saved.touched)
                .map(|(token, _)| token.clone())
        {
            scans.remove(&oldest);
        }
        loop {
            let mut random = [0u8; 16];
            if unsafe { libc::getentropy(random.as_mut_ptr().cast(), random.len()) } != 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            let token = random
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            if let std::collections::hash_map::Entry::Vacant(entry) = scans.entry(token.clone()) {
                entry.insert(scan);
                return Ok(token);
            }
        }
    }
}

fn validate_frame(root: &OwnedFd, current: &LiveFrame) -> Result<()> {
    ensure!(
        same_stamp(&current.frame, &stat(current.fd.as_raw_fd())?),
        "File tree changed; refresh"
    );
    let reopened = open_directory(root, &current.frame.path)?;
    ensure!(
        same_stamp(&current.frame, &stat(reopened.as_raw_fd())?),
        "File path changed; refresh"
    );
    Ok(())
}

fn validate_visited(root: &OwnedFd, frame: &Frame) -> Result<()> {
    let reopened = open_directory(root, &frame.path)?;
    ensure!(
        same_stamp(frame, &stat(reopened.as_raw_fd())?),
        "File search changed; refresh"
    );
    Ok(())
}
fn relative(path: &str) -> Result<Vec<String>> {
    ensure!(
        path.len() <= 4096 && !path.contains('\0'),
        "Invalid workspace path"
    );
    let mut parts = Vec::new();
    for component in Path::new(path).components() {
        match component {
            Component::Normal(name) => {
                let name = name.to_str().context("Workspace path must be UTF-8")?;
                parts.push(name.to_owned());
            }
            Component::CurDir => {}
            _ => bail!("Workspace path must be relative without parent traversal"),
        }
    }
    Ok(parts)
}
fn open_child(parent: RawFd, name: &str, directory: bool) -> Result<OwnedFd> {
    let name = CString::new(decode_name(name)?)?;
    let flags = libc::O_RDONLY
        | libc::O_CLOEXEC
        | libc::O_NOFOLLOW
        | libc::O_NONBLOCK
        | if directory { libc::O_DIRECTORY } else { 0 };
    let fd = unsafe { libc::openat(parent, name.as_ptr(), flags) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}
fn open_directory(root: &OwnedFd, path: &str) -> Result<OwnedFd> {
    let mut current = root.try_clone()?;
    for part in relative(path)? {
        current = open_child(current.as_raw_fd(), &part, true)?;
    }
    Ok(current)
}
fn root_fd(path: &str, expected: (u64, u64)) -> Result<OwnedFd> {
    let name = CString::new(Path::new(path).as_os_str().as_bytes())?;
    let fd = unsafe {
        libc::open(
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    let metadata = stat(fd.as_raw_fd())?;
    if (metadata.st_dev as u64, metadata.st_ino) != expected {
        return Err(NeedsRebind.into());
    }
    Ok(fd)
}
/// Rejects the malformed fields the handler reported by name before it was
/// typed, so those messages survive the typed decode.
fn check_page_fields(request: &Value) -> Result<()> {
    if request.get("limit").is_some_and(|limit| !limit.is_u64()) {
        bail!("Invalid file page limit");
    }
    if request
        .get("cursor")
        .is_some_and(|cursor| !cursor.is_null() && !cursor.is_string())
    {
        bail!("Invalid file cursor");
    }
    Ok(())
}
fn page_limit(limit: Option<u64>) -> Result<usize> {
    let requested = limit.unwrap_or(PAGE_LIMIT as u64);
    ensure!(
        (1..=PAGE_LIMIT as u64).contains(&requested),
        "File page limit must be 1 to 100"
    );
    Ok(requested as usize)
}

impl Files {
    fn list(
        &self,
        root: &OwnedFd,
        workspace_id: &str,
        identity: (u64, u64),
        request: &Value,
    ) -> Result<Value> {
        check_page_fields(request)?;
        let list: FileListRequest = decode(request, &[])?;
        let path = list.path.as_deref().unwrap_or("");
        let _ = relative(path)?;
        let limit = page_limit(list.limit)?;
        let mut scan = if let Some(token) = list.cursor.as_deref() {
            self.take(token, workspace_id, identity, "file.list", path)?
        } else {
            let fd = open_directory(root, path)?;
            let frame = stamp(path.to_owned(), &stat(fd.as_raw_fd())?);
            let directory = Directory::from_fd(&fd)?;
            Scan {
                workspace_id: workspace_id.to_owned(),
                identity,
                root: stamp(String::new(), &stat(root.as_raw_fd())?),
                operation: ScanOperation::List {
                    path: path.to_owned(),
                    current: LiveFrame {
                        frame,
                        fd,
                        directory,
                    },
                },
                touched: Instant::now(),
            }
        };
        ensure!(
            scan.workspace_id == workspace_id
                && scan.identity == identity
                && same_stamp(&scan.root, &stat(root.as_raw_fd())?),
            "File cursor belongs to another or changed workspace"
        );
        let ScanOperation::List {
            path: saved_path,
            current,
        } = &mut scan.operation
        else {
            bail!("File cursor belongs to another operation")
        };
        ensure!(saved_path == path, "File cursor belongs to another folder");
        validate_frame(root, current)?;
        let mut entries = Vec::new();
        let mut scanned = 0;
        let mut ended = false;
        while entries.len() < limit && scanned < LIST_SCAN_LIMIT {
            let Some(name) = current.directory.next()? else {
                ended = true;
                break;
            };
            scanned += 1;
            match child_stat(current.fd.as_raw_fd(), &name) {
                Ok(metadata) => entries.push(entry(path, &name, &metadata)),
                Err(error)
                    if error
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound) =>
                {
                    continue;
                }
                Err(error) => return Err(error),
            }
        }
        validate_frame(root, current)?;
        let next_cursor = if ended { None } else { Some(self.save(scan)?) };
        Ok(serde_json::to_value(FileList {
            tag: Default::default(),
            path: path.to_owned(),
            entries,
            next_cursor,
            incomplete: false,
        })?)
    }

    fn search(
        &self,
        root: &OwnedFd,
        workspace_id: &str,
        identity: (u64, u64),
        request: &Value,
    ) -> Result<Value> {
        if !request["query"].is_string() {
            bail!("Missing query");
        }
        check_page_fields(request)?;
        let search: FileSearchRequest = decode(request, &[])?;
        let query = search.query.as_str();
        ensure!(
            !query.is_empty() && query.len() <= 256,
            "File query must be 1 to 256 bytes"
        );
        let query = query.to_lowercase();
        let limit = page_limit(search.limit)?;
        let mut scan = if let Some(token) = search.cursor.as_deref() {
            self.take(token, workspace_id, identity, "file.search", &query)?
        } else {
            let root_frame = stamp(String::new(), &stat(root.as_raw_fd())?);
            Scan {
                workspace_id: workspace_id.to_owned(),
                identity,
                root: root_frame.clone(),
                operation: ScanOperation::Search {
                    query: query.clone(),
                    stack: vec![live_frame(root, root_frame)?],
                    visited: Vec::new(),
                    incomplete: false,
                },
                touched: Instant::now(),
            }
        };
        ensure!(
            scan.workspace_id == workspace_id
                && scan.identity == identity
                && same_stamp(&scan.root, &stat(root.as_raw_fd())?),
            "File cursor belongs to another or changed workspace"
        );
        let ScanOperation::Search {
            query: saved_query,
            stack,
            visited,
            incomplete,
        } = &mut scan.operation
        else {
            bail!("File cursor belongs to another operation")
        };
        ensure!(
            *saved_query == query,
            "File cursor belongs to another query"
        );
        for current in stack.iter() {
            validate_frame(root, current)?;
        }
        let mut results = Vec::new();
        let mut scanned = 0;
        while !stack.is_empty() && results.len() < limit && scanned < SEARCH_SCAN_LIMIT {
            let current = stack.last_mut().context("Missing search frame")?;
            let Some(name) = current.directory.next()? else {
                validate_frame(root, current)?;
                let frame = stack.pop().context("Missing search frame")?.frame;
                if visited.len() == SEARCH_VISITED_LIMIT {
                    *incomplete = true;
                    stack.clear();
                    break;
                }
                visited.push(frame);
                continue;
            };
            scanned += 1;
            let metadata = match child_stat(current.fd.as_raw_fd(), &name) {
                Ok(metadata) => metadata,
                Err(error)
                    if error
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound) =>
                {
                    continue;
                }
                Err(error) => return Err(error),
            };
            let child_path = if current.frame.path.is_empty() {
                name.clone()
            } else {
                format!("{}/{name}", current.frame.path)
            };
            if child_path.len() > 4096 {
                *incomplete = true;
                continue;
            }
            if display_name(&name)?.to_lowercase().contains(&query) {
                results.push(entry(&current.frame.path, &name, &metadata));
            }
            if kind(&metadata) == FileKind::Directory {
                if stack.len() < SEARCH_DEPTH_LIMIT {
                    stack.push(live_frame(root, stamp(child_path, &metadata))?);
                } else {
                    *incomplete = true;
                }
            }
        }
        for current in stack.iter() {
            validate_frame(root, current)?;
        }
        for frame in visited.iter() {
            validate_visited(root, frame)?;
        }
        let incomplete_result = *incomplete;
        let next_cursor = if stack.is_empty() {
            None
        } else {
            Some(self.save(scan)?)
        };
        Ok(serde_json::to_value(FileSearch {
            tag: Default::default(),
            results,
            next_cursor,
            incomplete: incomplete_result,
        })?)
    }
}
impl Default for Files {
    fn default() -> Self {
        Self::new()
    }
}
fn preview(root: &OwnedFd, request: &Value) -> Result<Value> {
    if !request["path"].is_string() {
        bail!("Missing path");
    }
    let preview: FilePreviewRequest = decode(request, &[])?;
    let path = preview.path.as_str();
    let reply = |kind, mime: Option<&str>, text, bytes_base64, size, truncated| -> Result<Value> {
        Ok(serde_json::to_value(FilePreview {
            tag: Default::default(),
            path: path.to_owned(),
            kind,
            mime: mime.map(str::to_owned),
            text,
            bytes_base64,
            size,
            truncated,
        })?)
    };
    let parts = relative(path)?;
    let (name, parents) = parts.split_last().context("Preview requires a file path")?;
    let parent_path = parents.join("/");
    let parent = open_directory(root, &parent_path)?;
    let fd = open_child(parent.as_raw_fd(), name, false)?;
    let metadata = stat(fd.as_raw_fd())?;
    ensure!(
        kind(&metadata) == FileKind::File,
        "Preview requires a regular file"
    );
    let size = metadata.st_size.max(0) as u64;
    let decoded_name = decode_name(name)?;
    let extension = Path::new(std::ffi::OsStr::from_bytes(&decoded_name))
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(extension.as_str(), "html" | "htm" | "svg" | "xhtml" | "xml") {
        return reply(
            PreviewKind::Unsupported,
            None,
            None,
            None,
            size,
            size > PREVIEW_LIMIT as u64,
        );
    }
    let mime = match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    };
    let mut bytes = Vec::new();
    File::from(fd)
        .take((PREVIEW_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)?;
    let truncated = bytes.len() > PREVIEW_LIMIT || size > PREVIEW_LIMIT as u64;
    bytes.truncate(PREVIEW_LIMIT);
    if let Some(mime) = mime {
        // Only complete images are exposed. Partial image bytes are not useful.
        let valid = match mime {
            "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
            "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
            "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
            _ => false,
        };
        return if truncated || !valid {
            reply(PreviewKind::Unsupported, None, None, None, size, truncated)
        } else {
            let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
            reply(
                PreviewKind::Image,
                Some(mime),
                None,
                Some(encoded),
                size,
                false,
            )
        };
    }
    if truncated {
        while std::str::from_utf8(&bytes).is_err_and(|error| error.error_len().is_none()) {
            bytes.pop();
        }
    }
    match String::from_utf8(bytes) {
        Ok(text) if !text.contains('\0') => reply(
            PreviewKind::Text,
            Some("text/plain"),
            Some(text),
            None,
            size,
            truncated,
        ),
        _ => reply(PreviewKind::Unsupported, None, None, None, size, truncated),
    }
}

impl Files {
    pub fn command(
        &self,
        workspace_id: &str,
        path: &str,
        expected: (u64, u64),
        request: &Value,
    ) -> Result<Value> {
        let root = root_fd(path, expected)?;
        let result = match request["op"].as_str().unwrap_or("") {
            "file.list" => self.list(&root, workspace_id, expected, request),
            "file.search" => self.search(&root, workspace_id, expected, request),
            "file.preview" => preview(&root, request),
            _ => bail!("Unknown file operation"),
        }?;
        // A path swap after the initial open must not make a result appear to
        // describe the newly installed checkout.
        root_fd(path, expected)?;
        Ok(result)
    }
}
