//! Development-mode decisions (F139, F060): when a watched source reloads,
//! how a superseded host drains, when a generation retires, and whether a
//! reload may change the data schema.
//!
//! Plain data and pure functions, so the watcher and the drain threads hold
//! no lock while they decide. `fingerprint` is the one function here that
//! reads the file system.
//!
//! The trailing debounce follows the pattern in Orca
//! `src/main/plugins/plugin-dev-watcher.ts` (MIT): each change restarts a
//! short quiet timer. This version adds a cap so a source that never settles
//! still reloads. No code copied.
use sha2::{Digest, Sha256};
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

/// The default quiet period before a reload.
pub const DEFAULT_DEBOUNCE_MS: u32 = 300;
pub const MIN_DEBOUNCE_MS: u32 = 50;
pub const MAX_DEBOUNCE_MS: u32 = 10_000;
/// The longest a pending change waits while the source keeps changing.
pub const MAX_WAIT_MS: i64 = 10_000;
/// How long a superseded host may finish its open calls before it is
/// deactivated anyway.
pub const DRAIN_GRACE_MS: i64 = 15_000;
/// The most files a watched source may hold, as for an installed artifact.
const MAX_WATCHED_FILES: usize = 20_000;

/// What the watcher does after one scan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tick {
    /// Nothing is pending.
    Idle,
    /// A change is pending; it reloads at `due_at` unless more arrive.
    Waiting { due_at: i64 },
    /// Reload now.
    Fire,
}

/// A trailing debounce with a cap on the total wait.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Debounce {
    first_change: Option<i64>,
    last_change: Option<i64>,
}

impl Debounce {
    /// Records one scan at `now`. A change restarts the quiet period, but a
    /// reload never waits more than `max_wait_ms` after the first change it
    /// covers. Firing clears the pending change.
    pub fn observe(&mut self, changed: bool, now: i64, quiet_ms: i64, max_wait_ms: i64) -> Tick {
        if changed {
            self.first_change.get_or_insert(now);
            self.last_change = Some(now);
        }
        let (Some(first), Some(last)) = (self.first_change, self.last_change) else {
            return Tick::Idle;
        };
        let due_at = (last + quiet_ms).min(first + max_wait_ms);
        if now >= due_at {
            *self = Self::default();
            Tick::Fire
        } else {
            Tick::Waiting { due_at }
        }
    }
}

/// Clamps a requested debounce into the allowed range, or refuses it.
pub fn debounce_ms(requested: Option<u32>) -> Result<u32, String> {
    match requested {
        None => Ok(DEFAULT_DEBOUNCE_MS),
        Some(value) if (MIN_DEBOUNCE_MS..=MAX_DEBOUNCE_MS).contains(&value) => Ok(value),
        Some(_) => Err(format!(
            "debounce_ms must be {MIN_DEBOUNCE_MS} to {MAX_DEBOUNCE_MS}"
        )),
    }
}

/// Whether a copy taken between two scans is one consistent tree. A source
/// that changed while it was copied may be half-written, so the copy is
/// discarded and the change waits for the next quiet period.
pub fn copy_is_consistent(before: &str, after: &str) -> bool {
    before == after
}

/// One step of draining a superseded backend host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrainStep {
    /// Open calls remain and the grace period has time left.
    Wait,
    /// Run the plugin's `deactivate` with its own bound, then stop the host.
    Deactivate { forced: bool },
    /// The host already exited; only the process-group sweep remains.
    Exited,
}

/// Decides the next drain step. Open calls finish first, but never for
/// longer than `grace_ms`; calls still open after that are cut off and
/// settle as unknown, never as done.
pub fn drain_step(
    open_calls: usize,
    exited: bool,
    started: i64,
    now: i64,
    grace_ms: i64,
) -> DrainStep {
    if exited {
        DrainStep::Exited
    } else if open_calls == 0 {
        DrainStep::Deactivate { forced: false }
    } else if now - started >= grace_ms {
        DrainStep::Deactivate { forced: true }
    } else {
        DrainStep::Wait
    }
}

/// What a generation that is not retired yet should be now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Settle {
    Current,
    Draining,
    Leased,
    Retire,
}

/// The current generation stays current. A superseded one is held by
/// provider leases first, since those sessions outlive any host drain, then
/// by a draining host. Only a generation nothing holds retires.
pub fn settle(is_current: bool, draining: bool, provider_leases: u32) -> Settle {
    if is_current {
        Settle::Current
    } else if provider_leases > 0 {
        Settle::Leased
    } else if draining {
        Settle::Draining
    } else {
        Settle::Retire
    }
}

/// Whether a reload may install data schema `incoming`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SchemaChange {
    /// Install, recording this as the highest stored schema.
    Accept(u32),
    Refuse(String),
}

/// The data schema never moves below what is stored: code rollback does not
/// roll data back. It may rise only while no provider session leases the
/// plugin, since those sessions run older code against the same records.
pub fn reload_schema(stored: u32, incoming: u32, provider_leases: u32) -> SchemaChange {
    if incoming < stored {
        SchemaChange::Refuse(format!(
            "Plugin data is at schema {stored}; the source declares {incoming}. Rolling back code does not roll back data"
        ))
    } else if incoming > stored && provider_leases > 0 {
        SchemaChange::Refuse(format!(
            "The source raises the data schema from {stored} to {incoming} while {provider_leases} provider session(s) lease this plugin; end them before reloading"
        ))
    } else {
        SchemaChange::Accept(incoming)
    }
}

/// A digest of the source tree's shape: every entry's relative path, kind,
/// size and modification time, skipping a top-level `.git` as the copy does.
/// It reads metadata only, so a scan stays cheap; the copy computes the real
/// content digest.
pub fn fingerprint(root: &Path) -> Result<String, String> {
    let mut entries = Vec::new();
    let mut pending = vec![(root.to_owned(), String::new())];
    while let Some((dir, prefix)) = pending.pop() {
        let listing = fs::read_dir(&dir)
            .map_err(|error| format!("Could not read {}: {error}", dir.display()))?;
        for entry in listing {
            let entry = entry.map_err(|error| format!("Could not scan the source: {error}"))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if prefix.is_empty() && name == ".git" {
                continue;
            }
            let relative = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            let metadata = fs::symlink_metadata(entry.path())
                .map_err(|error| format!("Could not read {relative}: {error}"))?;
            let kind = if metadata.is_dir() {
                pending.push((entry.path(), relative.clone()));
                'd'
            } else if metadata.is_file() {
                'f'
            } else {
                'o'
            };
            entries.push(format!(
                "{relative}\0{kind}\0{}\0{}.{}",
                metadata.len(),
                metadata.mtime(),
                metadata.mtime_nsec()
            ));
            if entries.len() > MAX_WATCHED_FILES {
                return Err(format!(
                    "The source holds more than {MAX_WATCHED_FILES} entries"
                ));
            }
        }
    }
    entries.sort();
    let mut digest = Sha256::new();
    for entry in &entries {
        digest.update(entry.as_bytes());
        digest.update(b"\n");
    }
    Ok(digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_burst_of_changes_reloads_once_after_it_settles() {
        let mut debounce = Debounce::default();
        assert_eq!(debounce.observe(false, 0, 300, 10_000), Tick::Idle);
        assert_eq!(
            debounce.observe(true, 100, 300, 10_000),
            Tick::Waiting { due_at: 400 }
        );
        assert_eq!(
            debounce.observe(true, 250, 300, 10_000),
            Tick::Waiting { due_at: 550 }
        );
        assert_eq!(
            debounce.observe(false, 500, 300, 10_000),
            Tick::Waiting { due_at: 550 }
        );
        assert_eq!(debounce.observe(false, 550, 300, 10_000), Tick::Fire);
        assert_eq!(debounce.observe(false, 900, 300, 10_000), Tick::Idle);
    }

    #[test]
    fn a_source_that_never_settles_still_reloads_at_the_cap() {
        let mut debounce = Debounce::default();
        let mut fired = Vec::new();
        for now in (0..=2_500).step_by(100) {
            if debounce.observe(true, now, 300, 1_000) == Tick::Fire {
                fired.push(now);
            }
        }
        assert_eq!(fired, vec![1_000, 2_100]);
    }

    #[test]
    fn debounce_requests_are_bounded() {
        assert_eq!(debounce_ms(None), Ok(DEFAULT_DEBOUNCE_MS));
        assert_eq!(debounce_ms(Some(50)), Ok(50));
        assert_eq!(debounce_ms(Some(10_000)), Ok(10_000));
        assert!(debounce_ms(Some(49)).is_err());
        assert!(debounce_ms(Some(10_001)).is_err());
        assert!(copy_is_consistent("a", "a"));
        assert!(!copy_is_consistent("a", "b"));
    }

    #[test]
    fn a_drain_waits_for_open_calls_only_within_its_grace() {
        assert_eq!(
            drain_step(0, false, 0, 0, 1_000),
            DrainStep::Deactivate { forced: false }
        );
        assert_eq!(drain_step(2, false, 0, 999, 1_000), DrainStep::Wait);
        assert_eq!(
            drain_step(2, false, 0, 1_000, 1_000),
            DrainStep::Deactivate { forced: true }
        );
        assert_eq!(drain_step(2, true, 0, 10, 1_000), DrainStep::Exited);
    }

    #[test]
    fn a_leased_generation_outlives_its_host_drain() {
        assert_eq!(settle(true, true, 3), Settle::Current);
        assert_eq!(settle(false, true, 1), Settle::Leased);
        assert_eq!(settle(false, false, 1), Settle::Leased);
        assert_eq!(settle(false, true, 0), Settle::Draining);
        assert_eq!(settle(false, false, 0), Settle::Retire);
    }

    #[test]
    fn a_reload_never_lowers_data_and_raises_it_only_without_leases() {
        assert_eq!(reload_schema(2, 2, 5), SchemaChange::Accept(2));
        assert_eq!(reload_schema(2, 3, 0), SchemaChange::Accept(3));
        assert!(matches!(reload_schema(2, 3, 1), SchemaChange::Refuse(_)));
        assert!(matches!(reload_schema(3, 2, 0), SchemaChange::Refuse(_)));
    }
}
