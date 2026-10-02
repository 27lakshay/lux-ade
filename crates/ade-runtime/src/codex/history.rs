//! Native-only reads. Codex 0.159 exposes item paging; older sources use a bounded read.
//! No start/resume/turn effect, no retries, and no claim of an immutable native snapshot.
use super::{NativeClient, item};
use ade_core::{contract::providers::*, error::Failure, json_budget, provider::Item};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    os::unix::fs::MetadataExt,
    path::PathBuf,
};

struct HashWriter(Sha256);
impl Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn file_generation(metadata: &std::fs::Metadata) -> String {
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
fn snapshot(
    client: &NativeClient,
    request: &ProviderWorkerHistoryRequest,
    thread: &Value,
) -> Result<(ProviderHistorySnapshot, Option<PathBuf>)> {
    ensure!(
        thread["id"].as_str() == Some(&request.session),
        Failure::InvalidData
    );
    let mut hash = HashWriter(Sha256::new());
    serde_json::to_writer(&mut hash, thread)?;
    serde_json::to_writer(&mut hash, &request.context)?;
    serde_json::to_writer(&mut hash, &client.identity)?;
    let mut source = format!("codex-thread:{}", request.session);
    let mut size_bytes = None;
    let mut modified_at_ms = thread["updatedAt"]
        .as_i64()
        .and_then(|seconds| seconds.checked_mul(1000));
    let path = match &thread["path"] {
        Value::Null => None,
        Value::String(path) => {
            ensure!(
                path.len() <= 8192 && std::path::Path::new(path).is_absolute(),
                Failure::InvalidData
            );
            Some(std::fs::canonicalize(path)?)
        }
        _ => anyhow::bail!(Failure::InvalidData),
    };
    let mut file_stamp = None;
    if let Some(path) = &path {
        let metadata = std::fs::metadata(path)?;
        ensure!(metadata.is_file(), Failure::InvalidData);
        source = path.to_string_lossy().into_owned();
        size_bytes = Some(metadata.len());
        modified_at_ms = metadata
            .mtime()
            .checked_mul(1000)
            .and_then(|ms| ms.checked_add(metadata.mtime_nsec() / 1_000_000));
        file_stamp = Some(file_generation(&metadata));
        hash.0.update(file_stamp.as_ref().unwrap().as_bytes());
    }
    let mut generation = format!("{:x}", hash.0.finalize());
    // Opaque generation includes a separately verifiable file stamp for cache/late fences.
    if let Some(stamp) = file_stamp {
        generation.push_str(&stamp);
    }
    let lineage = thread["forkedFromId"]
        .as_str()
        .or_else(|| thread["parentThreadId"].as_str())
        .map(str::to_owned)
        .or_else(|| request.context.lineage.clone());
    Ok((
        ProviderHistorySnapshot {
            provider: request.context.provider.clone(),
            session: request.session.clone(),
            execution_id: request.context.execution_id.clone(),
            account_id: request.context.account_id.clone(),
            lineage,
            source,
            generation,
            size_bytes,
            modified_at_ms,
            consistency: ProviderHistoryConsistency::BestEffort,
            invalidation_epoch: request.context.invalidation_epoch,
        },
        path,
    ))
}
fn changed(snapshot: ProviderHistorySnapshot, message: &str) -> ProviderWorkerHistoryPage {
    ProviderWorkerHistoryPage {
        snapshot,
        items: vec![],
        next_cursor: None,
        item_cursors: vec![],
        complete: false,
        retained_bytes: 2,
        error: Some(ProviderWorkerFailure {
            code: ProviderWorkerFailureCode::InvalidRequest,
            message: message.into(),
        }),
    }
}
fn finish(
    snapshot: ProviderHistorySnapshot,
    items: Vec<Item>,
    item_cursors: Vec<String>,
    next_cursor: Option<String>,
    path: Option<PathBuf>,
) -> Result<ProviderWorkerHistoryPage> {
    if let Some(path) = path {
        ensure!(
            snapshot.generation.get(64..)
                == Some(file_generation(&std::fs::metadata(path)?).as_str()),
            Failure::Rejected
        );
    }
    let retained_bytes = json_budget::encoded_size(&items)? as u64;
    Ok(ProviderWorkerHistoryPage {
        snapshot,
        items,
        item_cursors,
        complete: next_cursor.is_none(),
        next_cursor,
        retained_bytes,
        error: None,
    })
}
fn paged(
    client: &NativeClient,
    request: &ProviderWorkerHistoryRequest,
    snapshot: ProviderHistorySnapshot,
    path: Option<PathBuf>,
) -> Result<ProviderWorkerHistoryPage> {
    let generation = snapshot.generation.clone();
    let mut position = match request.cursor.as_deref() {
        None => None,
        Some(cursor) => {
            let Some((seen, native)) = cursor.split_once(":p:") else {
                return Ok(changed(
                    snapshot,
                    "Invalid native item cursor; reload the identified first page",
                ));
            };
            if seen != generation {
                return Ok(changed(
                    snapshot,
                    "Native source generation changed; reload the identified first page",
                ));
            }
            if native.is_empty() {
                return finish(snapshot, vec![], vec![], None, path);
            }
            Some(native.to_owned())
        }
    };
    let mut items = Vec::new();
    let mut item_cursors = Vec::new();
    let mut bytes = 2usize;
    // One genuine native position per retained item; bounded metadata/reasoning scans too.
    for _ in 0..128 {
        let result = client.rpc.request(
            "thread/items/list",
            json!({"threadId":request.session,"cursor":position,"limit":1,"sortDirection":"asc"}),
        )?;
        let data = result["data"].as_array().context(Failure::InvalidData)?;
        ensure!(data.len() <= 1, Failure::InvalidData);
        let next = match &result["nextCursor"] {
            Value::Null => None,
            Value::String(cursor) => {
                ensure!(
                    !cursor.is_empty() && cursor.len() <= 3072,
                    Failure::ResourceLimit
                );
                Some(cursor.clone())
            }
            _ => anyhow::bail!(Failure::InvalidData),
        };
        ensure!(next.is_none() || next != position, Failure::InvalidData);
        if let Some(entry) = data.first() {
            let native = &entry["item"];
            let turn = entry["turnId"].as_str().context(Failure::InvalidData)?;
            if let Some(mut item) = item(native, Some(turn), entry["completedAtMs"].is_i64()) {
                super::attach_native_message(&mut item, &request.session);
                if entry["completedAtMs"].is_null()
                    && !matches!(
                        native["status"].as_str(),
                        Some("completed" | "inProgress" | "failed" | "interrupted" | "declined")
                    )
                {
                    item.status = "unknown".into();
                }
                let size = json_budget::encoded_size(&item)?;
                ensure!(
                    size + 2 <= request.max_bytes as usize,
                    Failure::ResourceLimit
                );
                if items.len() == request.max_items as usize
                    || bytes + size + usize::from(!items.is_empty()) > request.max_bytes as usize
                {
                    return finish(
                        snapshot,
                        items,
                        item_cursors,
                        Some(format!(
                            "{generation}:p:{}",
                            position.as_deref().unwrap_or("")
                        )),
                        path,
                    );
                }
                bytes += size + usize::from(!items.is_empty());
                items.push(item);
                item_cursors.push(format!("{generation}:p:{}", next.as_deref().unwrap_or("")));
            }
        }
        position = next;
        if position.is_none() {
            return finish(snapshot, items, item_cursors, None, path);
        }
        if items.len() == request.max_items as usize {
            break;
        }
    }
    finish(
        snapshot,
        items,
        item_cursors,
        position.map(|position| format!("{generation}:p:{position}")),
        path,
    )
}
fn legacy(
    client: &NativeClient,
    request: &ProviderWorkerHistoryRequest,
) -> Result<ProviderWorkerHistoryPage> {
    let result = client.rpc.request(
        "thread/read",
        json!({"threadId":request.session,"includeTurns":true}),
    )?;
    let thread = &result["thread"];
    let (snapshot, path) = snapshot(client, request, thread)?;
    if request
        .snapshot
        .as_ref()
        .is_some_and(|expected| expected != &snapshot)
    {
        return Ok(changed(
            snapshot,
            "Native source changed; reload the identified first page",
        ));
    }
    let generation = snapshot.generation.clone();
    let offset = match request.cursor.as_deref() {
        None => 0,
        Some(cursor) => {
            let Some((seen, offset)) = cursor.split_once(":l:") else {
                return Ok(changed(snapshot, "Invalid native legacy cursor"));
            };
            if seen != generation {
                return Ok(changed(
                    snapshot,
                    "Native source generation changed; reload the identified first page",
                ));
            }
            offset.parse::<usize>().context(Failure::Rejected)?
        }
    };
    let mut items = Vec::new();
    let mut item_cursors = Vec::new();
    let mut position = 0usize;
    let mut bytes = 2usize;
    let mut more = false;
    'turns: for turn in thread["turns"].as_array().context(Failure::InvalidData)? {
        for native in turn["items"].as_array().context(Failure::InvalidData)? {
            let Some(mut item) = item(native, turn["id"].as_str(), turn["status"] == "completed")
            else {
                continue;
            };
            super::attach_native_message(&mut item, &request.session);
            if !matches!(
                turn["status"].as_str(),
                Some("completed" | "inProgress" | "failed" | "interrupted")
            ) {
                item.status = "unknown".into();
            }
            if position < offset {
                position += 1;
                continue;
            }
            let size = json_budget::encoded_size(&item)?;
            ensure!(
                size + 2 <= request.max_bytes as usize,
                Failure::ResourceLimit
            );
            if items.len() == request.max_items as usize
                || bytes + size + usize::from(!items.is_empty()) > request.max_bytes as usize
            {
                more = true;
                break 'turns;
            }
            bytes += size + usize::from(!items.is_empty());
            items.push(item);
            position += 1;
            item_cursors.push(format!("{generation}:l:{position}"));
        }
    }
    ensure!(offset <= position, Failure::Rejected);
    finish(
        snapshot,
        items,
        item_cursors,
        more.then(|| format!("{generation}:l:{position}")),
        path,
    )
}
fn file_line(reader: &mut BufReader<File>) -> Result<(Vec<u8>, json_budget::Usage)> {
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take(1024 * 1024)
        .read_until(b'\n', &mut bytes)?;
    ensure!(
        bytes.is_empty() || bytes.ends_with(b"\n"),
        if bytes.len() == 1024 * 1024 {
            Failure::ResourceLimit
        } else {
            Failure::InvalidData
        }
    );
    let usage = json_budget::usage(&bytes, 1024 * 1024).context(Failure::ResourceLimit)?;
    Ok((bytes, usage))
}
fn file_page(
    request: &ProviderWorkerHistoryRequest,
    snapshot: ProviderHistorySnapshot,
    path: PathBuf,
) -> Result<ProviderWorkerHistoryPage> {
    let generation = snapshot.generation.clone();
    let mut reader = BufReader::new(File::open(&path)?);
    let metadata = reader.get_ref().metadata()?;
    ensure!(
        generation.get(64..) == Some(file_generation(&metadata).as_str()),
        Failure::Rejected
    );
    let mut identified = false;
    let mut header_bytes = 0usize;
    for _ in 0..32 {
        let (line, _) = file_line(&mut reader)?;
        if line.is_empty() {
            break;
        }
        header_bytes += line.len();
        ensure!(header_bytes <= 1024 * 1024, Failure::ResourceLimit);
        let parsed = ade_core::native_history::codex::parse(std::str::from_utf8(&line)?);
        ensure!(
            parsed.skipped == 0 && !parsed.budget_exceeded,
            Failure::InvalidData
        );
        if let Some(session) = parsed.session_id {
            ensure!(session == request.session, Failure::Rejected);
            identified = true;
            break;
        }
    }
    ensure!(identified, Failure::InvalidData);
    let (mut position, block) = match request.cursor.as_deref() {
        None => (0, 0),
        Some(cursor) => {
            let Some((seen, native)) = cursor.split_once(":f:") else {
                return Ok(changed(snapshot, "Invalid native file cursor"));
            };
            if seen != generation {
                return Ok(changed(
                    snapshot,
                    "Native source changed; reload the identified first page",
                ));
            }
            let (offset, block) = native.split_once(':').context(Failure::Rejected)?;
            (offset.parse::<u64>()?, block.parse::<usize>()?)
        }
    };
    ensure!(position <= metadata.len(), Failure::Rejected);
    let mut ordinal =
        ade_core::native_history::position::line_ordinal(&mut reader, position, 1024 * 1024)?;
    reader.seek(SeekFrom::Start(position))?;
    let mut items = Vec::new();
    let mut item_cursors = Vec::new();
    let mut retained = 2usize;
    let mut scanned = 0usize;
    let mut first = true;
    let mut held =
        json_budget::encoded_usage(&snapshot, 1024 * 1024)?.context(Failure::ResourceLimit)?;
    held.add(json_budget::Usage {
        bytes: 256,
        nodes: 24,
    });
    for _ in 0..4096 {
        let (line, raw_usage) = file_line(&mut reader)?;
        if line.is_empty() {
            return finish(snapshot, items, item_cursors, None, Some(path));
        }
        if scanned + line.len() > 1024 * 1024 {
            return finish(
                snapshot,
                items,
                item_cursors,
                Some(format!("{generation}:f:{position}:0")),
                Some(path),
            );
        }
        if !held.fits_with(raw_usage, 2 * 1024 * 1024) {
            ensure!(!items.is_empty(), Failure::ResourceLimit);
            return finish(
                snapshot,
                items,
                item_cursors,
                Some(format!("{generation}:f:{position}:0")),
                Some(path),
            );
        }
        scanned += line.len();
        let parsed = ade_core::native_history::codex::parse(std::str::from_utf8(&line)?);
        ensure!(
            parsed.skipped == 0 && !parsed.incomplete_tail,
            Failure::InvalidData
        );
        ensure!(!parsed.budget_exceeded, Failure::ResourceLimit);
        let skip = if first { block } else { 0 };
        first = false;
        let count = parsed.items.len();
        ensure!(skip <= count, Failure::Rejected);
        for (index, native) in parsed.items.into_iter().enumerate().skip(skip) {
            let key = ade_core::native_history::position::record_key(
                &native.key,
                position,
                ordinal,
                1024 * 1024,
            );
            let item = Item {
                id: format!("source-file:{key}"),
                native_message: None,
                client_id: None,
                turn: None,
                role: native.role.into(),
                kind: native.kind.into(),
                text: native.text,
                content: native.content,
                status: "unknown".into(),
            };
            let item_usage = json_budget::encoded_usage(&item, request.max_bytes as usize)?
                .context(Failure::ResourceLimit)?;
            let size = item_usage.bytes;
            ensure!(
                size + 2 <= request.max_bytes as usize,
                Failure::ResourceLimit
            );
            let cursor_reservation = json_budget::Usage {
                bytes: 256,
                nodes: 1,
            };
            let mut projected = item_usage;
            projected.add(cursor_reservation);
            if items.len() == request.max_items as usize
                || retained + size + usize::from(!items.is_empty()) > request.max_bytes as usize
                || !held.fits_with(projected, 1024 * 1024)
            {
                ensure!(!items.is_empty(), Failure::ResourceLimit);
                return finish(
                    snapshot,
                    items,
                    item_cursors,
                    Some(format!("{generation}:f:{position}:{index}")),
                    Some(path),
                );
            }
            retained += size + usize::from(!items.is_empty());
            held.add(projected);
            items.push(item);
            let next = if index + 1 == count {
                format!("{generation}:f:{}:0", position + line.len() as u64)
            } else {
                format!("{generation}:f:{position}:{}", index + 1)
            };
            item_cursors.push(next);
        }
        position += line.len() as u64;
        ordinal = ordinal.map(|ordinal| ordinal + 1);
        if position == metadata.len() {
            return finish(snapshot, items, item_cursors, None, Some(path));
        }
        if items.len() == request.max_items as usize {
            break;
        }
    }
    finish(
        snapshot,
        items,
        item_cursors,
        Some(format!("{generation}:f:{position}:0")),
        Some(path),
    )
}
pub(super) fn read(client: &NativeClient, request: ProviderWorkerHistoryRequest) -> Result<Value> {
    ensure!(
        (1..=32).contains(&request.max_items) && (2..=524288).contains(&request.max_bytes),
        Failure::ResourceLimit
    );
    ensure!(
        !request.context.execution_id.is_empty()
            && request.context.execution_id.len() <= 256
            && request
                .cursor
                .as_ref()
                .is_none_or(|cursor| cursor.len() <= 4096),
        Failure::Rejected
    );
    ensure!(
        request.context.provider
            == std::env::var("ADE_PROVIDER_ID").unwrap_or_else(|_| "codex".into()),
        Failure::Rejected
    );
    client.initialize_native()?;
    client.verify_identity()?;
    let metadata = client.rpc.request(
        "thread/read",
        json!({"threadId":request.session,"includeTurns":false}),
    )?;
    let thread = &metadata["thread"];
    // Shipped 0.159 declares items/list but its legacy backend rejects it.
    // Source mode, not generated types or an effect retry, selects the read.
    let (identified, path) = snapshot(client, &request, thread)?;
    let modern = thread["historyMode"]
        .as_str()
        .is_some_and(|mode| mode != "legacy");
    drop(metadata);
    let page = if request
        .snapshot
        .as_ref()
        .is_some_and(|expected| expected != &identified)
        && path.is_some()
    {
        changed(
            identified,
            "Native source changed; reload the identified first page",
        )
    } else if modern {
        if request
            .snapshot
            .as_ref()
            .is_some_and(|expected| expected != &identified)
        {
            changed(
                identified,
                "Native source changed; reload the identified first page",
            )
        } else {
            paged(client, &request, identified, path)?
        }
    } else if let Some(path) = path {
        file_page(&request, identified, path)?
    } else {
        legacy(client, &request)?
    };
    ensure!(
        page.retained_bytes <= request.max_bytes as u64
            && json_budget::encoded_usage(&page, 1024 * 1024)?.is_some(),
        Failure::ResourceLimit
    );
    Ok(serde_json::to_value(page)?)
}
