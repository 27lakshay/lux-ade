//! Draft recall and stash operations (F036). The store decides and writes;
//! see `store/drafts.rs`.
use super::*;
use crate::store::{DraftContent, Restored};
use ade_core::contract::conversations::{
    DraftHistoryList, DraftHistoryListRequest, DraftHistoryRestoreRequest, DraftRestored,
    DraftStashDropRequest, DraftStashDropped, DraftStashList, DraftStashListRequest,
    DraftStashReply, DraftStashRestoreRequest, DraftStashSaveRequest,
};

fn restored(restored: Restored) -> Result<Value> {
    reply(&DraftRestored {
        tag: Default::default(),
        outcome: restored.outcome,
        draft: restored.draft,
        context_nodes: restored.context_nodes,
        displaced_entry_id: restored.displaced_entry_id,
    })
}

/// Whether `op` is one of this module's operations.
pub(super) fn handles(op: &str) -> bool {
    op.starts_with("draft.history.") || op.starts_with("draft.stash.")
}

impl Sessions {
    pub(super) fn draft_recall_command(&self, request: &Value) -> Result<Value> {
        let data = self.data.lock().unwrap();
        let store = &data.store;
        match request["op"].as_str().unwrap_or("") {
            "draft.history.list" => {
                let list: DraftHistoryListRequest = decode(request)?;
                let (entries, next_before) = store.draft_history(
                    non_empty("conversation_id", &list.conversation_id)?,
                    list.window_id.as_deref(),
                    list.before,
                    list.limit,
                )?;
                reply(&DraftHistoryList {
                    tag: Default::default(),
                    entries,
                    next_before,
                })
            }
            "draft.history.restore" => {
                let restore: DraftHistoryRestoreRequest = decode(request)?;
                restored(persistence_result(store.restore_draft_history(
                    non_empty("conversation_id", &restore.conversation_id)?,
                    non_empty("window_id", &restore.window_id)?,
                    restore.entry_id,
                    restore.expected_revision,
                    restore.revision,
                ))?)
            }
            "draft.stash.save" => {
                let save: DraftStashSaveRequest = decode(request)?;
                let (outcome, stash) = persistence_result(store.save_draft_stash(
                    non_empty("conversation_id", &save.conversation_id)?,
                    non_empty("window_id", &save.window_id)?,
                    &save.name,
                    DraftContent {
                        text: save.text,
                        attachments: save.attachments,
                        context_nodes: save.context_nodes,
                    },
                    save.expected_revision,
                ))?;
                reply(&DraftStashReply {
                    tag: Default::default(),
                    outcome,
                    stash,
                })
            }
            "draft.stash.list" => {
                let list: DraftStashListRequest = decode(request)?;
                reply(&DraftStashList {
                    tag: Default::default(),
                    stashes: store
                        .draft_stashes(non_empty("conversation_id", &list.conversation_id)?)?,
                })
            }
            "draft.stash.restore" => {
                let restore: DraftStashRestoreRequest = decode(request)?;
                restored(persistence_result(store.restore_draft_stash(
                    non_empty("conversation_id", &restore.conversation_id)?,
                    non_empty("window_id", &restore.window_id)?,
                    &restore.name,
                    restore.stash_revision,
                    restore.expected_revision,
                    restore.revision,
                ))?)
            }
            "draft.stash.drop" => {
                let drop: DraftStashDropRequest = decode(request)?;
                let dropped = persistence_result(store.drop_draft_stash(
                    non_empty("conversation_id", &drop.conversation_id)?,
                    &drop.name,
                    drop.stash_revision,
                ))?;
                reply(&DraftStashDropped {
                    tag: Default::default(),
                    conversation_id: drop.conversation_id,
                    name: drop.name,
                    dropped,
                })
            }
            _ => bail!("Unknown session operation"),
        }
    }
}
