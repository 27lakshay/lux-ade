//! What a terminal is doing now: whether a process other than the terminal's
//! own program holds the PTY's foreground, that process's name, and the title
//! the program last set.
//!
//! The terminal host reads the PTY's foreground process group with
//! `tcgetpgrp` on the master. `portable-pty` starts the program in its own
//! session, so the program's PID is its own process group ID. A shell with job
//! control moves each command it runs into a new group and hands that group the
//! terminal, so a foreground group other than the shell's means a command is
//! running (CONTEXT.md, "Busy terminal").
//!
//! Known limits, by design of the signal:
//! - A background job (`sleep 30 &`) is not busy: it does not hold the
//!   foreground, though closing the terminal still ends it.
//! - `exec cmd` replaces the shell in its own group, so it is not busy.
//! - A nested shell, `tmux` or `ssh` is busy for as long as it runs, even at an
//!   idle prompt: the outer shell cannot see inside it.
//! - A shell without job control (`sh -c`, a non-interactive shell) runs
//!   commands in its own group, so they are not busy.

/// Whether `foreground` is a process group other than the program's own.
/// An unknown foreground (the PTY closed, or `tcgetpgrp` failed) is not busy.
pub fn busy(program_group: Option<i32>, foreground: Option<i32>) -> bool {
    matches!((program_group, foreground), (Some(own), Some(group)) if own != group)
}

/// The short command name of a process, such as `sleep` or `zsh`, or `None`
/// when it has exited or cannot be read. A login shell's leading `-` is
/// dropped.
pub fn process_name(pid: i32) -> Option<String> {
    let name = raw_name(pid)?;
    let name = name.trim().trim_start_matches('-');
    (!name.is_empty()).then(|| name.to_owned())
}

#[cfg(target_os = "macos")]
fn raw_name(pid: i32) -> Option<String> {
    let mut buffer = [0u8; 256];
    // SAFETY: the buffer outlives the call and its size is passed with it.
    let length = unsafe { libc::proc_name(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    (length > 0).then(|| String::from_utf8_lossy(&buffer[..length as usize]).into_owned())
}

#[cfg(target_os = "linux")]
fn raw_name(pid: i32) -> Option<String> {
    std::fs::read_to_string(format!("/proc/{pid}/comm")).ok()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn raw_name(_pid: i32) -> Option<String> {
    None
}

/// The longest title kept, in bytes. A longer one is cut at a character
/// boundary.
const TITLE_LIMIT: usize = 256;

#[derive(Default, Clone, Copy, PartialEq, Eq, Debug)]
enum Scan {
    #[default]
    Ground,
    Escape,
    /// Inside `ESC ]`, reading the command number.
    Command(u16),
    /// Inside a title command (OSC 0 or 2), reading the title.
    Title,
    /// Inside another OSC command, skipping to its end.
    Other,
    /// Saw `ESC` inside an OSC string; `\` ends it.
    StringEscape {
        title: bool,
    },
}

/// Follows a terminal's output for the window titles its program sets with
/// `OSC 0` or `OSC 2` (`ESC ] 2 ; title BEL`, or ended by `ESC \`). Output may
/// split a sequence anywhere; the scanner keeps its place between chunks.
#[derive(Default, Debug)]
pub struct TitleScanner {
    scan: Scan,
    pending: Vec<u8>,
    title: Option<String>,
}

impl TitleScanner {
    /// The last complete title, or `None` before any. An empty title set by
    /// the program clears it.
    pub fn title(&self) -> Option<&str> {
        self.title.as_deref()
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.scan = match (self.scan, byte) {
                (Scan::Ground, 0x1b) => Scan::Escape,
                (Scan::Ground, _) => Scan::Ground,
                (Scan::Escape, b']') => Scan::Command(0),
                (Scan::Escape, 0x1b) => Scan::Escape,
                (Scan::Escape, _) => Scan::Ground,
                (Scan::Command(number), b'0'..=b'9') if number < 1000 => {
                    Scan::Command(number * 10 + u16::from(byte - b'0'))
                }
                (Scan::Command(0 | 2), b';') => {
                    self.pending.clear();
                    Scan::Title
                }
                (Scan::Command(_), 0x07) => Scan::Ground,
                (Scan::Command(_), 0x1b) => Scan::StringEscape { title: false },
                (Scan::Command(_), _) => Scan::Other,
                (Scan::Title, 0x07) => {
                    self.finish();
                    Scan::Ground
                }
                (Scan::Title, 0x1b) => Scan::StringEscape { title: true },
                (Scan::Title, _) => {
                    if self.pending.len() < TITLE_LIMIT * 4 {
                        self.pending.push(byte);
                    }
                    Scan::Title
                }
                (Scan::Other, 0x07) => Scan::Ground,
                (Scan::Other, 0x1b) => Scan::StringEscape { title: false },
                (Scan::Other, _) => Scan::Other,
                (Scan::StringEscape { title }, b'\\') => {
                    if title {
                        self.finish();
                    }
                    Scan::Ground
                }
                // Another escape abandons the string; start over from it.
                (Scan::StringEscape { .. }, b']') => Scan::Command(0),
                (Scan::StringEscape { .. }, _) => Scan::Ground,
            };
        }
    }

    fn finish(&mut self) {
        let text = String::from_utf8_lossy(&self.pending);
        let text: String = text.chars().filter(|c| !c.is_control()).collect();
        let text = text.trim();
        let mut end = text.len().min(TITLE_LIMIT);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        let text = &text[..end];
        self.title = (!text.is_empty()).then(|| text.to_owned());
        self.pending.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn busy_only_when_another_group_holds_the_foreground() {
        assert!(!busy(Some(10), Some(10)));
        assert!(busy(Some(10), Some(42)));
        assert!(!busy(Some(10), None));
        assert!(!busy(None, Some(42)));
    }

    #[test]
    fn this_process_has_a_name() {
        let name = process_name(std::process::id() as i32).expect("own name");
        assert!(!name.is_empty() && !name.starts_with('-'));
        assert_eq!(process_name(-1), None);
    }

    fn titles(chunks: &[&[u8]]) -> Option<String> {
        let mut scanner = TitleScanner::default();
        for chunk in chunks {
            scanner.feed(chunk);
        }
        scanner.title().map(str::to_owned)
    }

    #[test]
    fn reads_osc_zero_and_two_ended_by_bell_or_string_terminator() {
        assert_eq!(titles(&[b"\x1b]0;build\x07"]).as_deref(), Some("build"));
        assert_eq!(titles(&[b"\x1b]2;tests\x1b\\"]).as_deref(), Some("tests"));
        assert_eq!(
            titles(&[b"a\x1b]2;one\x07b\x1b]0;two\x07c"]).as_deref(),
            Some("two")
        );
    }

    #[test]
    fn a_sequence_split_across_chunks_is_still_read() {
        assert_eq!(
            titles(&[b"\x1b", b"]", b"2", b";ma", b"in\x1b", b"\\"]).as_deref(),
            Some("main")
        );
    }

    #[test]
    fn other_osc_commands_and_escapes_leave_the_title_alone() {
        assert_eq!(titles(&[b"\x1b]7;file:///tmp\x07"]), None);
        assert_eq!(titles(&[b"\x1b]1;icon\x07\x1b[31mred"]), None);
        assert_eq!(titles(&[b"\x1b]22;x\x07"]), None);
        assert_eq!(
            titles(&[b"\x1b]2;kept\x07\x1b]8;;https://x\x07"]).as_deref(),
            Some("kept")
        );
    }

    #[test]
    fn an_empty_title_clears_and_a_long_one_is_bounded() {
        assert_eq!(titles(&[b"\x1b]2;x\x07\x1b]2;\x07"]), None);
        let long = format!("\x1b]2;{}\x07", "é".repeat(400));
        let title = titles(&[long.as_bytes()]).unwrap();
        assert!(title.len() <= TITLE_LIMIT && title.starts_with('é'));
    }
}
