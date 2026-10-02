//! Bounded, read-only source pages. No provider process, admission, or history write.
use super::*;
use ade_core::contract::providers::{
    ProviderHistoryConsistency, ProviderHistorySnapshot, ProviderWorkerHistoryRequest,
};
use ade_core::{error::Failure, json_budget};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, Metadata},
    io::{BufRead, BufReader, Seek, SeekFrom},
    os::unix::fs::MetadataExt,
};

const FRAME: usize = 1024 * 1024;
const SCAN_ENTRIES: usize = 10_000;
pub(crate) struct Page {
    pub snapshot: ProviderHistorySnapshot,
    pub result: Result<(Vec<Message>, Option<String>, bool)>,
}
fn generation(metadata: &Metadata, scope: &str) -> String {
    let stamp = file_stamp(metadata);
    let mut hash = Sha256::new();
    hash.update(stamp.as_bytes());
    hash.update(scope.as_bytes());
    format!("{:x}{stamp}", hash.finalize())
}
fn file_stamp(metadata: &Metadata) -> String {
    let mut hash = Sha256::new();
    for value in [
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        metadata.mtime() as u64,
        metadata.mtime_nsec() as u64,
        metadata.ctime() as u64,
        metadata.ctime_nsec() as u64,
    ] {
        hash.update(value.to_le_bytes());
    }
    format!("{:x}", hash.finalize())
}
pub(crate) fn source_current(snapshot: &ProviderHistorySnapshot) -> bool {
    // Virtual providers disclose best_effort and no measurable file identity.
    if snapshot.size_bytes.is_none() {
        return true;
    }
    std::fs::metadata(&snapshot.source).is_ok_and(|metadata| {
        metadata.is_file()
            && snapshot.size_bytes == Some(metadata.len())
            && snapshot.generation.get(64..) == Some(file_stamp(&metadata).as_str())
    })
}
fn find(
    root: &Path,
    depth: usize,
    provider: HistoryImportProvider,
    session: &str,
    visits: &mut usize,
    found: &mut Option<PathBuf>,
) -> Result<()> {
    if !root.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(root)? {
        *visits += 1;
        ensure!(*visits <= SCAN_ENTRIES, Failure::ResourceLimit);
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() && depth > 0 {
            find(&entry.path(), depth - 1, provider, session, visits, found)?;
        } else if kind.is_file()
            && file_session_id(provider, &entry.file_name().to_string_lossy())
                .is_some_and(|id| id.eq_ignore_ascii_case(session))
        {
            ensure!(found.is_none(), Failure::InvalidData);
            *found = Some(entry.path());
        }
    }
    Ok(())
}
fn source(store: &NativeStore, pinned: Option<&Path>, session: &str) -> Result<PathBuf> {
    let path = if let Some(path) = pinned {
        path.to_owned()
    } else {
        ensure!(valid_session_id(session), Failure::Unavailable);
        let mut found = None;
        let mut visits = 0;
        let depth = if store.provider == HistoryImportProvider::Codex {
            3
        } else {
            1
        };
        for root in store.roots() {
            find(
                &root,
                depth,
                store.provider,
                session,
                &mut visits,
                &mut found,
            )?;
        }
        found.context(Failure::Unavailable)?
    };
    let path = path.canonicalize()?;
    ensure!(
        path.starts_with(store.home.canonicalize()?),
        Failure::Rejected
    );
    Ok(path)
}
fn line(reader: &mut BufReader<File>) -> Result<(Vec<u8>, json_budget::Usage)> {
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take(FRAME as u64)
        .read_until(b'\n', &mut bytes)?;
    ensure!(
        bytes.is_empty() || bytes.ends_with(b"\n"),
        if bytes.len() == FRAME {
            Failure::ResourceLimit
        } else {
            Failure::InvalidData
        }
    );
    let usage = json_budget::usage(&bytes, FRAME).context(Failure::ResourceLimit)?;
    Ok((bytes, usage))
}
fn message(
    conversation: &str,
    session: &str,
    provider: HistoryImportProvider,
    item: parse::Item,
) -> Message {
    let key = item.key;
    Message {
        id: message_id(provider, session, &key),
        conversation_id: conversation.into(),
        provider_item_id: Some(key),
        native_message: None,
        role: item.role.into(),
        kind: item.kind.into(),
        text: item.text,
        content: item.content,
        status: "unknown".into(),
        turn_id: None,
        sequence: 0,
        attachments: vec![],
        review_feedback: None,
        delivery: None,
    }
}
fn add(
    messages: &mut Vec<Message>,
    bytes: &mut usize,
    held: &mut json_budget::Usage,
    value: Message,
    request: &ProviderWorkerHistoryRequest,
) -> Result<bool> {
    let usage = json_budget::encoded_usage(&value, request.max_bytes as usize)?
        .context(Failure::ResourceLimit)?;
    let size = usage.bytes;
    ensure!(
        size + 2 <= request.max_bytes as usize,
        Failure::ResourceLimit
    );
    if messages.len() == request.max_items as usize
        || *bytes + size + usize::from(!messages.is_empty()) > request.max_bytes as usize
        || !held.fits_with(usage, FRAME)
    {
        ensure!(!messages.is_empty(), Failure::ResourceLimit);
        return Ok(false);
    }
    held.add(usage);
    *bytes += size + usize::from(!messages.is_empty());
    messages.push(value);
    Ok(true)
}

pub(crate) fn read_page(
    store: &NativeStore,
    pinned: Option<&Path>,
    request: &ProviderWorkerHistoryRequest,
    conversation: &str,
    scope: &str,
) -> Result<Page> {
    ensure!(
        (1..=32).contains(&request.max_items) && (2..=524288).contains(&request.max_bytes),
        Failure::ResourceLimit
    );
    let path = source(store, pinned, &request.session)?;
    let file = File::open(&path)?;
    let metadata = file.metadata()?;
    ensure!(metadata.is_file(), Failure::InvalidData);
    let mut reader = BufReader::new(file);
    let mut seen_session = None;
    let mut lineage = None;
    let mut header_bytes = 0;
    // Identify before projection; no arbitrary source claims or account switching.
    for _ in 0..32 {
        let (bytes, _) = line(&mut reader)?;
        if bytes.is_empty() {
            break;
        }
        header_bytes += bytes.len();
        ensure!(header_bytes <= FRAME, Failure::ResourceLimit);
        let record: serde_json::Value = serde_json::from_slice(&bytes)?;
        let payload = if record["type"] == "session_meta" {
            &record["payload"]
        } else {
            &record
        };
        seen_session = payload["id"]
            .as_str()
            .filter(|_| {
                record["type"] == "session_meta"
                    || (store.provider == HistoryImportProvider::Codex
                        && record.get("type").is_none())
            })
            .or_else(|| record["sessionId"].as_str())
            .map(str::to_owned)
            .or(seen_session);
        lineage = payload["forked_from_id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 256)
            .map(str::to_owned)
            .or(lineage);
        if seen_session.is_some() {
            break;
        }
    }
    ensure!(
        seen_session
            .as_deref()
            .is_some_and(|id| id.eq_ignore_ascii_case(&request.session)),
        Failure::InvalidData
    );
    let generation = generation(&metadata, scope);
    let snapshot = ProviderHistorySnapshot {
        provider: request.context.provider.clone(),
        session: request.session.clone(),
        execution_id: request.context.execution_id.clone(),
        account_id: request.context.account_id.clone(),
        lineage: lineage.or_else(|| request.context.lineage.clone()),
        source: path.to_string_lossy().into_owned(),
        generation: generation.clone(),
        size_bytes: Some(metadata.len()),
        modified_at_ms: metadata
            .mtime()
            .checked_mul(1000)
            .and_then(|ms| ms.checked_add(metadata.mtime_nsec() / 1_000_000)),
        consistency: ProviderHistoryConsistency::BestEffort,
        invalidation_epoch: request.context.invalidation_epoch,
    };
    let result = (|| -> Result<(Vec<Message>, Option<String>, bool)> {
        ensure!(
            request
                .snapshot
                .as_ref()
                .is_none_or(|expected| expected == &snapshot),
            Failure::Rejected
        );
        let (offset, block) = match request.cursor.as_deref() {
            None => (0, 0),
            Some(cursor) => {
                let parts = cursor.split(':').collect::<Vec<_>>();
                ensure!(
                    parts.len() == 3 && parts[0] == generation,
                    Failure::Rejected
                );
                (parts[1].parse::<u64>()?, parts[2].parse::<usize>()?)
            }
        };
        let mut messages = Vec::new();
        let mut retained = 2;
        let mut held =
            json_budget::encoded_usage(&snapshot, FRAME)?.context(Failure::ResourceLimit)?;
        held.add(json_budget::Usage {
            bytes: 4352,
            nodes: 24,
        });
        if store.provider == HistoryImportProvider::Claude {
            ensure!(metadata.len() <= FRAME as u64, Failure::ResourceLimit);
            reader.seek(SeekFrom::Start(0))?;
            let mut bytes = Vec::new();
            reader.take(FRAME as u64 + 1).read_to_end(&mut bytes)?;
            let raw_usage = json_budget::usage(&bytes, FRAME).context(Failure::ResourceLimit)?;
            ensure!(held.fits_with(raw_usage, 2 * FRAME), Failure::ResourceLimit);
            let text = std::str::from_utf8(&bytes)?;
            let parsed = parse_text(store.provider, text);
            ensure!(
                !parsed.budget_exceeded && !parsed.incomplete_tail && parsed.skipped == 0,
                Failure::ResourceLimit
            );
            ensure!(
                block == 0 && offset as usize <= parsed.items.len(),
                Failure::Rejected
            );
            for (index, item) in parsed.items.into_iter().enumerate().skip(offset as usize) {
                if !add(
                    &mut messages,
                    &mut retained,
                    &mut held,
                    message(conversation, &request.session, store.provider, item),
                    request,
                )? {
                    return Ok((messages, Some(format!("{generation}:{index}:0")), false));
                }
            }
            return Ok((messages, None, true));
        }
        ensure!(offset <= metadata.len(), Failure::Rejected);
        let mut ordinal =
            ade_core::native_history::position::line_ordinal(&mut reader, offset, FRAME as u64)?;
        reader.seek(SeekFrom::Start(offset))?;
        let mut position = offset;
        let mut first = true;
        let mut scanned = 0usize;
        // Bound metadata-only scans too; a continuation remains a genuine native byte cursor.
        for _ in 0..4096 {
            let (bytes, raw_usage) = line(&mut reader)?;
            if bytes.is_empty() {
                return Ok((messages, None, true));
            }
            if scanned + bytes.len() > FRAME {
                return Ok((messages, Some(format!("{generation}:{position}:0")), false));
            }
            if !held.fits_with(raw_usage, 2 * FRAME) {
                ensure!(!messages.is_empty(), Failure::ResourceLimit);
                return Ok((messages, Some(format!("{generation}:{position}:0")), false));
            }
            scanned += bytes.len();
            let parsed = parse_text(store.provider, std::str::from_utf8(&bytes)?);
            ensure!(!parsed.budget_exceeded, Failure::ResourceLimit);
            ensure!(parsed.skipped == 0, Failure::InvalidData);
            let skip = if first { block } else { 0 };
            first = false;
            ensure!(skip <= parsed.items.len(), Failure::Rejected);
            for (index, item) in parsed.items.into_iter().enumerate().skip(skip) {
                let mut item = item;
                item.key = ade_core::native_history::position::record_key(
                    &item.key,
                    position,
                    ordinal,
                    FRAME as u64,
                );
                if !add(
                    &mut messages,
                    &mut retained,
                    &mut held,
                    message(conversation, &request.session, store.provider, item),
                    request,
                )? {
                    return Ok((
                        messages,
                        Some(format!("{generation}:{position}:{index}")),
                        false,
                    ));
                }
            }
            position += bytes.len() as u64;
            ordinal = ordinal.map(|ordinal| ordinal + 1);
            if messages.len() == request.max_items as usize && position < metadata.len() {
                return Ok((messages, Some(format!("{generation}:{position}:0")), false));
            }
        }
        Ok((messages, Some(format!("{generation}:{position}:0")), false))
    })();
    // Path replacement, append, truncate, and rewrite all fence an in-flight page.
    ensure!(
        generation == self::generation(&std::fs::metadata(&path)?, scope),
        Failure::Rejected
    );
    Ok(Page { snapshot, result })
}
