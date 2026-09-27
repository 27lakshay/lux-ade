//! Context nodes (F033): one row per capture, keyed by the caller's request
//! ID, beside the attachment that carries a text capture. The row and the
//! attachment commit in one transaction, so a node never names an attachment
//! that was not stored.
use super::attachments::store_attachment;
use super::*;
use ade_core::contract::context::ContextNode;

fn ensure_table(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS context_nodes(
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            node TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )",
    )?;
    Ok(())
}

fn recorded(db: &Connection, id: &str) -> Result<Option<(String, String, ContextNode)>> {
    let row: Option<(String, String, String)> = db
        .query_row(
            "SELECT conversation_id,fingerprint,node FROM context_nodes WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    row.map(|(conversation, fingerprint, node)| Ok((conversation, fingerprint, decode(node)?)))
        .transpose()
}

impl Store {
    /// The node recorded under `id`, with the fingerprint of the request that
    /// made it. A node of another Conversation is not found.
    pub fn context_node(
        &self,
        conversation: &str,
        id: &str,
    ) -> Result<Option<(String, ContextNode)>> {
        ensure_table(&self.connection)?;
        Ok(recorded(&self.connection, id)?
            .filter(|(owner, _, _)| owner == conversation)
            .map(|(_, fingerprint, node)| (fingerprint, node)))
    }

    /// Records a node and, for a text capture, its document as the
    /// attachment named by the node ID. A repeat with the same fingerprint
    /// returns the first node; a different request under the same ID fails.
    pub fn record_context_node(
        &self,
        node: &ContextNode,
        fingerprint: &str,
        document: Option<(&str, &[u8])>,
    ) -> Result<ContextNode> {
        check_id(&node.id)?;
        self.conversation(&node.conversation_id)?;
        ensure_table(&self.connection)?;
        let tx = self.transaction()?;
        if let Some((owner, prior, existing)) = recorded(&tx, &node.id)? {
            ensure!(
                owner == node.conversation_id && prior == fingerprint,
                "Context request ID was already used for a different capture"
            );
            return Ok(existing);
        }
        let mut node = node.clone();
        if let Some((name, bytes)) = document {
            let attachment = store_attachment(&tx, &node.conversation_id, &node.id, name, bytes)?;
            node.attachments.insert(0, attachment);
            node.sha256.insert(0, sha256(bytes));
        }
        ensure!(
            !node.attachments.is_empty(),
            "A context node needs at least one attachment"
        );
        tx.execute(
            "INSERT INTO context_nodes(id,conversation_id,fingerprint,node,created_at) VALUES(?1,?2,?3,?4,?5)",
            params![node.id, node.conversation_id, fingerprint, encode(&node)?, now_ms()],
        )?;
        tx.commit()?;
        Ok(node)
    }

    /// Whether the workspace configures a service with this name.
    pub fn service_configured(&self, workspace: &str, name: &str) -> Result<bool> {
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM services WHERE workspace_id=?1 AND name=?2)",
            params![workspace, name],
            |row| row.get(0),
        )?)
    }

    /// A live attachment of `conversation` and its bytes.
    pub fn attachment_bytes(
        &self,
        conversation: &str,
        id: &str,
    ) -> Result<Option<(Attachment, Vec<u8>)>> {
        let row: Option<(String, Vec<u8>)> = self
            .connection
            .query_row(
                "SELECT metadata,data FROM attachments WHERE id=?1 AND conversation_id=?2 AND state='live'",
                params![id, conversation],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        row.map(|(metadata, data)| {
            let attachment: Attachment = decode(metadata)?;
            ensure!(
                data.len() == attachment.size,
                "Attachment payload is invalid"
            );
            Ok((attachment, data))
        })
        .transpose()
    }
}

/// Lowercase hex SHA-256.
pub fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
