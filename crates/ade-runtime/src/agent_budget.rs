//! Pure capacity decisions for an Agent run's replay journal and command receipts.
//!
//! Two rules from the architecture (sections 4 and 6) live here:
//! - Output overflow is an output failure, never an execution exit. Exit is
//!   journaled only when it was observed or a shutdown was confirmed.
//! - Control commands (cancel, reject) have reserved receipt capacity, so
//!   saturated ordinary receipts never block stopping work.

/// Bytes of unacknowledged events a run retains while the daemon is away.
pub const JOURNAL_LIMIT: usize = 32 * 1024 * 1024;
/// How recently the daemon must have read a run's events to count as attached.
/// The daemon long-polls for at most a second between batches, so a longer
/// silence means it is away or stuck.
pub const CONSUMER_WINDOW: std::time::Duration = std::time::Duration::from_secs(5);
/// Bytes of ordinary command receipts a run retains.
pub const RECEIPT_LIMIT: usize = 32 * 1024 * 1024;
/// Receipts ordinary commands may hold.
pub const RECEIPT_COUNT: usize = 4096;
/// Extra receipts only control commands may use.
pub const CONTROL_RECEIPT_COUNT: usize = 256;
/// Extra receipt bytes only control commands may use.
pub const CONTROL_RECEIPT_BYTES: usize = 1024 * 1024;
/// The accounted size of a journal marker (output failure or exit).
pub const MARKER_BYTES: usize = 256;

/// What the journal does with one event.
#[derive(Debug, PartialEq, Eq)]
pub enum Journaling {
    /// Retain the event for replay.
    Accept,
    /// Output can no longer be recovered losslessly. Record one output-failure
    /// marker in reserved space and enter the degraded state. The run is not
    /// exited.
    Overflow,
    /// The journal is already degraded. Discard this ordinary event.
    Discard,
    /// The journal already recorded an exit. Nothing follows it.
    Closed,
}

/// Decide how to journal one event.
///
/// `exit` is true only for an exit the runtime observed or confirmed. An exit
/// always fits: it is written in reserved space, even when the journal is
/// degraded, because it is the fact the owner needs to release the run.
pub fn journal(
    retained: usize,
    event: usize,
    frame: usize,
    degraded: bool,
    closed: bool,
    exit: bool,
) -> Journaling {
    if closed {
        Journaling::Closed
    } else if exit {
        Journaling::Accept
    } else if degraded {
        Journaling::Discard
    } else if event >= frame || retained.saturating_add(event) > JOURNAL_LIMIT {
        Journaling::Overflow
    } else {
        Journaling::Accept
    }
}

/// Whether a full journal holds the provider back instead of overflowing.
///
/// While the daemon is attached and draining, a burst that fills the journal
/// is waited out: backpressure reaches the provider pipe, and nothing is lost.
/// Overflow is only for output the daemon cannot take, because it has been
/// away for `CONSUMER_WINDOW` (`since_read` is `None` when it never read), or
/// because one event is larger than a frame can ever carry.
pub fn backpressure(event: usize, frame: usize, since_read: Option<std::time::Duration>) -> bool {
    event < frame && since_read.is_some_and(|elapsed| elapsed < CONSUMER_WINDOW)
}

/// Whether a command stops or settles existing work, or starts new work.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandClass {
    /// Starts or advances work: open, send, answer.
    Normal,
    /// Stops or settles existing work: cancel a turn, reject a request.
    Control,
}

pub fn classify(method: &str) -> CommandClass {
    match method {
        "cancel" | "reject" => CommandClass::Control,
        _ => CommandClass::Normal,
    }
}

/// Whether a new receipt of `bytes` may be admitted beside `count` receipts
/// holding `used` bytes.
pub fn admit_receipt(class: CommandClass, count: usize, used: usize, bytes: usize) -> bool {
    let (count_limit, byte_limit) = limits(class);
    count < count_limit && used.saturating_add(bytes) <= byte_limit
}

/// Whether a command's result of `bytes` may be stored beside `used` bytes.
pub fn store_result(class: CommandClass, used: usize, bytes: usize, frame: usize) -> bool {
    bytes < frame && used.saturating_add(bytes) <= limits(class).1
}

fn limits(class: CommandClass) -> (usize, usize) {
    match class {
        CommandClass::Normal => (RECEIPT_COUNT, RECEIPT_LIMIT),
        CommandClass::Control => (
            RECEIPT_COUNT + CONTROL_RECEIPT_COUNT,
            RECEIPT_LIMIT + CONTROL_RECEIPT_BYTES,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const FRAME: usize = 1024;

    #[test]
    fn overflow_degrades_output_and_never_substitutes_an_exit() {
        assert_eq!(
            journal(0, 10, FRAME, false, false, false),
            Journaling::Accept
        );
        assert_eq!(
            journal(JOURNAL_LIMIT - 5, 10, FRAME, false, false, false),
            Journaling::Overflow
        );
        assert_eq!(
            journal(0, FRAME, FRAME, false, false, false),
            Journaling::Overflow
        );
        // Once degraded, ordinary output is discarded; the run stays open.
        assert_eq!(
            journal(0, 10, FRAME, true, false, false),
            Journaling::Discard
        );
    }

    #[test]
    fn observed_exit_is_journaled_even_when_full_or_degraded() {
        assert_eq!(
            journal(JOURNAL_LIMIT, MARKER_BYTES, FRAME, false, false, true),
            Journaling::Accept
        );
        assert_eq!(
            journal(
                JOURNAL_LIMIT + MARKER_BYTES,
                MARKER_BYTES,
                FRAME,
                true,
                false,
                true
            ),
            Journaling::Accept
        );
        assert_eq!(journal(0, 10, FRAME, false, true, true), Journaling::Closed);
        assert_eq!(journal(0, 10, FRAME, true, true, false), Journaling::Closed);
    }

    #[test]
    fn a_full_journal_waits_for_an_attached_daemon_and_overflows_without_one() {
        use std::time::Duration;
        // The daemon read events a moment ago: hold the provider back.
        assert!(backpressure(10, FRAME, Some(Duration::from_millis(200))));
        // The daemon has been silent past the window, or never read: overflow.
        assert!(!backpressure(10, FRAME, Some(CONSUMER_WINDOW)));
        assert!(!backpressure(10, FRAME, None));
        // An event no frame can carry never fits, however long it waits.
        assert!(!backpressure(FRAME, FRAME, Some(Duration::ZERO)));
    }

    #[test]
    fn control_commands_keep_capacity_when_ordinary_receipts_are_saturated() {
        assert_eq!(classify("cancel"), CommandClass::Control);
        assert_eq!(classify("reject"), CommandClass::Control);
        for method in ["open", "send", "answer"] {
            assert_eq!(classify(method), CommandClass::Normal);
        }
        // Count saturation.
        assert!(!admit_receipt(CommandClass::Normal, RECEIPT_COUNT, 0, 1));
        assert!(admit_receipt(CommandClass::Control, RECEIPT_COUNT, 0, 1));
        assert!(!admit_receipt(
            CommandClass::Control,
            RECEIPT_COUNT + CONTROL_RECEIPT_COUNT,
            0,
            1
        ));
        // Byte saturation.
        assert!(!admit_receipt(CommandClass::Normal, 0, RECEIPT_LIMIT, 1));
        assert!(admit_receipt(CommandClass::Control, 0, RECEIPT_LIMIT, 1));
        assert!(!admit_receipt(
            CommandClass::Control,
            0,
            RECEIPT_LIMIT + CONTROL_RECEIPT_BYTES,
            1
        ));
        assert!(!admit_receipt(CommandClass::Normal, 0, usize::MAX, 1));
    }

    #[test]
    fn control_results_are_stored_in_the_reserve() {
        assert!(!store_result(
            CommandClass::Normal,
            RECEIPT_LIMIT,
            16,
            FRAME
        ));
        assert!(store_result(
            CommandClass::Control,
            RECEIPT_LIMIT,
            16,
            FRAME
        ));
        assert!(!store_result(CommandClass::Control, 0, FRAME, FRAME));
    }
}
