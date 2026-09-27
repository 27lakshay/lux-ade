//! Runtime-owned, bounded raw PTY output for managed service runs.
//! Two replaceable segments retain at most 1 MiB per service. The reader never
//! infers process liveness or complete output from a file's existence.
use anyhow::{Context, Result, ensure};
use base64::Engine as _;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

const MAGIC: &[u8; 8] = b"ADELOG1\n";
const HEADER: usize = 48;
const SEGMENT: usize = 512 * 1024;
pub const RETAINED_BYTES: usize = 2 * SEGMENT;

/// The file name stem of one terminal's segments.
pub fn key(workspace: &str, terminal: &str) -> String {
    let digest = Sha256::digest(format!("{workspace}\0{terminal}").as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn run_hash(transfer: &str) -> [u8; 32] {
    Sha256::digest(transfer.as_bytes()).into()
}
fn directory(root: &Path, create: bool) -> Result<PathBuf> {
    let root_metadata = fs::symlink_metadata(root)?;
    ensure!(
        root_metadata.is_dir()
            && !root_metadata.file_type().is_symlink()
            && root_metadata.uid() == unsafe { libc::geteuid() },
        "Service log data directory is redirected or belongs to another user"
    );
    let root = root.canonicalize()?;
    let directory = root.join("service-logs");
    if create {
        match DirBuilder::new().mode(0o700).create(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    let metadata = fs::symlink_metadata(&directory)?;
    ensure!(
        metadata.is_dir()
            && !metadata.file_type().is_symlink()
            && metadata.uid() == fs::metadata(&root)?.uid()
            && metadata.mode() & 0o077 == 0,
        "Service log directory is redirected or accessible to other users"
    );
    Ok(directory)
}
fn segment_path(directory: &Path, key: &str, index: usize) -> PathBuf {
    directory.join(format!("{key}.{index}"))
}
fn open_segment(
    directory: &Path,
    key: &str,
    index: usize,
    run: &[u8; 32],
    start: u64,
) -> Result<File> {
    let temporary = directory.join(format!("{key}.tmp"));
    match fs::remove_file(&temporary) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temporary)?;
    file.write_all(MAGIC)?;
    file.write_all(run)?;
    file.write_all(&start.to_le_bytes())?;
    file.sync_data()?;
    fs::rename(&temporary, segment_path(directory, key, index))?;
    Ok(file)
}

pub struct Writer {
    directory: PathBuf,
    key: String,
    run: [u8; 32],
    index: usize,
    file: File,
    offset: u64,
    segment_bytes: usize,
}
impl Writer {
    pub fn open(root: &Path, workspace: &str, terminal: &str, transfer: &str) -> Result<Self> {
        let directory = directory(root, true)?;
        let key = key(workspace, terminal);
        let run = run_hash(transfer);
        let file = open_segment(&directory, &key, 0, &run, 0)?;
        // A stale second segment belongs to a prior run. Its run hash would
        // fence reads already, but removing it restores the two-file quota.
        match fs::remove_file(segment_path(&directory, &key, 1)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        Ok(Self {
            directory,
            key,
            run,
            index: 0,
            file,
            offset: 0,
            segment_bytes: 0,
        })
    }
    pub fn append(&mut self, mut bytes: &[u8]) -> Result<()> {
        while !bytes.is_empty() {
            if self.segment_bytes == SEGMENT {
                self.index = 1 - self.index;
                self.file = open_segment(
                    &self.directory,
                    &self.key,
                    self.index,
                    &self.run,
                    self.offset,
                )?;
                self.segment_bytes = 0;
            }
            let count = bytes.len().min(SEGMENT - self.segment_bytes);
            self.file.write_all(&bytes[..count])?;
            self.segment_bytes += count;
            self.offset += count as u64;
            bytes = &bytes[count..];
        }
        Ok(())
    }
}

struct SegmentData {
    start: u64,
    bytes: Vec<u8>,
}
fn read_segment(path: &Path, expected: &[u8; 32], owner_uid: u32) -> Result<Option<SegmentData>> {
    let mut file = match OpenOptions::new()
        .read(true)
        // A replaced segment may be a FIFO. Never wait for its writer.
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file()
            && metadata.nlink() == 1
            && metadata.uid() == owner_uid
            && metadata.mode() & 0o077 == 0,
        "Service log file is unsafe"
    );
    ensure!(
        metadata.len() <= (HEADER + SEGMENT) as u64,
        "Service log segment exceeds its limit"
    );
    let mut bytes = Vec::new();
    // Metadata is only a snapshot. A concurrent writer (or a replaced file)
    // can grow after fstat, so cap the read itself and check the inode again.
    (&mut file)
        .take((HEADER + SEGMENT + 1) as u64)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= HEADER + SEGMENT && file.metadata()?.len() <= (HEADER + SEGMENT) as u64,
        "Service log segment exceeds its limit"
    );
    ensure!(
        bytes.len() >= HEADER && &bytes[..8] == MAGIC,
        "Service log header is invalid"
    );
    if &bytes[8..40] != expected {
        return Ok(None);
    }
    let start = u64::from_le_bytes(bytes[40..48].try_into().unwrap());
    Ok(Some(SegmentData {
        start,
        bytes: bytes.split_off(HEADER),
    }))
}

pub fn tail(root: &Path, workspace: &str, terminal: &str, transfer: &str, limit: usize) -> Value {
    let read = (|| -> Result<Value> {
        ensure!(
            (1..=32768).contains(&limit),
            "Invalid durable service log tail limit"
        );
        let directory = directory(root, false)?;
        let owner_uid = fs::metadata(&directory)?.uid();
        let key = key(workspace, terminal);
        let run = run_hash(transfer);
        let mut segments = Vec::new();
        for index in 0..2 {
            if let Some(segment) =
                read_segment(&segment_path(&directory, &key, index), &run, owner_uid)?
            {
                segments.push(segment);
            }
        }
        if segments.is_empty() {
            return Ok(json!({"available":false,"reason":"run_not_recorded"}));
        }
        segments.sort_by_key(|segment| segment.start);
        let latest = segments.pop().unwrap();
        let mut retained_start = latest.start;
        let mut bytes = latest.bytes;
        let mut gap = false;
        if let Some(previous) = segments.pop() {
            let previous_end = previous
                .start
                .checked_add(previous.bytes.len() as u64)
                .context("Service log offset overflows")?;
            if previous_end == retained_start {
                retained_start = previous.start;
                let mut joined = previous.bytes;
                joined.extend(bytes);
                bytes = joined;
            } else {
                gap = true;
            }
        }
        let through = retained_start
            .checked_add(bytes.len() as u64)
            .context("Service log offset overflows")?;
        let start = through.saturating_sub(limit as u64).max(retained_start);
        let selected = &bytes[(start - retained_start) as usize..];
        Ok(json!({"available":true,"run_transfer_id":transfer,
            "start_offset":start,"through_offset":through,"retained_start_offset":retained_start,
            "truncated":start > 0,"retention_overflow":retained_start > 0,"segment_gap":gap,
            "bytes_base64":base64::engine::general_purpose::STANDARD.encode(selected),
            "coverage":"captured_bytes_only"}))
    })();
    match read {
        Ok(value) => value,
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound) =>
        {
            json!({"available":false,"reason":"not_recorded"})
        }
        Err(error) => {
            json!({"available":false,"reason":"log_unavailable","error":error.to_string()})
        }
    }
}

pub fn remove(root: &Path, workspace: &str, terminal: &str) -> Result<()> {
    let directory = match directory(root, false) {
        Ok(directory) => directory,
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound) =>
        {
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    let key = key(workspace, terminal);
    for index in 0..2 {
        match fs::remove_file(segment_path(&directory, &key, index)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("Could not remove service log"),
        }
    }
    Ok(())
}
