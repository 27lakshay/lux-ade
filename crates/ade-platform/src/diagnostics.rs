//! Local diagnostics contain operational metadata only, never provider payloads.
use serde::Serialize;
use std::{
    io::{self, Read},
    path::Path,
};

/// Drain arbitrary stderr without retaining its contents. Fixed-size buffers also
/// handle children that print megabytes without a newline.
#[derive(Debug, Default, Clone, Copy, Serialize)]
pub struct StderrSummary {
    pub bytes: u64,
    pub newline_count: u64,
    pub read_failed: bool,
}
pub fn drain_stderr(mut input: impl Read) -> StderrSummary {
    let mut summary = StderrSummary::default();
    let mut buffer = [0u8; 4096];
    loop {
        match input.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                summary.bytes = summary.bytes.saturating_add(count as u64);
                summary.newline_count = summary
                    .newline_count
                    .saturating_add(buffer[..count].iter().filter(|&&b| b == b'\n').count() as u64);
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => {
                summary.read_failed = true;
                break;
            }
        }
    }
    summary
}

/// Keep this guard alive until application shutdown so queued records flush.
/// Only lux-ade targets are enabled; dependencies can log arbitrary request bodies.
pub fn init(
    directory: &Path,
    process: &'static str,
) -> anyhow::Result<tracing_appender::non_blocking::WorkerGuard> {
    use tracing_subscriber::{filter::Targets, layer::SubscriberExt, util::SubscriberInitExt};
    std::fs::create_dir_all(directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))?;
    }
    let appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix(process)
        .filename_suffix("jsonl")
        .max_log_files(7)
        .build(directory)?;
    // Keep a noisy process from filling the disk between daily rotations.
    let newest = std::fs::read_dir(directory)?
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with(&format!("{process}.")) && name.ends_with(".jsonl")
        })
        .max_by_key(|entry| entry.file_name());
    let existing = newest
        .and_then(|entry| entry.metadata().ok())
        .map(|meta| meta.len())
        .unwrap_or(0);
    let appender = ByteBudget {
        inner: appender,
        remaining: (8 * 1024 * 1024u64).saturating_sub(existing) as usize,
    };
    let (writer, guard) = tracing_appender::non_blocking::NonBlockingBuilder::default()
        .buffered_lines_limit(512)
        .lossy(true)
        .finish(appender);
    tracing_subscriber::registry()
        .with(Targets::new().with_target("ade", tracing::Level::INFO))
        .with(
            tracing_subscriber::fmt::layer()
                .json()
                .with_ansi(false)
                .with_writer(writer),
        )
        .try_init()?;
    tracing::info!(target: "ade", process, event = "process_started", version = env!("CARGO_PKG_VERSION"));
    Ok(guard)
}

/// Export only known operational fields. Export never copies files wholesale,
/// even if another component has written unexpected fields into the log folder.
pub fn export(directory: &Path, destination: &Path) -> anyhow::Result<()> {
    use std::io::{BufRead, BufReader, Write};
    let mut records = Vec::new();
    let mut scanned = 0usize;
    let mut entries = std::fs::read_dir(directory)?.collect::<io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if entry
            .path()
            .extension()
            .is_none_or(|extension| extension != "jsonl")
            || !entry.file_type()?.is_file()
        {
            continue;
        }
        let mut input = BufReader::new(std::fs::File::open(entry.path())?);
        loop {
            let mut line = Vec::new();
            let count = input
                .by_ref()
                .take(16 * 1024)
                .read_until(b'\n', &mut line)?;
            if count == 0 {
                break;
            }
            scanned += count;
            anyhow::ensure!(
                scanned <= 64 * 1024 * 1024,
                "Diagnostic input exceeds 64 MiB; rotate logs before exporting"
            );
            anyhow::ensure!(
                line.ends_with(b"\n"),
                "Diagnostic record exceeds 16 KiB or is incomplete"
            );
            let Ok(value) = serde_json::from_slice::<serde_json::Value>(&line) else {
                continue;
            };
            if let Some(record) = safe_record(&value) {
                records.push(record);
            }
            anyhow::ensure!(
                records.len() <= 100_000,
                "Too many diagnostic records; rotate logs before exporting"
            );
        }
    }
    let report = serde_json::json!({"schema_version":1,"ade_version":env!("CARGO_PKG_VERSION"),"os":std::env::consts::OS,"architecture":std::env::consts::ARCH,"records":records});
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options.open(destination)?;
    serde_json::to_writer(&mut output, &report)?;
    output.write_all(b"\n")?;
    output.sync_all()?;
    Ok(())
}
/// Keeps only allow-listed operational fields of one log record, or `None`
/// for an unknown event. `diagnostics.export` reuses it for recent events.
pub fn safe_record(value: &serde_json::Value) -> Option<serde_json::Value> {
    let fields = value.get("fields")?;
    let event = fields.get("event")?.as_str()?;
    if !matches!(
        event,
        "process_started"
            | "rpc_started"
            | "rpc_succeeded"
            | "rpc_failed"
            | "rpc_run"
            | "agent_run_started"
            | "provider_started"
            | "provider_connection_closed"
            | "provider_stderr_drained"
            | "persistence_failed"
    ) {
        return None;
    }
    let mut safe = serde_json::Map::new();
    safe.insert("event".into(), event.into());
    if let Some(timestamp) = value.get("timestamp").and_then(|v| v.as_str())
        && timestamp.len() <= 40
        && timestamp
            .bytes()
            .all(|b| b.is_ascii_digit() || b"-:+.TZ ".contains(&b))
    {
        safe.insert("timestamp".into(), timestamp.into());
    }
    if let Some(process) = fields.get("process").and_then(|v| v.as_str())
        && matches!(
            process,
            "client" | "daemon" | "runtime" | "ade-client" | "ade-daemon" | "ade-runtime"
        )
    {
        safe.insert("process".into(), process.into());
    }
    for key in ["pid", "bytes", "newline_count"] {
        if let Some(number) = fields.get(key).and_then(|v| v.as_u64()) {
            safe.insert(key.into(), number.into());
        }
    }
    if let Some(id) = fields.get("diagnostic_id").and_then(|v| v.as_str())
        && ade_core::diagnostics::valid_id(id)
    {
        safe.insert("diagnostic_id".into(), id.into());
    }
    if let Some(id) = fields.get("run_id").and_then(|v| v.as_str())
        && ade_core::diagnostics::valid_run_id(id)
    {
        safe.insert("run_id".into(), id.into());
    }
    if let Some(family) = fields.get("operation_family").and_then(|v| v.as_str())
        && matches!(
            family,
            "hello"
                | "agent"
                | "attachment"
                | "catalog"
                | "conversation"
                | "diagnostics"
                | "draft"
                | "queue"
                | "review"
                | "runtime"
                | "service"
                | "session"
                | "terminal"
                | "window"
                | "workspace"
                | "worktree"
                | "other"
        )
    {
        safe.insert("operation_family".into(), family.into());
    }
    if let Some(elapsed) = fields.get("elapsed_ms").and_then(|v| v.as_u64()) {
        safe.insert("elapsed_ms".into(), elapsed.into());
    }
    if let Some(failed) = fields.get("read_failed").and_then(|v| v.as_bool()) {
        safe.insert("read_failed".into(), failed.into());
    }
    if let Some(code) = fields.get("code").and_then(|v| v.as_str())
        && matches!(
            code,
            "provider_disconnected"
                | "provider_invalid_message"
                | "provider_message_too_large"
                | "provider_overloaded"
                | "provider_state_unavailable"
                | "provider_write_timeout"
                | "provider_outcome_unknown"
                | "provider_transport_failed"
                | "save_failed"
        )
    {
        safe.insert("code".into(), code.into());
    }
    Some(safe.into())
}

/// Logging is best-effort. Once the process budget is exhausted, discard records
/// rather than block application operations or report a misleading I/O failure.
struct ByteBudget<W> {
    inner: W,
    remaining: usize,
}
impl<W: io::Write> io::Write for ByteBudget<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.remaining {
            self.remaining = 0;
            return Ok(bytes.len());
        }
        let written = self.inner.write(bytes)?;
        self.remaining -= written;
        Ok(written)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn export_is_explicit_private_and_does_not_overwrite_existing_files() {
        let directory = std::env::temp_dir().join(format!(
            "ade-diagnostics-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(
            directory.join("daemon.2026-01-01.jsonl"),
            "{\"fields\":{\"event\":\"provider_started\",\"pid\":7,\"token\":\"secret\"}}\n",
        )
        .unwrap();
        let destination = directory.join("report.json");
        export(&directory, &destination).unwrap();
        let content = std::fs::read_to_string(&destination).unwrap();
        assert!(!content.contains("secret"));
        assert!(!content.contains("token"));
        let report: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(report["schema_version"], 1);
        assert_eq!(report["records"][0]["pid"], 7);
        assert!(export(&directory, &destination).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&destination)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn export_schema_drops_arbitrary_sensitive_fields() {
        let source = serde_json::json!({"fields":{"event":"provider_connection_closed","pid":42,"code":"provider_invalid_message","prompt":"secret","error":"token=credential"},"spans":[{"token":"secret"}]});
        let safe = safe_record(&source).unwrap();
        assert_eq!(
            safe,
            serde_json::json!({"event":"provider_connection_closed","pid":42,"code":"provider_invalid_message"})
        );
        assert!(safe_record(&serde_json::json!({"fields":{"event":"secret_event"}})).is_none());
        assert_eq!(
            safe_record(
                &serde_json::json!({"fields":{"event":"persistence_failed","code":"save_failed","path":"private/location","error":"private SQL"}})
            ),
            Some(serde_json::json!({"event":"persistence_failed","code":"save_failed"}))
        );
    }
    #[test]
    fn rpc_correlation_exports_only_bounded_identifiers_and_known_fields() {
        let id = ade_core::diagnostics::new_id();
        let source = serde_json::json!({"fields":{"event":"rpc_failed","diagnostic_id":id,"operation_family":"agent","elapsed_ms":31,"op":"agent.send secret prompt","message":"private","token":"credential"}});
        assert_eq!(
            safe_record(&source),
            Some(
                serde_json::json!({"event":"rpc_failed","diagnostic_id":id,"operation_family":"agent","elapsed_ms":31})
            )
        );
        let injected = serde_json::json!({"fields":{"event":"rpc_failed","diagnostic_id":"diag_bad\nsecret","operation_family":"private/path","message":"secret"}});
        assert_eq!(
            safe_record(&injected),
            Some(serde_json::json!({"event":"rpc_failed"}))
        );
    }
    #[test]
    fn correlation_records_keep_only_valid_join_keys() {
        let diagnostic_id = ade_core::diagnostics::new_id();
        let run_id = ade_core::model::new_id("run");
        let rpc = serde_json::json!({"fields":{"event":"rpc_run","diagnostic_id":diagnostic_id,"run_id":run_id,"conversation_id":"private title","prompt":"secret"}});
        assert_eq!(
            safe_record(&rpc),
            Some(
                serde_json::json!({"event":"rpc_run","diagnostic_id":diagnostic_id,"run_id":run_id})
            )
        );
        let provider = serde_json::json!({"fields":{"event":"agent_run_started","run_id":run_id,"pid":42,"root":"private path","token":"secret"}});
        assert_eq!(
            safe_record(&provider),
            Some(serde_json::json!({"event":"agent_run_started","run_id":run_id,"pid":42}))
        );
        let forged = serde_json::json!({"fields":{"event":"rpc_run","diagnostic_id":"diag_bad\nsecret","run_id":"run_private/path"}});
        assert_eq!(
            safe_record(&forged),
            Some(serde_json::json!({"event":"rpc_run"}))
        );
    }
    #[test]
    fn log_byte_budget_drops_whole_records_after_limit() {
        use std::io::Write;
        let mut writer = ByteBudget {
            inner: Vec::new(),
            remaining: 4,
        };
        writer.write_all(b"abc").unwrap();
        writer.write_all(b"def").unwrap();
        writer.write_all(b"g").unwrap();
        assert_eq!(writer.inner, b"abc");
    }
    #[test]
    fn stderr_summary_never_contains_secret_payloads_and_handles_long_lines() {
        let payload = format!("token=secret\n{}", "x".repeat(2 * 1024 * 1024));
        let summary = drain_stderr(payload.as_bytes());
        assert_eq!(summary.bytes, payload.len() as u64);
        assert_eq!(summary.newline_count, 1);
        assert!(!summary.read_failed);
        assert!(!serde_json::to_string(&summary).unwrap().contains("secret"));
    }
    #[test]
    fn stderr_read_failure_is_reported_without_error_contents() {
        struct Failed;
        impl Read for Failed {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::other("credential secret"))
            }
        }
        let summary = drain_stderr(Failed);
        assert!(summary.read_failed);
        assert_eq!(summary.bytes, 0);
    }
}
