//! Profile-scoped generic adapter definitions and their probes (F024).
//!
//! Definitions live in `sessions.sqlite`, in a table this module creates
//! idempotently. A definition is validated by the runtime's
//! [`ade_runtime::adapters::validate`] before it is stored. A probe runs
//! outside the database lock and is saved only if the definition it probed is
//! still the stored revision, so a probe never vouches for a definition it
//! did not see.
use ade_core::contract::providers::adapters::*;
use ade_runtime::adapters as runtime;
use anyhow::{Context as _, Result, anyhow, ensure};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::Value;
use std::{path::Path, sync::Mutex, time::Duration};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS provider_adapters(id TEXT PRIMARY KEY, definition TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 1), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, probe TEXT);
CREATE TABLE IF NOT EXISTS adapter_conversation_pins(conversation_id TEXT PRIMARY KEY, adapter_id TEXT NOT NULL, revision INTEGER NOT NULL, adapter_created_at INTEGER NOT NULL);
";

/// Which definition a conversation's adapter was when it pinned it: the
/// revision, and the creation time that tells a removed and re-added adapter
/// apart from the one the conversation started on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pinned {
    pub revision: u64,
    pub created_at: i64,
}

/// What a launch does with a conversation's adapter pin.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PinDecision {
    /// The stored definition is the one the conversation pinned.
    Keep,
    /// Nothing native exists yet, so the conversation moves to the current
    /// definition.
    Repin,
    /// A native session exists on another definition: fail closed rather than
    /// resume it with a different agent command.
    Refuse(String),
}

/// Decides whether a run may launch the stored definition `current` for a
/// conversation pinned to `pinned`. `session_started` is whether the
/// conversation already has a native session.
pub fn pin_decision(
    adapter_id: &str,
    pinned: Option<Pinned>,
    current: Pinned,
    session_started: bool,
) -> PinDecision {
    match pinned {
        Some(pinned) if pinned == current => PinDecision::Keep,
        _ if !session_started => PinDecision::Repin,
        Some(pinned) if pinned.created_at == current.created_at => PinDecision::Refuse(format!(
            "Adapter {adapter_id} changed from revision {} to {} after this conversation started; ADE does not resume a session with a different adapter definition. Start a new conversation",
            pinned.revision, current.revision
        )),
        _ => PinDecision::Refuse(format!(
            "Adapter {adapter_id} was removed and defined again after this conversation started; ADE does not resume a session with a different adapter definition. Start a new conversation"
        )),
    }
}

pub struct Adapters {
    db: Mutex<Connection>,
}

struct Row {
    definition: AdapterDefinition,
    revision: u64,
    created_at: i64,
    updated_at: i64,
    probe: Option<AdapterProbe>,
}

/// Whether a stored probe still describes the adapter. `current` is the
/// executable's identity now, or `None` when it cannot be inspected.
pub fn readiness(
    revision: u64,
    probe: Option<&AdapterProbe>,
    current: Option<&ExecutableIdentity>,
) -> AdapterReadiness {
    let Some(probe) = probe else {
        return AdapterReadiness::Unprobed;
    };
    if probe.revision != revision {
        return AdapterReadiness::Stale;
    }
    match &probe.outcome {
        ProbeOutcome::Failed { .. } => AdapterReadiness::Failed,
        ProbeOutcome::Ready { .. }
            if probe.executable.is_some() && probe.executable.as_ref() == current =>
        {
            AdapterReadiness::Ready
        }
        ProbeOutcome::Ready { .. } => AdapterReadiness::Stale,
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            elapsed.as_millis().min(i64::MAX as u128) as i64
        })
}

fn decode<T: serde::de::DeserializeOwned>(request: &Value) -> Result<T> {
    T::deserialize(request).map_err(|error| anyhow!("Invalid request: {error}"))
}

fn reply<T: serde::Serialize>(value: &T) -> Result<Value> {
    Ok(serde_json::to_value(value)?)
}

fn read(tx: &Connection, id: &str) -> Result<Option<Row>> {
    tx.query_row(
        "SELECT definition, revision, created_at, updated_at, probe FROM provider_adapters WHERE id=?1",
        params![id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        },
    )
    .optional()?
    .map(|(definition, revision, created_at, updated_at, probe)| {
        Ok(Row {
            definition: serde_json::from_str(&definition)
                .context("Stored adapter definition is unreadable")?,
            revision: u64::try_from(revision).context("Stored adapter revision is invalid")?,
            created_at,
            updated_at,
            probe: probe
                .map(|probe| serde_json::from_str(&probe))
                .transpose()
                .context("Stored adapter probe is unreadable")?,
        })
    })
    .transpose()
}

fn record(row: Row) -> AdapterRecord {
    let current = runtime::check_executable(&row.definition.command).ok();
    AdapterRecord {
        provider_id: runtime::provider_id(&row.definition.id),
        readiness: readiness(row.revision, row.probe.as_ref(), current.as_ref()),
        definition: row.definition,
        revision: row.revision,
        created_at: row.created_at,
        updated_at: row.updated_at,
        probe: row.probe,
    }
}

/// The descriptor a ready adapter publishes: the registry entry's, with the
/// capabilities its probe discovered.
fn descriptor(record: &AdapterRecord) -> ade_core::provider::Descriptor {
    use ade_runtime::provider::registry::{AdapterEntry, ProviderEntry};
    let mut descriptor = AdapterEntry {
        definition: record.definition.clone(),
    }
    .descriptor();
    if let Some(AdapterProbe {
        outcome: ProbeOutcome::Ready { capabilities, .. },
        ..
    }) = &record.probe
    {
        descriptor.capabilities = capabilities.clone();
    }
    descriptor
}

fn check_id(id: &str) -> Result<()> {
    ensure!(
        !id.is_empty() && id.len() <= 40,
        "Adapter ID must be 1 to 40 characters"
    );
    Ok(())
}

impl Adapters {
    /// Opens adapter state inside the profile database at `path`.
    pub fn open(path: &Path) -> Result<Self> {
        let db = Connection::open(path)?;
        db.busy_timeout(Duration::from_secs(5))?;
        let tx = Transaction::new_unchecked(&db, TransactionBehavior::Immediate)?;
        tx.execute_batch(SCHEMA)?;
        tx.commit()?;
        Ok(Self { db: Mutex::new(db) })
    }

    pub fn command(&self, request: &Value) -> Result<Value> {
        let result = match request["op"].as_str().unwrap_or("") {
            "adapter.list" => self.list(),
            "adapter.put" => self.put(decode(request)?),
            "adapter.remove" => self.remove(decode(request)?),
            "adapter.probe" => self.probe(decode(request)?),
            _ => Err(anyhow!("Unknown adapter operation")),
        };
        result.map_err(|error| {
            if error.downcast_ref::<rusqlite::Error>().is_some() {
                tracing::error!(target: "ade", event = "adapter_store_failed", error = %error);
                anyhow!("Adapter definitions are unavailable; retry")
            } else {
                error
            }
        })
    }

    /// Every stored definition with its revision, ordered by ID.
    pub fn definitions(&self) -> Result<Vec<(AdapterDefinition, u64)>> {
        let db = self.db.lock().unwrap();
        let mut statement =
            db.prepare("SELECT definition, revision FROM provider_adapters ORDER BY id")?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(definition, revision)| {
                Ok((serde_json::from_str(&definition)?, u64::try_from(revision)?))
            })
            .collect()
    }

    /// The registry descriptor of adapter `id`, for validating a new
    /// conversation. Only a ready adapter takes new conversations.
    pub fn descriptor_for_new(&self, id: &str) -> Result<ade_core::provider::Descriptor> {
        check_id(id)?;
        let row = read(&self.db.lock().unwrap(), id)?
            .with_context(|| format!("No adapter has ID {id}; define it with adapter.put first"))?;
        let record = record(row);
        ensure!(
            record.readiness == AdapterReadiness::Ready,
            "Adapter {id} is {:?}, not ready; probe it with adapter.probe first",
            record.readiness
        );
        Ok(descriptor(&record))
    }

    /// Descriptors of the adapters that are ready now, by ID.
    pub fn ready_descriptors(&self) -> Result<Vec<ade_core::provider::Descriptor>> {
        let rows: Vec<Row> = {
            let db = self.db.lock().unwrap();
            let mut statement = db.prepare("SELECT id FROM provider_adapters ORDER BY id")?;
            let ids: Vec<String> = statement
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            ids.iter()
                .filter_map(|id| read(&db, id).transpose())
                .collect::<Result<_>>()?
        };
        Ok(rows
            .into_iter()
            .map(record)
            .filter(|record| record.readiness == AdapterReadiness::Ready)
            .map(|record| descriptor(&record))
            .collect())
    }

    /// Pins a new conversation to adapter `id`'s current definition.
    pub fn pin(&self, conversation_id: &str, id: &str) -> Result<()> {
        let db = self.db.lock().unwrap();
        let row = read(&db, id)?.with_context(|| format!("Adapter {id} was removed"))?;
        db.execute(
            "INSERT OR REPLACE INTO adapter_conversation_pins(conversation_id, adapter_id, revision, adapter_created_at) VALUES(?1, ?2, ?3, ?4)",
            params![conversation_id, id, row.revision as i64, row.created_at],
        )?;
        Ok(())
    }

    /// The definition a run of `conversation_id` launches, decided by
    /// [`pin_decision`]. A removed adapter launches nothing; the
    /// conversation's history stays readable.
    pub fn launch_pin(
        &self,
        conversation_id: &str,
        id: &str,
        session_started: bool,
    ) -> Result<AdapterPin> {
        let db = self.db.lock().unwrap();
        let row = read(&db, id)?.with_context(|| {
            format!("Adapter {id} was removed; this conversation's history stays readable, but it cannot run")
        })?;
        let pinned = db
            .query_row(
                "SELECT revision, adapter_created_at FROM adapter_conversation_pins WHERE conversation_id=?1 AND adapter_id=?2",
                params![conversation_id, id],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
            )
            .optional()?
            .map(|(revision, created_at)| Pinned {
                revision: revision.max(0) as u64,
                created_at,
            });
        let current = Pinned {
            revision: row.revision,
            created_at: row.created_at,
        };
        match pin_decision(id, pinned, current, session_started) {
            PinDecision::Keep => {}
            PinDecision::Repin => {
                db.execute(
                    "INSERT OR REPLACE INTO adapter_conversation_pins(conversation_id, adapter_id, revision, adapter_created_at) VALUES(?1, ?2, ?3, ?4)",
                    params![conversation_id, id, row.revision as i64, row.created_at],
                )?;
            }
            PinDecision::Refuse(reason) => return Err(anyhow!(reason)),
        }
        Ok(AdapterPin {
            revision: row.revision,
            definition: row.definition,
        })
    }

    fn list(&self) -> Result<Value> {
        let ids: Vec<String> = {
            let db = self.db.lock().unwrap();
            let mut statement = db.prepare("SELECT id FROM provider_adapters ORDER BY id")?;
            statement
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?
        };
        let mut adapters = Vec::with_capacity(ids.len());
        for id in ids {
            let row = read(&self.db.lock().unwrap(), &id)?;
            if let Some(row) = row {
                adapters.push(record(row));
            }
        }
        reply(&AdapterList {
            tag: AdapterListTag::Tag,
            adapters,
        })
    }

    fn put(&self, request: AdapterPutRequest) -> Result<Value> {
        let definition = request.definition;
        runtime::validate(&definition)?;
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = read(&tx, &definition.id)?;
        if let Some(expected) = request.expected_revision {
            let stored = existing.as_ref().map_or(0, |row| row.revision);
            ensure!(
                stored == expected,
                "Adapter {} is at revision {stored}, not {expected}; list it and retry",
                definition.id
            );
        }
        let now = now_ms();
        let (row, changed) = match existing {
            Some(row) if row.definition == definition => (row, false),
            Some(row) => {
                let revision = row.revision + 1;
                tx.execute(
                    "UPDATE provider_adapters SET definition=?2, revision=?3, updated_at=?4 WHERE id=?1",
                    params![
                        definition.id,
                        serde_json::to_string(&definition)?,
                        revision as i64,
                        now
                    ],
                )?;
                (
                    Row {
                        definition,
                        revision,
                        created_at: row.created_at,
                        updated_at: now,
                        probe: row.probe,
                    },
                    true,
                )
            }
            None => {
                tx.execute(
                    "INSERT INTO provider_adapters(id, definition, revision, created_at, updated_at, probe) VALUES(?1, ?2, 1, ?3, ?3, NULL)",
                    params![definition.id, serde_json::to_string(&definition)?, now],
                )?;
                (
                    Row {
                        definition,
                        revision: 1,
                        created_at: now,
                        updated_at: now,
                        probe: None,
                    },
                    true,
                )
            }
        };
        tx.commit()?;
        drop(db);
        reply(&AdapterPut {
            tag: AdapterPutTag::Tag,
            changed,
            adapter: record(row),
        })
    }

    fn remove(&self, request: AdapterRemoveRequest) -> Result<Value> {
        check_id(&request.id)?;
        let removed = self.db.lock().unwrap().execute(
            "DELETE FROM provider_adapters WHERE id=?1",
            params![request.id],
        )? > 0;
        reply(&AdapterRemoved {
            tag: AdapterRemovedTag::Tag,
            id: request.id,
            removed,
        })
    }

    fn probe(&self, request: AdapterProbeRequest) -> Result<Value> {
        check_id(&request.id)?;
        let row = read(&self.db.lock().unwrap(), &request.id)?
            .with_context(|| format!("No adapter has ID {}", request.id))?;
        if let Some(expected) = request.expected_revision {
            ensure!(
                row.revision == expected,
                "Adapter {} is at revision {}, not {expected}; list it and retry",
                request.id,
                row.revision
            );
        }
        // The agent is launched outside any lock; `initialize` can take time.
        let cwd = std::env::temp_dir();
        let (executable, outcome) = runtime::probe(&row.definition, &cwd.to_string_lossy());
        let probe = AdapterProbe {
            revision: row.revision,
            probed_at: now_ms(),
            executable,
            outcome,
        };
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = read(&tx, &request.id)?
            .with_context(|| format!("Adapter {} was removed during the probe", request.id))?;
        ensure!(
            current.revision == row.revision && current.definition == row.definition,
            "Adapter {} changed during the probe; probe it again",
            request.id
        );
        tx.execute(
            "UPDATE provider_adapters SET probe=?2 WHERE id=?1",
            params![request.id, serde_json::to_string(&probe)?],
        )?;
        tx.commit()?;
        drop(db);
        reply(&AdapterProbed {
            tag: AdapterProbedTag::Tag,
            adapter: record(Row {
                probe: Some(probe),
                ..current
            }),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(size: u64) -> ExecutableIdentity {
        ExecutableIdentity {
            device: "1".into(),
            inode: "2".into(),
            size,
            modified_ms: 3,
        }
    }

    fn probe(revision: u64, ready: bool) -> AdapterProbe {
        AdapterProbe {
            revision,
            probed_at: 0,
            executable: Some(identity(10)),
            outcome: if ready {
                ProbeOutcome::Ready {
                    capabilities: vec!["streaming".into()],
                    acp: None,
                }
            } else {
                ProbeOutcome::Failed { error: "no".into() }
            },
        }
    }

    #[test]
    fn a_started_session_never_moves_to_another_definition() {
        let at = |revision, created_at| Pinned {
            revision,
            created_at,
        };
        assert_eq!(
            pin_decision("a", Some(at(1, 5)), at(1, 5), true),
            PinDecision::Keep
        );
        // Nothing native yet: the conversation follows the current definition.
        assert_eq!(
            pin_decision("a", Some(at(1, 5)), at(2, 5), false),
            PinDecision::Repin
        );
        assert_eq!(pin_decision("a", None, at(1, 5), false), PinDecision::Repin);
        // Edited, or removed and defined again, after the session started.
        assert!(matches!(
            pin_decision("a", Some(at(1, 5)), at(2, 5), true),
            PinDecision::Refuse(reason) if reason.contains("revision 1 to 2")
        ));
        assert!(matches!(
            pin_decision("a", Some(at(1, 5)), at(1, 9), true),
            PinDecision::Refuse(reason) if reason.contains("defined again")
        ));
        assert!(matches!(
            pin_decision("a", None, at(1, 5), true),
            PinDecision::Refuse(_)
        ));
    }

    #[test]
    fn readiness_requires_the_same_revision_and_executable() {
        let now = identity(10);
        assert_eq!(readiness(1, None, Some(&now)), AdapterReadiness::Unprobed);
        assert_eq!(
            readiness(1, Some(&probe(1, true)), Some(&now)),
            AdapterReadiness::Ready
        );
        assert_eq!(
            readiness(2, Some(&probe(1, true)), Some(&now)),
            AdapterReadiness::Stale
        );
        assert_eq!(
            readiness(1, Some(&probe(1, true)), Some(&identity(11))),
            AdapterReadiness::Stale
        );
        assert_eq!(
            readiness(1, Some(&probe(1, true)), None),
            AdapterReadiness::Stale
        );
        assert_eq!(
            readiness(1, Some(&probe(1, false)), Some(&now)),
            AdapterReadiness::Failed
        );
    }
}
