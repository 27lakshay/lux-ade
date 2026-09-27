//! Diagnostic counters and a lease snapshot for `diagnostics.status`.
//! The counters live in memory, so a daemon restart resets them.
use super::leases::{Holder, LeaseKey};
use super::*;
use ade_core::contract::daemon::DiagnosticUnresolvedClaim;
use std::sync::atomic::AtomicU64;

#[derive(Default)]
pub(super) struct Counters {
    /// Feed subscribers removed because their bounded queue was full.
    feed_evictions: AtomicU64,
    /// Prompt-queue wakes merged into one already pending.
    queue_wakes_coalesced: AtomicU64,
}

/// What `diagnostics.status` reads from the session layer.
pub struct SessionInspection {
    pub feed_subscribers: u64,
    pub feed_evictions: u64,
    pub queue_wakes_coalesced: u64,
    pub session_worktree_leases: u64,
    pub unresolved: Vec<DiagnosticUnresolvedClaim>,
}

/// The capacity of each feed subscriber's queue.
pub const FEED_QUEUE_CAPACITY: u64 = 128;

impl Sessions {
    /// Wakes the prompt queue, counting a wake merged into a pending one.
    pub(super) fn wake_queue(&self) {
        if let Err(mpsc::TrySendError::Full(())) = self.queue_wake.try_send(()) {
            self.counters
                .queue_wakes_coalesced
                .fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Sends a frame to one subscriber. False removes the subscriber; a full
    /// queue counts as an eviction, a closed one does not.
    pub(super) fn deliver(&self, tx: &mpsc::SyncSender<Value>, event: Value) -> bool {
        match tx.try_send(event) {
            Ok(()) => true,
            Err(mpsc::TrySendError::Full(_)) => {
                self.counters.feed_evictions.fetch_add(1, Ordering::Relaxed);
                false
            }
            Err(mpsc::TrySendError::Disconnected(_)) => false,
        }
    }

    pub fn inspection(&self) -> SessionInspection {
        let d = self.data.lock().unwrap();
        let mut unresolved: Vec<_> = d
            .unresolved
            .values()
            .map(|entry| {
                let (kind, subject) = match &entry.claim.key {
                    LeaseKey::Agent(conversation) => ("agent", conversation.clone()),
                    LeaseKey::Service { name, .. } => ("service", name.clone()),
                    LeaseKey::Script { run_id, .. } => ("script", run_id.clone()),
                };
                let incarnation = match &entry.claim.holder {
                    Holder::Terminal { transfer_id, .. } => transfer_id.clone(),
                    Holder::Agent { run, .. } => run.clone(),
                };
                DiagnosticUnresolvedClaim {
                    kind: kind.into(),
                    workspace_id: entry.claim.workspace_id.clone(),
                    subject,
                    incarnation,
                    reason: entry.reason.clone(),
                    holds_worktree: entry.lease.is_some(),
                }
            })
            .collect();
        unresolved
            .sort_by(|a, b| (&a.workspace_id, &a.subject).cmp(&(&b.workspace_id, &b.subject)));
        SessionInspection {
            feed_subscribers: d.subscribers.len() as u64,
            feed_evictions: self.counters.feed_evictions.load(Ordering::Relaxed),
            queue_wakes_coalesced: self.counters.queue_wakes_coalesced.load(Ordering::Relaxed),
            session_worktree_leases: d.terminal_leases.len() as u64,
            unresolved,
        }
    }
}
