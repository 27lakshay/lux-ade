//! Bounded, read-only workspace inspection. Opened directory descriptors, rather
//! than re-resolved paths, are the authority for every child lookup.
use ade_core::error::NeedsRebind;
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    ffi::{CStr, CString},
    fs::File,
    io::Read,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::ffi::OsStrExt,
    },
    path::{Component, Path},
};

const PREVIEW_LIMIT: usize = 256 * 1024;
const PAGE_LIMIT: usize = 100;
const SEARCH_SCAN_LIMIT: usize = 1000;
const LIST_SCAN_LIMIT: usize = 10_000;
const CURSOR_LIMIT: usize = 16 * 1024;
const SEARCH_DEPTH_LIMIT: usize = 32;

#[derive(Clone, Serialize, Deserialize)]
struct Frame {
    path: String,
    device: u64,
    inode: u64,
    mtime_seconds: i64,
    mtime_nanos: i64,
}

#[derive(Serialize, Deserialize)]
struct Cursor {
    root_device: u64,
    root_inode: u64,
    #[serde(default)]
    query: String,
    #[serde(default)]
    after: String,
    frames: Vec<Frame>,
}

struct Directory(*mut libc::DIR);
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
            let name = std::str::from_utf8(name.to_bytes())
                .context("Workspace contains a non-UTF-8 file name")?;
            if name == "." || name == ".." {
                continue;
            }
            return Ok(Some(name.to_owned()));
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
    let name = CString::new(name)?;
    let mut value = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstatat(fd, name.as_ptr(), &mut value, libc::AT_SYMLINK_NOFOLLOW) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(value)
}
fn kind(metadata: &libc::stat) -> &'static str {
    match metadata.st_mode & libc::S_IFMT {
        libc::S_IFDIR => "directory",
        libc::S_IFREG => "file",
        libc::S_IFLNK => "symlink",
        _ => "other",
    }
}
fn entry(parent: &str, name: &str, metadata: &libc::stat) -> Value {
    let path = if parent.is_empty() {
        name.to_owned()
    } else {
        format!("{parent}/{name}")
    };
    json!({
        "name": name,
        "path": path,
        "kind": kind(metadata),
        "size": if kind(metadata) == "file" { Some(metadata.st_size.max(0) as u64) } else { None },
    })
}
fn stamp(path: String, metadata: &libc::stat) -> Frame {
    Frame {
        path,
        device: metadata.st_dev as u64,
        inode: metadata.st_ino,
        mtime_seconds: metadata.st_mtime,
        mtime_nanos: metadata.st_mtime_nsec,
    }
}
fn same_stamp(frame: &Frame, metadata: &libc::stat) -> bool {
    frame.device == metadata.st_dev as u64
        && frame.inode == metadata.st_ino
        && frame.mtime_seconds == metadata.st_mtime
        && frame.mtime_nanos == metadata.st_mtime_nsec
}
fn decode_cursor(value: &str) -> Result<Cursor> {
    ensure!(value.len() <= CURSOR_LIMIT, "File cursor is too large");
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .context("Invalid file cursor")?;
    ensure!(bytes.len() <= CURSOR_LIMIT, "File cursor is too large");
    serde_json::from_slice(&bytes).context("Invalid file cursor")
}
fn encode_cursor(cursor: &Cursor) -> Result<Option<String>> {
    let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(cursor)?);
    if encoded.len() > CURSOR_LIMIT {
        return Ok(None);
    }
    Ok(Some(encoded))
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
    let name = CString::new(name)?;
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
fn page_limit(request: &Value) -> Result<usize> {
    let requested = if request.get("limit").is_some() {
        request["limit"]
            .as_u64()
            .context("Invalid file page limit")?
    } else {
        PAGE_LIMIT as u64
    };
    ensure!(
        (1..=PAGE_LIMIT as u64).contains(&requested),
        "File page limit must be 1 to 100"
    );
    Ok(requested as usize)
}
fn list(root: &OwnedFd, request: &Value) -> Result<Value> {
    let path = request["path"].as_str().unwrap_or("");
    let _ = relative(path)?;
    let fd = open_directory(root, path)?;
    let metadata = stat(fd.as_raw_fd())?;
    let frame = stamp(path.to_owned(), &metadata);
    let mut after = String::new();
    if let Some(value) = request["cursor"].as_str() {
        let cursor = decode_cursor(value)?;
        ensure!(
            cursor.frames.len() == 1 && cursor.query.is_empty(),
            "Invalid file cursor"
        );
        let previous = &cursor.frames[0];
        ensure!(
            previous.path == path && same_stamp(previous, &metadata),
            "File listing changed; refresh"
        );
        after = cursor.after;
    }
    let mut directory = Directory::from_fd(&fd)?;
    let mut names = Vec::new();
    let mut scanned = 0;
    let mut reached_end = false;
    while scanned < LIST_SCAN_LIMIT {
        let Some(name) = directory.next()? else {
            reached_end = true;
            break;
        };
        scanned += 1;
        if name > after {
            names.push(name);
        }
    }
    names.sort();
    let mut entries = Vec::new();
    let limit = page_limit(request)?;
    for name in names.iter().take(limit) {
        match child_stat(fd.as_raw_fd(), name) {
            Ok(metadata) => entries.push(entry(path, name, &metadata)),
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
    ensure!(
        same_stamp(&frame, &stat(fd.as_raw_fd())?),
        "File listing changed; refresh"
    );
    let incomplete = !reached_end;
    let next_cursor = if !incomplete && names.len() > limit {
        encode_cursor(&Cursor {
            root_device: metadata.st_dev as u64,
            root_inode: metadata.st_ino,
            query: String::new(),
            after: names[limit - 1].clone(),
            frames: vec![frame],
        })?
    } else {
        None
    };
    Ok(
        json!({"type":"file_list","path":path,"entries":entries,"next_cursor":next_cursor,"incomplete":incomplete}),
    )
}
fn search(root: &OwnedFd, request: &Value, identity: (u64, u64)) -> Result<Value> {
    let query = request["query"].as_str().context("Missing query")?;
    ensure!(
        !query.is_empty() && query.len() <= 256,
        "File query must be 1 to 256 bytes"
    );
    let query = query.to_lowercase();
    let root_metadata = stat(root.as_raw_fd())?;
    let cursor = if let Some(encoded) = request["cursor"].as_str() {
        decode_cursor(encoded)?
    } else {
        Cursor {
            root_device: identity.0,
            root_inode: identity.1,
            query: query.clone(),
            after: String::new(),
            frames: vec![stamp(String::new(), &root_metadata)],
        }
    };
    ensure!(
        (cursor.root_device, cursor.root_inode) == identity
            && cursor.query == query
            && cursor.frames.len() == 1
            && cursor.frames[0].path.is_empty()
            && same_stamp(&cursor.frames[0], &root_metadata),
        "Stale file search cursor"
    );
    let mut live = vec![live_frame(root, stamp(String::new(), &root_metadata))?];
    let mut matches = std::collections::BTreeMap::new();
    let mut scanned = 0;
    let limit = page_limit(request)?;
    let mut incomplete = false;
    while !live.is_empty() && scanned < SEARCH_SCAN_LIMIT {
        let current = live.last_mut().context("Missing search frame")?;
        let Some(name) = current.directory.next()? else {
            ensure!(
                same_stamp(&current.frame, &stat(current.fd.as_raw_fd())?),
                "File search changed; refresh"
            );
            live.pop();
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
        if child_path > cursor.after && name.to_lowercase().contains(&query) {
            matches.insert(
                child_path.clone(),
                entry(&current.frame.path, &name, &metadata),
            );
        }
        if kind(&metadata) == "directory" {
            if live.len() < SEARCH_DEPTH_LIMIT {
                live.push(live_frame(root, stamp(child_path, &metadata))?);
            } else {
                incomplete = true;
            }
        }
    }
    for current in &live {
        ensure!(
            same_stamp(&current.frame, &stat(current.fd.as_raw_fd())?),
            "File search changed; refresh"
        );
    }
    incomplete |= !live.is_empty();
    let mut sorted = matches.into_iter().collect::<Vec<_>>();
    let has_more = sorted.len() > limit;
    sorted.truncate(limit);
    let next_cursor = if has_more && !incomplete {
        encode_cursor(&Cursor {
            after: sorted.last().context("Missing file result")?.0.clone(),
            ..cursor
        })?
    } else {
        None
    };
    let results = sorted
        .into_iter()
        .map(|(_, value)| value)
        .collect::<Vec<_>>();
    Ok(
        json!({"type":"file_search","results":results,"next_cursor":next_cursor,"incomplete":incomplete}),
    )
}
fn preview(root: &OwnedFd, request: &Value) -> Result<Value> {
    let path = request["path"].as_str().context("Missing path")?;
    let parts = relative(path)?;
    let (name, parents) = parts.split_last().context("Preview requires a file path")?;
    let parent_path = parents.join("/");
    let parent = open_directory(root, &parent_path)?;
    let fd = open_child(parent.as_raw_fd(), name, false)?;
    let metadata = stat(fd.as_raw_fd())?;
    ensure!(kind(&metadata) == "file", "Preview requires a regular file");
    let size = metadata.st_size.max(0) as u64;
    let extension = Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(extension.as_str(), "html" | "htm" | "svg" | "xhtml" | "xml") {
        return Ok(
            json!({"type":"file_preview","path":path,"kind":"unsupported","size":size,"truncated":size > PREVIEW_LIMIT as u64}),
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
            Ok(
                json!({"type":"file_preview","path":path,"kind":"unsupported","size":size,"truncated":truncated}),
            )
        } else {
            Ok(
                json!({"type":"file_preview","path":path,"kind":"image","mime":mime,"bytes_base64":base64::engine::general_purpose::STANDARD.encode(bytes),"size":size,"truncated":false}),
            )
        };
    }
    if truncated {
        while std::str::from_utf8(&bytes).is_err_and(|error| error.error_len().is_none()) {
            bytes.pop();
        }
    }
    match String::from_utf8(bytes) {
        Ok(text) if !text.contains('\0') => Ok(
            json!({"type":"file_preview","path":path,"kind":"text","mime":"text/plain","text":text,"size":size,"truncated":truncated}),
        ),
        _ => Ok(
            json!({"type":"file_preview","path":path,"kind":"unsupported","size":size,"truncated":truncated}),
        ),
    }
}

pub fn command(path: &str, expected: (u64, u64), request: &Value) -> Result<Value> {
    let root = root_fd(path, expected)?;
    match request["op"].as_str().unwrap_or("") {
        "file.list" => list(&root, request),
        "file.search" => search(&root, request, expected),
        "file.preview" => preview(&root, request),
        _ => bail!("Unknown file operation"),
    }
}
