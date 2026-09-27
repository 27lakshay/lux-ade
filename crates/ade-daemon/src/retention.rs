//! Retention eligibility decisions (F138, decision D15).
//!
//! Every choice about what may go lives here as a pure function over facts
//! the caller gathered. The session layer reads the stores and the file
//! system, asks these functions, and removes only what they select. A fact
//! the caller could not observe is a reason to keep, never to remove.
//!
//! Portions of the pattern follow Orca `src/shared/workspace-cleanup.ts`
//! (fingerprinted cleanup candidates re-checked before removal) and
//! OpenCode-v2 `packages/core/src/file-retention.ts` (mtime cutoff). No code
//! was copied.

use crate::receipts;
use ade_core::contract::retention::{RetentionKind, RetentionPolicy};
use serde_json::json;
use sha2::{Digest, Sha256};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// An unreferenced attachment younger than this may still be an upload a
/// client holds before it saves the draft that references it.
pub const ATTACHMENT_GRACE_MS: i64 = DAY_MS;
/// A service log idle this long, with no owner, can go.
pub const SERVICE_LOG_IDLE_MS: i64 = 7 * DAY_MS;
/// Rotated diagnostic logs older than this can go.
pub const DIAGNOSTIC_LOG_MAX_AGE_MS: i64 = 30 * DAY_MS;
/// How often the daemon prunes receipts, and how long after start it first does.
pub const PRUNE_INTERVAL_MS: i64 = 6 * 60 * 60 * 1000;
pub const PRUNE_FIRST_DELAY_MS: i64 = 60 * 1000;
/// Most candidates one preview lists.
pub const CANDIDATE_LIMIT: usize = 500;
/// Changing a rule changes every generation, so an old preview cannot apply.
const POLICY_VERSION: &str = "retention-v1";

pub fn policy() -> RetentionPolicy {
    RetentionPolicy {
        receipt_retention_ms: receipts::RETENTION_MS,
        receipt_prune_interval_ms: PRUNE_INTERVAL_MS,
        attachment_grace_ms: ATTACHMENT_GRACE_MS,
        service_log_idle_ms: SERVICE_LOG_IDLE_MS,
        diagnostic_log_max_age_ms: DIAGNOSTIC_LOG_MAX_AGE_MS,
        candidate_limit: CANDIDATE_LIMIT as u64,
    }
}

/// A retention verdict: remove for a reason, or keep for a reason.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    Remove(&'static str),
    Keep(&'static str),
}

/// An attachment's facts, as `attachment_reclaim_preview` reports them.
pub struct AttachmentFacts<'a> {
    pub state: &'a str,
    /// Every durable reference the reclaim rules found.
    pub protected_by: &'a [String],
    pub created_at: i64,
}

/// Follows the explicit attachment reclaim rules: only a live payload that
/// no message, draft, queued prompt or unresolved send references. It adds an
/// in-flight window, because a client may hold an upload before saving it.
pub fn attachment(facts: &AttachmentFacts, now: i64) -> Verdict {
    if facts.state != "live" {
        return Verdict::Keep("not live");
    }
    if !facts.protected_by.is_empty() {
        return Verdict::Keep("referenced");
    }
    if facts.created_at <= 0 {
        // Rows from before attachments recorded a creation time.
        return Verdict::Keep("upload time unknown");
    }
    if now.saturating_sub(facts.created_at) < ATTACHMENT_GRACE_MS {
        return Verdict::Keep("may be an in-flight upload");
    }
    Verdict::Remove("unreferenced past the in-flight grace period")
}

/// Skill files belong to a bundle; the install writes both in one
/// transaction, so an unreferenced hash is never in flight.
pub fn skill_blob(referenced: bool) -> Verdict {
    if referenced {
        Verdict::Keep("referenced by an installed skill")
    } else {
        Verdict::Remove("no installed skill references it")
    }
}

/// A service log's facts. `owned` is whether any workspace terminal, service
/// record or runtime terminal still maps to the log's key.
pub struct ServiceLogFacts {
    pub owned: bool,
    /// The newest modification time among the key's files.
    pub last_write_ms: Option<i64>,
}

/// The caller must only ask after it observed the runtime terminal list;
/// without that list no service log is decided.
pub fn service_log(facts: &ServiceLogFacts, now: i64) -> Verdict {
    if facts.owned {
        return Verdict::Keep("owned by a terminal or service");
    }
    let Some(last) = facts.last_write_ms else {
        return Verdict::Keep("last write unknown");
    };
    if now.saturating_sub(last) < SERVICE_LOG_IDLE_MS {
        return Verdict::Keep("written recently");
    }
    Verdict::Remove("no terminal or service owns it and it is idle")
}

/// A diagnostic log file's facts.
pub struct DiagnosticLogFacts {
    /// Whether this is the newest file of its process prefix, which the
    /// process may still be writing.
    pub newest_of_process: bool,
    pub modified_ms: Option<i64>,
}

pub fn diagnostic_log(facts: &DiagnosticLogFacts, now: i64) -> Verdict {
    if facts.newest_of_process {
        return Verdict::Keep("the process's current log");
    }
    let Some(modified) = facts.modified_ms else {
        return Verdict::Keep("modification time unknown");
    };
    if now.saturating_sub(modified) < DIAGNOSTIC_LOG_MAX_AGE_MS {
        return Verdict::Keep("within the age limit");
    }
    Verdict::Remove("rotated log past the age limit")
}

/// Splits a service log file name into its key and part. Only names the
/// runtime writes qualify: 64 lowercase hex digits, then `.0`, `.1` or `.tmp`.
pub fn service_log_file(name: &str) -> Option<(&str, &str)> {
    let (key, part) = name.split_once('.')?;
    (key.len() == 64
        && key
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && matches!(part, "0" | "1" | "tmp"))
    .then_some((key, part))
}

/// The process prefix of a diagnostic log named `<process>.<date>.jsonl`
/// (the rolling appender's form), or `None` for any other file.
pub fn diagnostic_log_process(name: &str) -> Option<&str> {
    let stem = name.strip_suffix(".jsonl")?;
    let (process, date) = stem.rsplit_once('.')?;
    let bytes = date.as_bytes();
    let dated = bytes.len() == 10
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            4 | 7 => *byte == b'-',
            _ => byte.is_ascii_digit(),
        });
    (dated
        && !process.is_empty()
        && process
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
    .then_some(process)
}

/// One selected item with the fingerprint apply re-checks before removing it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Selected {
    pub kind: RetentionKind,
    pub id: String,
    /// What must still hold at removal: an attachment generation, a skill
    /// blob row count and size, or file identities and sizes.
    pub fingerprint: String,
}

/// Names a candidate set. Sorting first makes the name independent of the
/// order the caller discovered items in.
pub fn generation(selected: &mut [Selected], truncated: bool) -> String {
    selected.sort_by(|a, b| (a.kind, &a.id).cmp(&(b.kind, &b.id)));
    let items: Vec<_> = selected
        .iter()
        .map(|item| json!([item.kind, item.id, item.fingerprint]))
        .collect();
    let canonical = receipts::canonical_json(
        &json!({"policy": POLICY_VERSION, "items": items, "truncated": truncated}),
    );
    Sha256::digest(canonical.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Whether a scheduled prune is due. The first run waits after start so the
/// daemon's own recovery settles first.
pub fn prune_due(started_at: i64, last_run: Option<i64>, now: i64) -> bool {
    match last_run {
        None => now.saturating_sub(started_at) >= PRUNE_FIRST_DELAY_MS,
        Some(last) => now.saturating_sub(last) >= PRUNE_INTERVAL_MS || now < last,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;

    fn facts<'a>(state: &'a str, protected: &'a [String], created_at: i64) -> AttachmentFacts<'a> {
        AttachmentFacts {
            state,
            protected_by: protected,
            created_at,
        }
    }

    #[test]
    fn attachments_go_only_when_live_unreferenced_and_past_grace() {
        let none: Vec<String> = vec![];
        let draft = vec!["draft".to_owned()];
        let old = NOW - ATTACHMENT_GRACE_MS;
        assert!(matches!(
            attachment(&facts("live", &none, old), NOW),
            Verdict::Remove(_)
        ));
        assert_eq!(
            attachment(&facts("live", &draft, old), NOW),
            Verdict::Keep("referenced")
        );
        assert_eq!(
            attachment(&facts("discarded", &none, old), NOW),
            Verdict::Keep("not live")
        );
        assert_eq!(
            attachment(&facts("live", &none, old + 1), NOW),
            Verdict::Keep("may be an in-flight upload")
        );
        assert_eq!(
            attachment(&facts("live", &none, 0), NOW),
            Verdict::Keep("upload time unknown")
        );
        // A clock that moved backwards keeps the upload.
        assert!(matches!(
            attachment(&facts("live", &none, NOW + 10), NOW),
            Verdict::Keep(_)
        ));
    }

    #[test]
    fn skill_blobs_go_only_when_unreferenced() {
        assert!(matches!(skill_blob(true), Verdict::Keep(_)));
        assert!(matches!(skill_blob(false), Verdict::Remove(_)));
    }

    #[test]
    fn service_logs_need_no_owner_and_a_known_idle_period() {
        let idle = NOW - SERVICE_LOG_IDLE_MS;
        let check = |owned, last_write_ms| {
            service_log(
                &ServiceLogFacts {
                    owned,
                    last_write_ms,
                },
                NOW,
            )
        };
        assert!(matches!(check(false, Some(idle)), Verdict::Remove(_)));
        assert!(matches!(check(true, Some(0)), Verdict::Keep(_)));
        assert!(matches!(check(false, Some(idle + 1)), Verdict::Keep(_)));
        assert!(matches!(check(false, None), Verdict::Keep(_)));
    }

    #[test]
    fn diagnostic_logs_keep_each_process_current_file() {
        let old = NOW - DIAGNOSTIC_LOG_MAX_AGE_MS;
        let check = |newest_of_process, modified_ms| {
            diagnostic_log(
                &DiagnosticLogFacts {
                    newest_of_process,
                    modified_ms,
                },
                NOW,
            )
        };
        assert!(matches!(check(false, Some(old)), Verdict::Remove(_)));
        assert!(matches!(check(true, Some(0)), Verdict::Keep(_)));
        assert!(matches!(check(false, Some(old + 1)), Verdict::Keep(_)));
        assert!(matches!(check(false, None), Verdict::Keep(_)));
    }

    #[test]
    fn only_runtime_and_appender_file_names_parse() {
        let key = "a".repeat(64);
        assert_eq!(
            service_log_file(&format!("{key}.0")),
            Some((key.as_str(), "0"))
        );
        assert_eq!(
            service_log_file(&format!("{key}.tmp")),
            Some((key.as_str(), "tmp"))
        );
        assert_eq!(service_log_file(&format!("{key}.2")), None);
        assert_eq!(service_log_file(&format!("{}.0", "A".repeat(64))), None);
        assert_eq!(service_log_file(&format!("{}.0", "a".repeat(63))), None);
        assert_eq!(service_log_file("notes.txt"), None);

        assert_eq!(
            diagnostic_log_process("ade-daemon.2026-09-01.jsonl"),
            Some("ade-daemon")
        );
        assert_eq!(diagnostic_log_process("ade-daemon.jsonl"), None);
        assert_eq!(diagnostic_log_process("ade-daemon.2026-9-01.jsonl"), None);
        assert_eq!(diagnostic_log_process("../x.2026-09-01.jsonl"), None);
        assert_eq!(diagnostic_log_process("daemon.log"), None);
    }

    fn item(kind: RetentionKind, id: &str, fingerprint: &str) -> Selected {
        Selected {
            kind,
            id: id.into(),
            fingerprint: fingerprint.into(),
        }
    }

    #[test]
    fn generation_names_the_set_regardless_of_discovery_order() {
        let mut a = vec![
            item(RetentionKind::ServiceLog, "k", "1"),
            item(RetentionKind::Attachment, "a", "g"),
        ];
        let mut b = vec![
            item(RetentionKind::Attachment, "a", "g"),
            item(RetentionKind::ServiceLog, "k", "1"),
        ];
        assert_eq!(generation(&mut a, false), generation(&mut b, false));
        assert_eq!(a[0].kind, RetentionKind::Attachment);
        let mut changed = vec![
            item(RetentionKind::Attachment, "a", "g2"),
            item(RetentionKind::ServiceLog, "k", "1"),
        ];
        assert_ne!(generation(&mut a, false), generation(&mut changed, false));
        assert_ne!(generation(&mut a, false), generation(&mut a.clone(), true));
        let mut fewer = vec![item(RetentionKind::Attachment, "a", "g")];
        assert_ne!(generation(&mut a, false), generation(&mut fewer, false));
        assert_ne!(generation(&mut [], false), "");
    }

    #[test]
    fn pruning_waits_after_start_then_runs_on_the_interval() {
        assert!(!prune_due(NOW, None, NOW + PRUNE_FIRST_DELAY_MS - 1));
        assert!(prune_due(NOW, None, NOW + PRUNE_FIRST_DELAY_MS));
        assert!(!prune_due(NOW, Some(NOW), NOW + PRUNE_INTERVAL_MS - 1));
        assert!(prune_due(NOW, Some(NOW), NOW + PRUNE_INTERVAL_MS));
        // A clock that moved backwards runs rather than waiting for years.
        assert!(prune_due(NOW, Some(NOW), NOW - 1));
    }
}
