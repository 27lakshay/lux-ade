use super::*;

pub use ade_core::contract::conversations::AttachmentReclaimPreview;

fn attachment_reclaim_preview_from(
    db: &Connection,
    conversation: &str,
    id: &str,
) -> Result<AttachmentReclaimPreview> {
    one::<Conversation>(db, "conversations", conversation)?;
    check_id(id)?;
    let (owner, metadata, generation, state, created_at, payload_bytes):
        (String, String, String, String, i64, i64) = db
        .query_row(
            "SELECT conversation_id,metadata,generation,state,created_at,length(data) FROM attachments WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        )
        .context("Attachment is unavailable")?;
    ensure!(
        owner == conversation,
        "Attachment belongs to another Conversation"
    );
    ensure!(
        matches!(state.as_str(), "live" | "discarded"),
        "Attachment state is invalid"
    );
    let attachment: Attachment = decode(metadata)?;
    ensure!(
        !generation.is_empty()
            && attachment.id == id
            && ((state == "live" && payload_bytes == attachment.size as i64)
                || (state == "discarded" && payload_bytes == 0)),
        "Attachment payload or generation is invalid"
    );
    let mut protected_by = Vec::new();
    for (name, query) in [
        (
            "message",
            "SELECT EXISTS(SELECT 1 FROM messages m, json_each(m.data,'$.attachments') a WHERE m.conversation_id=?1 AND json_extract(a.value,'$.id')=?2)",
        ),
        (
            "draft",
            "SELECT EXISTS(SELECT 1 FROM drafts d, json_each(d.attachments) a WHERE d.conversation_id=?1 AND json_extract(a.value,'$.id')=?2)",
        ),
        (
            "queued_prompt",
            "SELECT EXISTS(SELECT 1 FROM queued_prompts q, json_each(q.attachments) a WHERE q.conversation_id=?1 AND q.status='queued' AND json_extract(a.value,'$.id')=?2)",
        ),
        (
            "send_intent",
            "SELECT EXISTS(SELECT 1 FROM send_intents s, json_each(s.attachments) a WHERE s.conversation_id=?1 AND s.state IN ('pending','rejected') AND json_extract(a.value,'$.id')=?2)",
        ),
    ] {
        let found: i64 = db.query_row(query, params![conversation, id], |row| row.get(0))?;
        if found != 0 {
            protected_by.push(name.to_owned());
        }
    }
    if state == "discarded" {
        protected_by.push("already_discarded".to_owned());
    }
    let reclaimable = protected_by.is_empty();
    Ok(AttachmentReclaimPreview {
        attachment_id: id.to_owned(),
        conversation_id: conversation.to_owned(),
        generation,
        state,
        created_at,
        payload_bytes,
        estimated_reusable_payload_bytes: if reclaimable { payload_bytes } else { 0 },
        protected_by,
        reclaimable,
    })
}

pub(super) fn attachment_row(
    row: &rusqlite::Row<'_>,
    column: usize,
) -> rusqlite::Result<Vec<Attachment>> {
    let value: String = row.get(column)?;
    serde_json::from_str(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}
pub(super) fn validate_attachments(
    db: &Connection,
    conversation: &str,
    attachments: &[Attachment],
) -> Result<()> {
    ensure!(
        attachments.len() <= crate::prompt::ATTACHMENT_COUNT,
        "Limit of 8 attachments per prompt"
    );
    let mut ids = std::collections::HashSet::new();
    let mut bytes = 0usize;
    for attachment in attachments {
        ensure!(ids.insert(&attachment.id), "Duplicate attachment");
        let (owner, metadata, state, size): (String, String, String, i64) = db
            .query_row(
                "SELECT conversation_id,metadata,state,length(data) FROM attachments WHERE id=?1",
                [&attachment.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .context("Attachment is missing; attach the file again")?;
        ensure!(
            owner == conversation
                && state == "live"
                && size == attachment.size as i64
                && decode::<Attachment>(metadata)? == *attachment,
            "Attachment is unavailable, belongs to another Conversation, or its metadata changed"
        );
        bytes = bytes
            .checked_add(attachment.size)
            .context("Attachment size overflow")?;
    }
    ensure!(
        bytes <= crate::prompt::ATTACHMENT_LIMIT,
        "Attachments exceed 8 MiB per prompt"
    );
    Ok(())
}

impl Store {
    pub fn attach(
        &self,
        conversation: &str,
        id: &str,
        name: &str,
        bytes: &[u8],
    ) -> Result<Attachment> {
        check_id(id)?;
        self.conversation(conversation)?;
        let tx = self.transaction()?;
        let attachment = store_attachment(&tx, conversation, id, name, bytes)?;
        tx.commit()?;
        Ok(attachment)
    }
}

/// Stores one attachment inside the caller's transaction, which has checked
/// the ID and the Conversation. A repeat with the same ID converges only on
/// identical bytes and metadata.
pub(super) fn store_attachment(
    tx: &Connection,
    conversation: &str,
    id: &str,
    name: &str,
    bytes: &[u8],
) -> Result<Attachment> {
    ensure!(
        !name.is_empty() && name.len() <= 255 && !name.contains(['\0', '\n', '\r']),
        "Invalid attachment name"
    );
    let media_type = crate::prompt::media_type(bytes)?;
    let attachment = Attachment {
        id: id.into(),
        name: name.into(),
        media_type: media_type.into(),
        size: bytes.len(),
    };
    let prior: Option<(String, String, Vec<u8>, String)> = tx
        .query_row(
            "SELECT conversation_id,metadata,data,state FROM attachments WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    if let Some((owner, metadata, data, state)) = prior {
        ensure!(
            state == "live"
                && owner == conversation
                && decode::<Attachment>(metadata)? == attachment
                && data == bytes,
            "Attachment ID was already used or discarded"
        );
        return Ok(attachment);
    }
    let total: i64 = tx.query_row(
        "SELECT COALESCE(sum(length(data)),0) FROM attachments WHERE conversation_id=?1",
        [conversation],
        |row| row.get(0),
    )?;
    ensure!(
        total + bytes.len() as i64 <= 128 * 1024 * 1024,
        "Conversation attachment storage exceeds 128 MiB"
    );
    tx.execute(
            "INSERT INTO attachments(id,conversation_id,metadata,data,generation,state,created_at) VALUES(?1,?2,?3,?4,?5,'live',?6)",
            params![id, conversation, encode(&attachment)?, bytes, new_id("attachment_generation"), now_ms()],
        )?;
    Ok(attachment)
}

impl Store {
    /// Only an explicit exact-ID discard can reclaim an upload. Unsaved client-held
    /// uploads have no durable reference, so they are never swept automatically.
    pub fn attachment_reclaim_preview(
        &self,
        conversation: &str,
        id: &str,
    ) -> Result<AttachmentReclaimPreview> {
        attachment_reclaim_preview_from(&self.connection, conversation, id)
    }
    pub fn attachment_inspect(&self, conversation: &str, id: &str) -> Result<(Attachment, String)> {
        use sha2::{Digest, Sha256};
        let preview = attachment_reclaim_preview_from(&self.connection, conversation, id)?;
        ensure!(preview.state == "live", "Attachment is unavailable");
        let (metadata, data): (String, Vec<u8>) = self.connection.query_row(
            "SELECT metadata,data FROM attachments WHERE id=?1 AND conversation_id=?2 AND state='live'",
            params![id, conversation],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let attachment: Attachment = decode(metadata)?;
        ensure!(
            data.len() == attachment.size,
            "Attachment payload is invalid"
        );
        let digest = Sha256::digest(data);
        Ok((
            attachment,
            digest.iter().map(|byte| format!("{byte:02x}")).collect(),
        ))
    }
    pub fn attachment_reclaim_apply(
        &self,
        conversation: &str,
        id: &str,
        expected_generation: &str,
    ) -> Result<(AttachmentReclaimPreview, i64)> {
        ensure!(
            !expected_generation.is_empty(),
            "Expected attachment generation is required"
        );
        let tx = self.transaction()?;
        let preview = attachment_reclaim_preview_from(&tx, conversation, id)?;
        ensure!(
            preview.generation == expected_generation,
            "Attachment changed since reclaim preview; inspect it again"
        );
        ensure!(
            preview.reclaimable || preview.state == "discarded",
            "Attachment is still referenced; inspect it again before reclaiming"
        );
        if preview.state == "live" {
            ensure!(
                tx.execute(
                    "UPDATE attachments SET data=X'',state='discarded' WHERE id=?1 AND generation=?2 AND state='live'",
                    params![id, expected_generation],
                )? == 1,
                "Attachment changed during reclaim"
            );
        }
        tx.commit()?;
        let reclaimed = if preview.state == "live" {
            preview.payload_bytes
        } else {
            0
        };
        Ok((
            AttachmentReclaimPreview {
                state: "discarded".into(),
                payload_bytes: 0,
                estimated_reusable_payload_bytes: 0,
                protected_by: vec!["already_discarded".into()],
                reclaimable: false,
                ..preview
            },
            reclaimed,
        ))
    }
    pub fn prompt(
        &self,
        conversation: &str,
        text: &str,
        attachments: &[Attachment],
    ) -> Result<crate::prompt::Prompt> {
        use base64::Engine;
        validate_attachments(&self.connection, conversation, attachments)?;
        let content = attachments
            .iter()
            .map(|attachment| {
                let bytes: Vec<u8> = self.connection.query_row(
                    "SELECT data FROM attachments WHERE id=?1 AND state='live'",
                    [&attachment.id],
                    |row| row.get(0),
                )?;
                Ok(crate::prompt::Content {
                    attachment: attachment.clone(),
                    data: base64::engine::general_purpose::STANDARD.encode(bytes),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(crate::prompt::Prompt {
            text: text.into(),
            attachments: content,
        })
    }
}
