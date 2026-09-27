//! `history.import.*` operations (F042). Native session files are read without
//! the session lock; an import then commits in one transaction on the profile
//! database and publishes the changed catalog.
use super::*;
use crate::history::import::{self, ImportTarget, NativeStore};
use ade_core::contract::history::{
    HistoryImportOutcome, HistoryImportProvider, HistoryImportRequest, HistoryImportScanRequest,
};

impl Sessions {
    fn native_store(
        &self,
        provider: HistoryImportProvider,
        account_id: Option<&str>,
    ) -> Result<NativeStore> {
        let Some(id) = account_id else {
            return NativeStore::default_for(provider);
        };
        let account = self
            .data
            .lock()
            .unwrap()
            .store
            .account(non_empty("account_id", id)?)?;
        ensure!(
            account.provider == provider.id(),
            "Account belongs to another provider"
        );
        Ok(NativeStore {
            provider,
            account_id: Some(account.id),
            home: account.native_home.into(),
        })
    }

    pub(super) fn history_import_command(self: &Arc<Self>, request: &Value) -> Result<Value> {
        match request["op"].as_str().unwrap_or("") {
            "history.import.scan" => {
                let scan: HistoryImportScanRequest = decode(request)?;
                let limit = scan.limit.unwrap_or(50);
                ensure!(
                    (1..=200).contains(&limit),
                    "Import scan limit must be 1 to 200"
                );
                let store = self.native_store(scan.provider, scan.account_id.as_deref())?;
                let workspace_root = scan
                    .workspace_id
                    .as_deref()
                    .map(|id| {
                        let d = self.data.lock().unwrap();
                        Ok::<_, anyhow::Error>(std::path::PathBuf::from(
                            d.store.workspace(non_empty("workspace_id", id)?)?.root,
                        ))
                    })
                    .transpose()?;
                let mut reply = import::scan(&store, workspace_root.as_deref(), limit as usize);
                let d = self.data.lock().unwrap();
                import::ensure_table(&d.store.connection)?;
                import::mark_imported(&d.store.connection, scan.provider, &mut reply.sessions)?;
                super::reply(&reply)
            }
            "history.import.session" => {
                let request: HistoryImportRequest = decode(request)?;
                let workspace_id = non_empty("workspace_id", &request.workspace_id)?;
                let store = self.native_store(request.provider, request.account_id.as_deref())?;
                let session = import::read_session(&store, &request.native_session_id)?;
                let mut d = self.data.lock().unwrap();
                ensure!(!d.draining, "Application daemon is restarting");
                let (reply, _) = import::commit(
                    &d.store.connection,
                    &ImportTarget {
                        provider: request.provider,
                        native_session_id: &request.native_session_id,
                        workspace_id,
                        account_id: store.account_id.as_deref(),
                    },
                    &session,
                )?;
                if reply.outcome != HistoryImportOutcome::Unchanged {
                    self.catalog_changed(&mut d)?;
                }
                super::reply(&reply)
            }
            _ => bail!("Unknown history import operation"),
        }
    }

    /// Refuses to run an imported conversation. It holds read-only native
    /// history that ADE cannot resume, and starting a fresh native session
    /// under it would present new work as a continuation.
    pub(super) fn ensure_not_imported(conversation: &Conversation) -> Result<()> {
        ensure!(
            conversation.status != import::IMPORTED_STATUS,
            "This conversation is an imported native session and is read-only: {}",
            import::RESUME_UNAVAILABLE
        );
        Ok(())
    }
}
