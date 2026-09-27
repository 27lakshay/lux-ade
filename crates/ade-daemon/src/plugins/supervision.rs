//! Restart supervision for one plugin's backend host (F057).
//!
//! Plain data and pure decisions, so the supervisor in `host.rs` can hold its
//! lock only while it asks a question. Every host process carries a
//! [`HostKey`]: the activation generation it serves and its start attempt
//! within that generation. An exit is counted only when its key matches the
//! running attempt, so a late exit from generation 1, or from an attempt the
//! supervisor already retired, never changes what generation 2 sees.
//!
//! The backoff schedule follows the pattern in Orca
//! `src/main/plugins/plugin-worker-supervision.integration.test.ts` (MIT):
//! restart after 500 ms, 2 s and 5 s, then stay errored until someone asks for
//! a restart. No code copied.

/// Delays before each automatic restart after a crash. One crash more than
/// this list allows leaves the host errored.
pub const RESTART_DELAYS_MS: [i64; 3] = [500, 2_000, 5_000];
/// A host that ran this long before crashing starts a fresh crash count.
pub const STABLE_AFTER_MS: i64 = 60_000;

/// Identifies one host process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HostKey {
    pub generation: u64,
    pub attempt: u64,
}

/// The supervisor's view of one generation's host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Phase {
    /// No host has been started for this generation yet.
    Idle,
    Running {
        key: HostKey,
        started_at: i64,
    },
    /// Crashed; an automatic restart is due at `retry_at`.
    Backoff {
        retry_at: i64,
    },
    /// Crashed more often than the schedule allows.
    Errored,
    /// Stopped on purpose (disable, or a restart in progress).
    Stopped,
}

/// Whether a host may be started now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartDecision {
    Start(HostKey),
    AlreadyRunning(HostKey),
    Wait { retry_at: i64 },
    Errored,
}

/// What an observed exit means.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExitOutcome {
    /// The key is not the running attempt; nothing changed.
    Ignored,
    /// The host was stopped on purpose.
    Stopped,
    /// Restart at `retry_at`; `crashes` counts consecutive crashes.
    Restart {
        retry_at: i64,
        crashes: u32,
    },
    Errored {
        crashes: u32,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Supervision {
    pub generation: u64,
    /// The last attempt number issued; attempts start at 1.
    pub attempt: u64,
    /// Consecutive crashes counted toward the schedule.
    pub crashes: u32,
    pub phase: Phase,
}

impl Supervision {
    pub fn new(generation: u64) -> Self {
        Self {
            generation,
            attempt: 0,
            crashes: 0,
            phase: Phase::Idle,
        }
    }

    /// Decides whether a start is allowed at `now`. Demand after a stop or
    /// before the first start is allowed; demand during backoff waits for the
    /// scheduled restart, and an errored host waits for an explicit reset.
    pub fn decide_start(&self, now: i64) -> StartDecision {
        match self.phase {
            Phase::Running { key, .. } => StartDecision::AlreadyRunning(key),
            Phase::Backoff { retry_at } if now < retry_at => StartDecision::Wait { retry_at },
            Phase::Errored => StartDecision::Errored,
            _ => StartDecision::Start(HostKey {
                generation: self.generation,
                attempt: self.attempt + 1,
            }),
        }
    }

    /// Records that the attempt `decide_start` returned is now running.
    /// Returns false, changing nothing, for any other key.
    pub fn started(&mut self, key: HostKey, now: i64) -> bool {
        if key.generation != self.generation || key.attempt != self.attempt + 1 {
            return false;
        }
        self.attempt = key.attempt;
        self.phase = Phase::Running {
            key,
            started_at: now,
        };
        true
    }

    /// Records an exit. `intentional` is true when the supervisor itself
    /// stopped the host. Only the running attempt's exit counts.
    pub fn exited(&mut self, key: HostKey, now: i64, intentional: bool) -> ExitOutcome {
        let Phase::Running {
            key: running,
            started_at,
        } = self.phase
        else {
            return ExitOutcome::Ignored;
        };
        if running != key {
            return ExitOutcome::Ignored;
        }
        if intentional {
            self.phase = Phase::Stopped;
            return ExitOutcome::Stopped;
        }
        if now - started_at >= STABLE_AFTER_MS {
            self.crashes = 0;
        }
        self.crashes += 1;
        match RESTART_DELAYS_MS.get(self.crashes as usize - 1) {
            Some(delay) => {
                let retry_at = now + delay;
                self.phase = Phase::Backoff { retry_at };
                ExitOutcome::Restart {
                    retry_at,
                    crashes: self.crashes,
                }
            }
            None => {
                self.phase = Phase::Errored;
                ExitOutcome::Errored {
                    crashes: self.crashes,
                }
            }
        }
    }

    /// Whether a scheduled restart for `retry_at` is still the one wanted.
    /// A reset, stop, newer crash or explicit start in between cancels it.
    pub fn restart_due(&self, retry_at: i64, now: i64) -> bool {
        self.phase == Phase::Backoff { retry_at } && now >= retry_at
    }

    /// An explicit restart request: forget the crash count and leave backoff
    /// or the errored state. The running attempt, if any, is left for the
    /// caller to stop.
    pub fn reset(&mut self) {
        self.crashes = 0;
        if matches!(self.phase, Phase::Backoff { .. } | Phase::Errored) {
            self.phase = Phase::Stopped;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(generation: u64, attempt: u64) -> HostKey {
        HostKey {
            generation,
            attempt,
        }
    }

    fn start(supervision: &mut Supervision, now: i64) -> HostKey {
        let StartDecision::Start(key) = supervision.decide_start(now) else {
            panic!(
                "expected a start at {now}, got {:?}",
                supervision.decide_start(now)
            );
        };
        assert!(supervision.started(key, now));
        key
    }

    #[test]
    fn crashes_back_off_on_schedule_then_stay_errored() {
        let mut s = Supervision::new(4);
        let mut now = 0;
        for (index, delay) in RESTART_DELAYS_MS.iter().enumerate() {
            let running = start(&mut s, now);
            assert_eq!(running, key(4, index as u64 + 1));
            now += 10;
            assert_eq!(
                s.exited(running, now, false),
                ExitOutcome::Restart {
                    retry_at: now + delay,
                    crashes: index as u32 + 1
                }
            );
            assert_eq!(
                s.decide_start(now + delay - 1),
                StartDecision::Wait {
                    retry_at: now + delay
                }
            );
            assert!(!s.restart_due(now + delay, now + delay - 1));
            now += delay;
            assert!(s.restart_due(now, now));
        }
        let last = start(&mut s, now);
        assert_eq!(
            s.exited(last, now + 1, false),
            ExitOutcome::Errored { crashes: 4 }
        );
        assert_eq!(s.decide_start(now + 1_000_000), StartDecision::Errored);
        s.reset();
        assert_eq!(s.decide_start(now + 2), StartDecision::Start(key(4, 5)));
    }

    #[test]
    fn a_stable_run_starts_a_fresh_crash_count() {
        let mut s = Supervision::new(1);
        let first = start(&mut s, 0);
        s.exited(first, 5, false);
        let second = start(&mut s, 1_000);
        assert_eq!(
            s.exited(second, 1_000 + STABLE_AFTER_MS, false),
            ExitOutcome::Restart {
                retry_at: 1_000 + STABLE_AFTER_MS + RESTART_DELAYS_MS[0],
                crashes: 1
            }
        );
    }

    #[test]
    fn late_exits_from_retired_attempts_and_generations_are_ignored() {
        let mut old = Supervision::new(1);
        let v1 = start(&mut old, 0);
        // The plugin is re-enabled: generation 2 gets its own supervision.
        let mut s = Supervision::new(2);
        let v2 = start(&mut s, 10);
        assert_eq!(s.exited(v1, 20, false), ExitOutcome::Ignored);
        assert_eq!(
            s.phase,
            Phase::Running {
                key: v2,
                started_at: 10
            }
        );
        // Within one generation, a retired attempt's exit is ignored too.
        s.exited(v2, 30, true);
        let v2b = start(&mut s, 40);
        assert_eq!(v2b, key(2, 2));
        assert_eq!(s.exited(v2, 50, false), ExitOutcome::Ignored);
        assert_eq!(s.crashes, 0);
        assert_eq!(s.decide_start(60), StartDecision::AlreadyRunning(v2b));
    }

    #[test]
    fn an_intentional_stop_is_not_a_crash_and_allows_a_restart_on_demand() {
        let mut s = Supervision::new(3);
        let running = start(&mut s, 0);
        assert_eq!(s.exited(running, 1, true), ExitOutcome::Stopped);
        assert_eq!(s.crashes, 0);
        assert_eq!(s.decide_start(2), StartDecision::Start(key(3, 2)));
        // A duplicate exit report for the stopped attempt changes nothing.
        assert_eq!(s.exited(running, 3, false), ExitOutcome::Ignored);
    }

    #[test]
    fn only_the_decided_attempt_can_start() {
        let mut s = Supervision::new(2);
        assert!(!s.started(key(1, 1), 0));
        assert!(!s.started(key(2, 2), 0));
        assert!(s.started(key(2, 1), 0));
        assert!(!s.started(key(2, 1), 0));
    }

    #[test]
    fn a_reset_cancels_a_scheduled_restart() {
        let mut s = Supervision::new(1);
        let running = start(&mut s, 0);
        let ExitOutcome::Restart { retry_at, .. } = s.exited(running, 1, false) else {
            panic!("expected a restart");
        };
        s.reset();
        assert!(!s.restart_due(retry_at, retry_at));
        assert_eq!(s.decide_start(2), StartDecision::Start(key(1, 2)));
    }
}
