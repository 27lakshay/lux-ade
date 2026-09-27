//! Draft recall and stash (F036, conversations spec).
//!
//! Draft history keeps what a window sent or discarded, so the user can
//! recall it. A named stash keeps a draft with its attachments and context
//! nodes per Conversation, so any of its windows can restore it; that is also
//! the explicit way to move a draft between windows.
//!
//! Restoring replaces the window's draft only when the stored revision is
//! still the one the caller saw. A retry that finds its own content at the
//! requested revision converges; anything else is a conflict and writes
//! nothing. A restore that replaces a non-empty draft keeps that draft in
//! history first, in the same transaction.
//!
//! Both tables live in the profile state database and are created
//! idempotently before use. The decisions are pure functions tested below.
//!
//! Pattern references, no code copied: t3code `apps/web/src/promptStashStore.ts`
//! (a stash entry keeps its context records beside its attachments; bounded
//! entry count) and opencode-v2 `packages/tui/test/prompt/draft-stash.test.ts`
//! (a draft is stashed per slot and taken back explicitly).
use super::*;
use ade_core::contract::conversations::{
    DraftContextNode, DraftHistoryEntry, DraftHistoryKind, DraftRestoreOutcome, DraftStash,
    DraftStashSaveOutcome,
};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS draft_history(id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, window_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('sent','discarded')), text TEXT NOT NULL, attachments TEXT NOT NULL, context_nodes TEXT NOT NULL, draft_revision INTEGER NOT NULL, source TEXT NOT NULL, recorded_at INTEGER NOT NULL, UNIQUE(conversation_id, window_id, source));
CREATE INDEX IF NOT EXISTS draft_history_by_window ON draft_history(conversation_id, window_id, id);
CREATE TABLE IF NOT EXISTS draft_context(conversation_id TEXT NOT NULL, window_id TEXT NOT NULL, revision INTEGER NOT NULL, context_nodes TEXT NOT NULL, PRIMARY KEY(conversation_id, window_id));
CREATE TABLE IF NOT EXISTS draft_stashes(conversation_id TEXT NOT NULL, name TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), text TEXT NOT NULL, attachments TEXT NOT NULL, context_nodes TEXT NOT NULL, window_id TEXT NOT NULL, saved_at INTEGER NOT NULL, PRIMARY KEY(conversation_id, name));
";

/// Recalled drafts kept per window; the oldest go first.
pub const HISTORY_PER_WINDOW: i64 = 100;
/// Stashes one Conversation may keep.
pub const STASHES_PER_CONVERSATION: i64 = 50;
const HISTORY_PAGE_DEFAULT: u32 = 20;
const HISTORY_PAGE_MAX: u32 = 100;
const NAME_LIMIT: usize = 128;
const CONTEXT_NODE_LIMIT: usize = 64;
const CONTEXT_FIELD_LIMIT: usize = 256;
const CONTEXT_BYTES_LIMIT: usize = 256 * 1024;

fn ensure_tables(db: &Connection) -> Result<()> {
    db.execute_batch(SCHEMA)?;
    Ok(())
}

/// The part of a draft that recall and stash carry.
#[derive(Clone, Debug, PartialEq)]
pub struct DraftContent {
    pub text: String,
    pub attachments: Vec<Attachment>,
    pub context_nodes: Vec<DraftContextNode>,
}

fn is_blank(text: &str, attachments: &[Attachment]) -> bool {
    text.trim().is_empty() && attachments.is_empty()
}

/// Whether a save that replaced `previous` with `next` threw text away: a
/// non-empty draft became an empty one. A send clears its draft through its
/// own path and is recorded as sent there.
pub(crate) fn discarded_by(previous: &Draft, next: &Draft) -> bool {
    draft_kept(previous) && !draft_kept(next)
}

/// Whether a window draft holds anything worth recalling.
fn draft_kept(draft: &Draft) -> bool {
    !is_blank(&draft.text, &draft.attachments) || !draft.context_nodes.is_empty()
}

/// Whether a restore of `content` over `stored` loses anything worth keeping.
pub(crate) fn displaces(stored: &Draft, content: &DraftContent) -> bool {
    draft_kept(stored)
        && (stored.text != content.text
            || stored.attachments != content.attachments
            || stored.context_nodes != content.context_nodes)
}

/// What a restore does with the window's stored draft.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Restore {
    Write,
    AlreadyRestored,
    Conflict,
}

/// A restore writes only over the revision the caller saw. The same content
/// already at the requested revision is a retry of a restore that landed.
pub(crate) fn decide_restore(
    stored: &Draft,
    expected: i64,
    revision: i64,
    content: &DraftContent,
) -> Result<Restore> {
    ensure!(expected >= 0, "Invalid expected draft revision");
    ensure!(
        revision > expected,
        "Restore revision must be greater than the expected revision"
    );
    if stored.revision == expected {
        return Ok(Restore::Write);
    }
    if stored.revision == revision
        && stored.text == content.text
        && stored.attachments == content.attachments
    {
        return Ok(Restore::AlreadyRestored);
    }
    Ok(Restore::Conflict)
}

/// What a stash save does with the stash stored under its name.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum StashSave {
    Create,
    Replace { revision: i64 },
    Unchanged,
    Conflict,
}

/// The same content converges whatever the caller expected, so a retry after
/// a lost reply is safe. Different content replaces a stash only at the
/// revision the caller saw; expecting a stash that is gone is a conflict.
pub(crate) fn decide_stash_save(
    existing: Option<(&DraftContent, i64)>,
    content: &DraftContent,
    expected: Option<i64>,
) -> Result<StashSave> {
    Ok(match existing {
        None if expected.is_none_or(|revision| revision == 0) => StashSave::Create,
        None => StashSave::Conflict,
        Some((stored, _)) if stored == content => StashSave::Unchanged,
        Some((_, revision)) if expected == Some(revision) => StashSave::Replace {
            revision: revision
                .checked_add(1)
                .context("Stash revision exhausted")?,
        },
        Some(_) => StashSave::Conflict,
    })
}

/// A drop of a missing stash converges; a replaced stash is kept.
pub(crate) fn decide_stash_drop(stored: Option<i64>, expected: i64) -> Result<bool> {
    match stored {
        None => Ok(false),
        Some(revision) if revision == expected => Ok(true),
        Some(_) => anyhow::bail!("Stash changed since it was listed; list it again"),
    }
}

pub(crate) fn check_stash_name(name: &str) -> Result<()> {
    ensure!(
        !name.trim().is_empty()
            && name.chars().count() <= NAME_LIMIT
            && !name.chars().any(char::is_control),
        "Stash name must be 1 to 128 characters without control characters"
    );
    Ok(())
}

pub(crate) fn check_context_nodes(nodes: &[DraftContextNode]) -> Result<()> {
    ensure!(
        nodes.len() <= CONTEXT_NODE_LIMIT,
        "Limit of 64 context nodes per draft"
    );
    let mut ids = std::collections::HashSet::new();
    for node in nodes {
        ensure!(
            !node.id.is_empty()
                && node.id.len() <= CONTEXT_FIELD_LIMIT
                && !node.kind.is_empty()
                && node.kind.len() <= CONTEXT_FIELD_LIMIT,
            "Context node ID and kind must be 1 to 256 bytes"
        );
        ensure!(ids.insert(&node.id), "Duplicate context node");
    }
    ensure!(
        serde_json::to_vec(nodes)?.len() <= CONTEXT_BYTES_LIMIT,
        "Context nodes exceed 256 KiB"
    );
    Ok(())
}

fn context_row(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<Vec<DraftContextNode>> {
    let value: String = row.get(column)?;
    serde_json::from_str(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

/// The context nodes a window draft keeps. They live beside the `drafts`
/// row and belong to the revision that saved them, so any later write of the
/// draft that does not carry them (a send clearing it, an older schema's
/// save) leaves them behind without a separate delete.
pub(crate) fn context_for(
    stored: Option<(i64, Vec<DraftContextNode>)>,
    revision: i64,
) -> Vec<DraftContextNode> {
    match stored {
        Some((saved, nodes)) if saved == revision => nodes,
        _ => Vec::new(),
    }
}

/// Reads the context nodes of a window draft at `revision`. Reads nothing
/// when no draft ever kept context.
pub(super) fn draft_context(
    db: &Connection,
    conversation: &str,
    window: &str,
    revision: i64,
) -> Result<Vec<DraftContextNode>> {
    let exists: i64 = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='draft_context')",
        [],
        |row| row.get(0),
    )?;
    if exists == 0 {
        return Ok(Vec::new());
    }
    let stored = db
        .query_row(
            "SELECT revision,context_nodes FROM draft_context WHERE conversation_id=?1 AND window_id=?2",
            params![conversation, window],
            |row| Ok((row.get(0)?, context_row(row, 1)?)),
        )
        .optional()?;
    Ok(context_for(stored, revision))
}

/// Keeps `nodes` as the context of the window draft at `revision`, inside
/// the caller's transaction.
pub(super) fn write_draft_context(
    db: &Connection,
    conversation: &str,
    window: &str,
    revision: i64,
    nodes: &[DraftContextNode],
) -> Result<()> {
    check_context_nodes(nodes)?;
    ensure_tables(db)?;
    if nodes.is_empty() {
        db.execute(
            "DELETE FROM draft_context WHERE conversation_id=?1 AND window_id=?2",
            params![conversation, window],
        )?;
    } else {
        db.execute(
            "INSERT INTO draft_context(conversation_id,window_id,revision,context_nodes) VALUES(?1,?2,?3,?4) ON CONFLICT(conversation_id,window_id) DO UPDATE SET revision=excluded.revision,context_nodes=excluded.context_nodes",
            params![conversation, window, revision, encode(&nodes)?],
        )?;
    }
    Ok(())
}

fn kind_name(kind: DraftHistoryKind) -> &'static str {
    match kind {
        DraftHistoryKind::Sent => "sent",
        DraftHistoryKind::Discarded => "discarded",
    }
}

const HISTORY_COLUMNS: &str =
    "id,conversation_id,window_id,kind,text,attachments,context_nodes,draft_revision,recorded_at";

fn history_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DraftHistoryEntry> {
    let kind: String = row.get(3)?;
    Ok(DraftHistoryEntry {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        window_id: row.get(2)?,
        kind: if kind == "sent" {
            DraftHistoryKind::Sent
        } else {
            DraftHistoryKind::Discarded
        },
        text: row.get(4)?,
        attachments: attachment_row(row, 5)?,
        context_nodes: context_row(row, 6)?,
        draft_revision: row.get(7)?,
        recorded_at: row.get(8)?,
    })
}

const STASH_COLUMNS: &str =
    "conversation_id,name,revision,text,attachments,context_nodes,window_id,saved_at";

fn stash_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DraftStash> {
    Ok(DraftStash {
        conversation_id: row.get(0)?,
        name: row.get(1)?,
        revision: row.get(2)?,
        text: row.get(3)?,
        attachments: attachment_row(row, 4)?,
        context_nodes: context_row(row, 5)?,
        window_id: row.get(6)?,
        saved_at: row.get(7)?,
    })
}

fn stash_of(db: &Connection, conversation: &str, name: &str) -> Result<Option<DraftStash>> {
    Ok(db
        .query_row(
            &format!(
                "SELECT {STASH_COLUMNS} FROM draft_stashes WHERE conversation_id=?1 AND name=?2"
            ),
            params![conversation, name],
            stash_row,
        )
        .optional()?)
}

fn stash_content(stash: &DraftStash) -> DraftContent {
    DraftContent {
        text: stash.text.clone(),
        attachments: stash.attachments.clone(),
        context_nodes: stash.context_nodes.clone(),
    }
}

/// Keeps one draft in a window's history and returns its entry ID. `source`
/// names the event, so recording it twice keeps one entry.
pub(super) fn record_history(
    db: &Connection,
    conversation: &str,
    window: &str,
    kind: DraftHistoryKind,
    draft: &Draft,
    source: &str,
) -> Result<i64> {
    ensure_tables(db)?;
    db.execute(
        "INSERT OR IGNORE INTO draft_history(conversation_id,window_id,kind,text,attachments,context_nodes,draft_revision,source,recorded_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![conversation, window, kind_name(kind), draft.text, encode(&draft.attachments)?, encode(&draft.context_nodes)?, draft.revision, source, now_ms()],
    )?;
    let id: i64 = db.query_row(
        "SELECT id FROM draft_history WHERE conversation_id=?1 AND window_id=?2 AND source=?3",
        params![conversation, window, source],
        |row| row.get(0),
    )?;
    db.execute(
        "DELETE FROM draft_history WHERE conversation_id=?1 AND window_id=?2 AND id NOT IN (SELECT id FROM draft_history WHERE conversation_id=?1 AND window_id=?2 ORDER BY id DESC LIMIT ?3)",
        params![conversation, window, HISTORY_PER_WINDOW],
    )?;
    Ok(id)
}

/// Whether a stash of `conversation` keeps attachment `id`, which protects
/// it from reclaim. Reads nothing when no stash was ever saved.
pub(super) fn stash_keeps_attachment(
    db: &Connection,
    conversation: &str,
    id: &str,
) -> Result<bool> {
    let exists: i64 = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='draft_stashes')",
        [],
        |row| row.get(0),
    )?;
    if exists == 0 {
        return Ok(false);
    }
    let found: i64 = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM draft_stashes s, json_each(s.attachments) a WHERE s.conversation_id=?1 AND json_extract(a.value,'$.id')=?2)",
        params![conversation, id],
        |row| row.get(0),
    )?;
    Ok(found != 0)
}

/// A restore's result: the window draft after it, and how it settled.
pub struct Restored {
    pub outcome: DraftRestoreOutcome,
    pub draft: Draft,
    pub context_nodes: Vec<DraftContextNode>,
    pub displaced_entry_id: Option<i64>,
}

impl Store {
    /// Recalled drafts of a Conversation, newest first, optionally of one window.
    pub fn draft_history(
        &self,
        conversation: &str,
        window: Option<&str>,
        before: Option<i64>,
        limit: Option<u32>,
    ) -> Result<(Vec<DraftHistoryEntry>, Option<i64>)> {
        self.conversation(conversation)?;
        if let Some(window) = window {
            check_id(window)?;
        }
        let limit = limit.unwrap_or(HISTORY_PAGE_DEFAULT);
        ensure!(
            (1..=HISTORY_PAGE_MAX).contains(&limit),
            "Limit must be between 1 and {HISTORY_PAGE_MAX}"
        );
        ensure_tables(&self.connection)?;
        let mut statement = self.connection.prepare(&format!(
            "SELECT {HISTORY_COLUMNS} FROM draft_history WHERE conversation_id=?1 AND (?2 IS NULL OR window_id=?2) AND id<?3 ORDER BY id DESC LIMIT ?4"
        ))?;
        let mut entries: Vec<DraftHistoryEntry> = statement
            .query_map(
                params![conversation, window, before.unwrap_or(i64::MAX), limit + 1],
                history_row,
            )?
            .collect::<rusqlite::Result<_>>()?;
        let next = if entries.len() > limit as usize {
            entries.truncate(limit as usize);
            entries.last().map(|entry| entry.id)
        } else {
            None
        };
        Ok((entries, next))
    }

    /// Restores a recalled draft of any window of the Conversation into `window`.
    pub fn restore_draft_history(
        &self,
        conversation: &str,
        window: &str,
        entry_id: i64,
        expected: i64,
        revision: i64,
    ) -> Result<Restored> {
        self.conversation(conversation)?;
        check_id(window)?;
        ensure_tables(&self.connection)?;
        let tx = self.transaction()?;
        let entry = tx
            .query_row(
                &format!("SELECT {HISTORY_COLUMNS} FROM draft_history WHERE id=?1"),
                [entry_id],
                history_row,
            )
            .optional()?
            .filter(|entry| entry.conversation_id == conversation)
            .context("Draft history entry is unavailable")?;
        let content = DraftContent {
            text: entry.text,
            attachments: entry.attachments,
            context_nodes: entry.context_nodes,
        };
        let restored = restore(&tx, conversation, window, expected, revision, content)?;
        tx.commit()?;
        Ok(restored)
    }

    /// Keeps a draft under a name for the Conversation.
    pub fn save_draft_stash(
        &self,
        conversation: &str,
        window: &str,
        name: &str,
        content: DraftContent,
        expected: Option<i64>,
    ) -> Result<(DraftStashSaveOutcome, DraftStash)> {
        self.conversation(conversation)?;
        check_id(window)?;
        check_stash_name(name)?;
        check_text(&content.text)?;
        check_context_nodes(&content.context_nodes)?;
        ensure!(
            !is_blank(&content.text, &content.attachments) || !content.context_nodes.is_empty(),
            "Draft is empty"
        );
        ensure_tables(&self.connection)?;
        let tx = self.transaction()?;
        let existing = stash_of(&tx, conversation, name)?;
        let decision = decide_stash_save(
            existing
                .as_ref()
                .map(|stash| (stash_content(stash), stash.revision))
                .as_ref()
                .map(|(content, revision)| (content, *revision)),
            &content,
            expected,
        )?;
        let (outcome, revision) = match decision {
            StashSave::Unchanged => {
                let stash = existing.context("Stash is unavailable")?;
                return Ok((DraftStashSaveOutcome::Unchanged, stash));
            }
            StashSave::Conflict => anyhow::bail!(
                "Stash {name} changed since it was listed; list it again and pass its revision"
            ),
            StashSave::Create => {
                let count: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM draft_stashes WHERE conversation_id=?1",
                    [conversation],
                    |row| row.get(0),
                )?;
                ensure!(
                    count < STASHES_PER_CONVERSATION,
                    "Limit of {STASHES_PER_CONVERSATION} stashes per Conversation; drop one first"
                );
                (DraftStashSaveOutcome::Created, 1)
            }
            StashSave::Replace { revision } => (DraftStashSaveOutcome::Replaced, revision),
        };
        validate_attachments(&tx, conversation, &content.attachments)?;
        let stash = DraftStash {
            conversation_id: conversation.to_owned(),
            name: name.to_owned(),
            revision,
            text: content.text,
            attachments: content.attachments,
            context_nodes: content.context_nodes,
            window_id: window.to_owned(),
            saved_at: now_ms(),
        };
        tx.execute(
            "INSERT INTO draft_stashes(conversation_id,name,revision,text,attachments,context_nodes,window_id,saved_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(conversation_id,name) DO UPDATE SET revision=excluded.revision,text=excluded.text,attachments=excluded.attachments,context_nodes=excluded.context_nodes,window_id=excluded.window_id,saved_at=excluded.saved_at",
            params![stash.conversation_id, stash.name, stash.revision, stash.text, encode(&stash.attachments)?, encode(&stash.context_nodes)?, stash.window_id, stash.saved_at],
        )?;
        tx.commit()?;
        Ok((outcome, stash))
    }

    /// A Conversation's stashes, most recently saved first.
    pub fn draft_stashes(&self, conversation: &str) -> Result<Vec<DraftStash>> {
        self.conversation(conversation)?;
        ensure_tables(&self.connection)?;
        let mut statement = self.connection.prepare(&format!(
            "SELECT {STASH_COLUMNS} FROM draft_stashes WHERE conversation_id=?1 ORDER BY saved_at DESC, name"
        ))?;
        let stashes = statement
            .query_map([conversation], stash_row)?
            .collect::<rusqlite::Result<_>>()?;
        Ok(stashes)
    }

    /// Restores a stash into `window`. The stash stays until it is dropped.
    pub fn restore_draft_stash(
        &self,
        conversation: &str,
        window: &str,
        name: &str,
        stash_revision: i64,
        expected: i64,
        revision: i64,
    ) -> Result<Restored> {
        self.conversation(conversation)?;
        check_id(window)?;
        check_stash_name(name)?;
        ensure_tables(&self.connection)?;
        let tx = self.transaction()?;
        let stash = stash_of(&tx, conversation, name)?.context("Stash is unavailable")?;
        ensure!(
            stash.revision == stash_revision,
            "Stash changed since it was listed; list it again"
        );
        let restored = restore(
            &tx,
            conversation,
            window,
            expected,
            revision,
            stash_content(&stash),
        )?;
        tx.commit()?;
        Ok(restored)
    }

    /// Drops a stash at the revision the caller saw. Returns whether one went.
    pub fn drop_draft_stash(
        &self,
        conversation: &str,
        name: &str,
        stash_revision: i64,
    ) -> Result<bool> {
        self.conversation(conversation)?;
        check_stash_name(name)?;
        ensure_tables(&self.connection)?;
        let tx = self.transaction()?;
        let stored = stash_of(&tx, conversation, name)?.map(|stash| stash.revision);
        let dropped = decide_stash_drop(stored, stash_revision)?;
        if dropped {
            tx.execute(
                "DELETE FROM draft_stashes WHERE conversation_id=?1 AND name=?2 AND revision=?3",
                params![conversation, name, stash_revision],
            )?;
        }
        tx.commit()?;
        Ok(dropped)
    }
}

/// Applies a restore decision inside the caller's transaction.
fn restore(
    tx: &Connection,
    conversation: &str,
    window: &str,
    expected: i64,
    revision: i64,
    content: DraftContent,
) -> Result<Restored> {
    let pending: Option<String> = tx
        .query_row(
            "SELECT request_id FROM send_intents WHERE conversation_id=?1 AND window_id=?2 AND state IN ('pending','rejected')",
            params![conversation, window],
            |row| row.get(0),
        )
        .optional()?;
    ensure!(
        pending.is_none(),
        "Resolve the pending send before editing this draft"
    );
    let stored = draft_from(tx, conversation, window)?;
    match decide_restore(&stored, expected, revision, &content)? {
        Restore::Conflict => Ok(Restored {
            outcome: DraftRestoreOutcome::Conflict,
            draft: stored,
            context_nodes: Vec::new(),
            displaced_entry_id: None,
        }),
        Restore::AlreadyRestored => Ok(Restored {
            outcome: DraftRestoreOutcome::AlreadyRestored,
            draft: stored,
            context_nodes: content.context_nodes,
            displaced_entry_id: None,
        }),
        Restore::Write => {
            check_text(&content.text)?;
            // A reclaimed attachment fails the restore; nothing is written.
            validate_attachments(tx, conversation, &content.attachments)?;
            let displaced_entry_id = if displaces(&stored, &content) {
                Some(record_history(
                    tx,
                    conversation,
                    window,
                    DraftHistoryKind::Discarded,
                    &stored,
                    &format!("draft:{}", stored.revision),
                )?)
            } else {
                None
            };
            tx.execute(
                "INSERT INTO drafts(conversation_id,window_id,revision,text,attachments) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(conversation_id,window_id) DO UPDATE SET revision=excluded.revision,text=excluded.text,attachments=excluded.attachments",
                params![conversation, window, revision, content.text, encode(&content.attachments)?],
            )?;
            // The restored context becomes the live draft's context.
            write_draft_context(tx, conversation, window, revision, &content.context_nodes)?;
            Ok(Restored {
                outcome: DraftRestoreOutcome::Restored,
                draft: Draft {
                    text: content.text,
                    revision,
                    attachments: content.attachments,
                    context_nodes: content.context_nodes.clone(),
                },
                context_nodes: content.context_nodes,
                displaced_entry_id,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn draft(text: &str, revision: i64) -> Draft {
        Draft {
            context_nodes: Vec::new(),
            text: text.into(),
            revision,
            attachments: vec![],
        }
    }

    fn content(text: &str) -> DraftContent {
        DraftContent {
            text: text.into(),
            attachments: vec![],
            context_nodes: vec![],
        }
    }

    fn node(id: &str) -> DraftContextNode {
        DraftContextNode {
            id: id.into(),
            kind: "file".into(),
            data: json!({"path": "src/lib.rs"}),
        }
    }

    #[test]
    fn restore_writes_only_over_the_revision_the_caller_saw() {
        let restored = content("recalled");
        assert_eq!(
            decide_restore(&draft("typing", 4), 4, 5, &restored).unwrap(),
            Restore::Write
        );
        assert_eq!(
            decide_restore(&Draft::default(), 0, 1, &restored).unwrap(),
            Restore::Write
        );
        // A newer unsaved draft is never overwritten.
        assert_eq!(
            decide_restore(&draft("newer typing", 6), 4, 5, &restored).unwrap(),
            Restore::Conflict
        );
        // Another writer reached the requested revision with other text.
        assert_eq!(
            decide_restore(&draft("other", 5), 4, 5, &restored).unwrap(),
            Restore::Conflict
        );
    }

    #[test]
    fn a_retried_restore_converges() {
        assert_eq!(
            decide_restore(&draft("recalled", 5), 4, 5, &content("recalled")).unwrap(),
            Restore::AlreadyRestored
        );
    }

    #[test]
    fn restore_revision_must_move_forward() {
        assert!(decide_restore(&draft("", 4), 4, 4, &content("x")).is_err());
        assert!(decide_restore(&draft("", 4), 4, 3, &content("x")).is_err());
        assert!(decide_restore(&draft("", 0), -1, 3, &content("x")).is_err());
    }

    #[test]
    fn only_non_empty_replaced_drafts_are_kept() {
        assert!(displaces(&draft("typing", 3), &content("recalled")));
        assert!(!displaces(&draft("  ", 3), &content("recalled")));
        assert!(!displaces(&draft("same", 3), &content("same")));
        assert!(discarded_by(&draft("typing", 3), &draft("", 4)));
        assert!(!discarded_by(&draft("typing", 3), &draft("typing more", 4)));
        assert!(!discarded_by(&draft("", 3), &draft("", 4)));
    }

    #[test]
    fn stash_save_converges_and_replaces_only_at_the_seen_revision() {
        let first = content("first");
        let second = content("second");
        assert_eq!(
            decide_stash_save(None, &first, None).unwrap(),
            StashSave::Create
        );
        assert_eq!(
            decide_stash_save(None, &first, Some(0)).unwrap(),
            StashSave::Create
        );
        // The caller expected a stash that was dropped.
        assert_eq!(
            decide_stash_save(None, &first, Some(2)).unwrap(),
            StashSave::Conflict
        );
        assert_eq!(
            decide_stash_save(Some((&first, 2)), &first, None).unwrap(),
            StashSave::Unchanged
        );
        assert_eq!(
            decide_stash_save(Some((&first, 2)), &second, None).unwrap(),
            StashSave::Conflict
        );
        assert_eq!(
            decide_stash_save(Some((&first, 2)), &second, Some(1)).unwrap(),
            StashSave::Conflict
        );
        assert_eq!(
            decide_stash_save(Some((&first, 2)), &second, Some(2)).unwrap(),
            StashSave::Replace { revision: 3 }
        );
        // Context nodes are part of the stash.
        let mut with_node = first.clone();
        with_node.context_nodes.push(node("n1"));
        assert_eq!(
            decide_stash_save(Some((&first, 2)), &with_node, None).unwrap(),
            StashSave::Conflict
        );
    }

    #[test]
    fn stash_drop_converges_but_keeps_a_replaced_stash() {
        assert!(!decide_stash_drop(None, 3).unwrap());
        assert!(decide_stash_drop(Some(3), 3).unwrap());
        assert!(decide_stash_drop(Some(4), 3).is_err());
    }

    #[test]
    fn a_draft_keeps_context_only_at_the_revision_that_saved_it() {
        assert_eq!(
            context_for(Some((3, vec![node("n1")])), 3),
            vec![node("n1")]
        );
        // A later write that carried no context, such as a send clearing the
        // draft, leaves the stored context behind.
        assert!(context_for(Some((3, vec![node("n1")])), 4).is_empty());
        assert!(context_for(None, 3).is_empty());
        let mut with_context = draft("", 2);
        with_context.context_nodes.push(node("n1"));
        // Clearing a draft that held only context keeps it recallable.
        assert!(discarded_by(&with_context, &draft("", 3)));
        let content = DraftContent {
            text: String::new(),
            attachments: vec![],
            context_nodes: vec![node("n2")],
        };
        assert!(displaces(&with_context, &content));
    }

    #[test]
    fn names_and_context_nodes_are_bounded() {
        assert!(check_stash_name("later").is_ok());
        assert!(check_stash_name(&"n".repeat(128)).is_ok());
        assert!(check_stash_name(&"n".repeat(129)).is_err());
        assert!(check_stash_name("  ").is_err());
        assert!(check_stash_name("a\nb").is_err());
        assert!(check_context_nodes(&[node("a"), node("b")]).is_ok());
        assert!(check_context_nodes(&[node("a"), node("a")]).is_err());
        assert!(check_context_nodes(&[node("")]).is_err());
        let many: Vec<_> = (0..65).map(|index| node(&index.to_string())).collect();
        assert!(check_context_nodes(&many).is_err());
        let large = DraftContextNode {
            id: "big".into(),
            kind: "excerpt".into(),
            data: json!("x".repeat(CONTEXT_BYTES_LIMIT)),
        };
        assert!(check_context_nodes(&[large]).is_err());
    }
}
