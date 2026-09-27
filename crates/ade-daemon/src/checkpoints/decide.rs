//! Pure checkpoint logic: the restore-safety decision, the commit-message
//! codec, and parsers for the Git plumbing output the checkpoint module reads.
use ade_core::contract::checkpoints::{
    CheckpointArea, CheckpointChangeKind, CheckpointCoverage, CheckpointKind, CheckpointPathChange,
    CheckpointRestoreVerdict,
};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

/// The ref namespace every checkpoint lives under.
pub const REF_ROOT: &str = "refs/ade/checkpoints";

/// What a checkpoint never covers, reported with every checkpoint.
pub const NOT_COVERED: &[&str] = &[
    "ignored files",
    "empty directories",
    "submodule and nested repository contents",
    "file ownership, timestamps and permissions other than the executable bit",
    "running processes, terminals and services",
    "the branch, stash and other refs",
];

/// Everything the restore decision needs, gathered by the caller.
pub struct RestoreFacts<'a> {
    /// Conditions that make any restore unsafe, such as a merge in progress.
    pub blockers: &'a [String],
    /// The token from the preview; `None` while previewing.
    pub expected_state: Option<&'a str>,
    pub current_state: &'a str,
    pub changes: &'a [CheckpointPathChange],
    pub uncommitted_overwritten: &'a [String],
    pub ignored_overwritten: &'a [String],
    pub confirm_overwrite: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Nothing to write.
    Unchanged,
    /// Safe to write after saving a safety checkpoint.
    Proceed,
    /// Would replace uncommitted work; the caller must confirm.
    NeedsConfirmation,
    Blocked(Vec<String>),
}

impl Decision {
    pub fn verdict(&self) -> CheckpointRestoreVerdict {
        match self {
            Self::Unchanged => CheckpointRestoreVerdict::Unchanged,
            Self::Proceed => CheckpointRestoreVerdict::Ready,
            Self::NeedsConfirmation => CheckpointRestoreVerdict::NeedsConfirmation,
            Self::Blocked(_) => CheckpointRestoreVerdict::Blocked,
        }
    }
}

/// Decides whether a restore may run. Blockers and a stale preview refuse
/// before anything else; ignored files in the way always refuse, because no
/// checkpoint can save them; uncommitted work needs explicit confirmation.
pub fn decide(facts: &RestoreFacts) -> Decision {
    let mut reasons: Vec<String> = facts.blockers.to_vec();
    if let Some(expected) = facts.expected_state
        && expected != facts.current_state
    {
        reasons.push(
            "The workspace or the checkpoint changed since the preview; preview the restore again"
                .into(),
        );
    }
    if !facts.ignored_overwritten.is_empty() {
        reasons.push(format!(
            "Restore would overwrite {} ignored or excluded path(s) that no checkpoint covers: {}",
            facts.ignored_overwritten.len(),
            sample(facts.ignored_overwritten)
        ));
    }
    if !reasons.is_empty() {
        return Decision::Blocked(reasons);
    }
    if facts.changes.is_empty() {
        return Decision::Unchanged;
    }
    if !facts.uncommitted_overwritten.is_empty() && !facts.confirm_overwrite {
        return Decision::NeedsConfirmation;
    }
    Decision::Proceed
}

fn sample(paths: &[String]) -> String {
    let shown: Vec<&str> = paths.iter().take(5).map(String::as_str).collect();
    let more = paths.len().saturating_sub(shown.len());
    if more == 0 {
        shown.join(", ")
    } else {
        format!("{} and {more} more", shown.join(", "))
    }
}

/// The paths a restore changes whose current content is not committed.
pub fn uncommitted_overwritten(
    changes: &[CheckpointPathChange],
    dirty: &BTreeSet<String>,
) -> Vec<String> {
    changes
        .iter()
        .filter(|change| dirty.contains(&change.path))
        .map(|change| change.path.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// An opaque token over everything a restore's safety depends on.
pub fn state_token(
    head: Option<&str>,
    index_tree: &str,
    worktree_tree: &str,
    checkpoint: &str,
) -> String {
    let joined = format!(
        "v1\0{}\0{index_tree}\0{worktree_tree}\0{checkpoint}",
        head.unwrap_or("")
    );
    Sha256::digest(joined.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// A workspace or checkpoint ID that is safe as one ref path component.
pub fn valid_component(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && !value.starts_with(['-', '.'])
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

pub fn ref_name(workspace_id: &str, checkpoint_id: &str) -> Result<String> {
    ensure!(valid_component(workspace_id), "Invalid workspace_id");
    ensure!(valid_component(checkpoint_id), "Invalid checkpoint_id");
    Ok(format!("{REF_ROOT}/{workspace_id}/{checkpoint_id}"))
}

pub fn valid_label(label: &str) -> bool {
    !label.trim().is_empty() && label.chars().count() <= 200 && !label.chars().any(char::is_control)
}

/// The metadata carried in a checkpoint commit's message.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Metadata {
    pub checkpoint_id: String,
    pub workspace_id: String,
    pub kind: CheckpointKind,
    pub label: Option<String>,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub created_at: i64,
    pub coverage: CheckpointCoverage,
}

const TRAILER: &str = "ade-checkpoint-v1: ";

pub fn encode_message(metadata: &Metadata) -> Result<String> {
    Ok(format!(
        "ADE checkpoint {}\n\n{TRAILER}{}\n",
        metadata.checkpoint_id,
        serde_json::to_string(metadata)?
    ))
}

pub fn decode_message(message: &str) -> Result<Metadata> {
    let line = message
        .lines()
        .find_map(|line| line.strip_prefix(TRAILER))
        .context("Commit is not an ADE checkpoint")?;
    serde_json::from_str(line).context("Checkpoint metadata is invalid")
}

/// A raw commit object from `git cat-file commit`.
#[derive(Debug, PartialEq, Eq)]
pub struct RawCommit {
    pub tree: String,
    pub parents: Vec<String>,
    pub message: String,
}

pub fn parse_commit(raw: &str) -> Result<RawCommit> {
    let (headers, message) = raw
        .split_once("\n\n")
        .context("Commit object has no message")?;
    let mut tree = None;
    let mut parents = Vec::new();
    for line in headers.lines() {
        if let Some(value) = line.strip_prefix("tree ") {
            tree = Some(value.to_owned());
        } else if let Some(value) = line.strip_prefix("parent ") {
            parents.push(value.to_owned());
        }
    }
    Ok(RawCommit {
        tree: tree.context("Commit object has no tree")?,
        parents,
        message: message.to_owned(),
    })
}

/// Parses `git diff-tree -r -z --no-renames --name-status OLD NEW`.
pub fn parse_name_status(output: &str, area: CheckpointArea) -> Result<Vec<CheckpointPathChange>> {
    let mut fields = output.split('\0').filter(|field| !field.is_empty());
    let mut changes = Vec::new();
    while let Some(status) = fields.next() {
        let path = fields.next().context("Git diff output is truncated")?;
        let kind = match status {
            "A" => CheckpointChangeKind::Added,
            "M" => CheckpointChangeKind::Modified,
            "D" => CheckpointChangeKind::Deleted,
            "T" => CheckpointChangeKind::TypeChanged,
            other => bail!("Unexpected Git diff status {other}"),
        };
        changes.push(CheckpointPathChange {
            path: path.to_owned(),
            area,
            kind,
        });
    }
    Ok(changes)
}

/// Splits NUL-terminated Git path output.
pub fn nul_paths(output: &str) -> Vec<String> {
    output
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Counts entries by mode from `git ls-tree -r -z --format=%(objectmode) TREE`.
pub fn count_modes(output: &str) -> Result<(u64, u64, u64)> {
    let (mut files, mut symlinks, mut submodules) = (0, 0, 0);
    for mode in output.split('\0').filter(|mode| !mode.is_empty()) {
        match mode {
            "100644" | "100755" => files += 1,
            "120000" => {
                files += 1;
                symlinks += 1;
            }
            "160000" => submodules += 1,
            other => bail!("Unexpected Git tree mode {other}"),
        }
    }
    Ok((files, symlinks, submodules))
}

/// Whether `git ls-files -v -z` shows an assume-unchanged (lowercase tag) or
/// skip-worktree (`S`) entry. Either hides changes from a snapshot.
pub fn has_hidden_entries(output: &str) -> bool {
    output
        .split('\0')
        .filter_map(|record| record.bytes().next())
        .any(|tag| tag.is_ascii_lowercase() || tag == b'S')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(path: &str, kind: CheckpointChangeKind) -> CheckpointPathChange {
        CheckpointPathChange {
            path: path.into(),
            area: CheckpointArea::Worktree,
            kind,
        }
    }

    fn facts<'a>(
        changes: &'a [CheckpointPathChange],
        uncommitted: &'a [String],
        ignored: &'a [String],
    ) -> RestoreFacts<'a> {
        RestoreFacts {
            blockers: &[],
            expected_state: Some("s1"),
            current_state: "s1",
            changes,
            uncommitted_overwritten: uncommitted,
            ignored_overwritten: ignored,
            confirm_overwrite: false,
        }
    }

    #[test]
    fn clean_restore_proceeds_and_empty_restore_is_unchanged() {
        let changes = [change("a", CheckpointChangeKind::Modified)];
        assert_eq!(decide(&facts(&changes, &[], &[])), Decision::Proceed);
        assert_eq!(decide(&facts(&[], &[], &[])), Decision::Unchanged);
    }

    #[test]
    fn uncommitted_work_needs_confirmation() {
        let changes = [change("a", CheckpointChangeKind::Modified)];
        let dirty = ["a".to_owned()];
        let mut f = facts(&changes, &dirty, &[]);
        assert_eq!(decide(&f), Decision::NeedsConfirmation);
        assert_eq!(
            f.verdict_for_test(),
            CheckpointRestoreVerdict::NeedsConfirmation
        );
        f.confirm_overwrite = true;
        assert_eq!(decide(&f), Decision::Proceed);
    }

    #[test]
    fn stale_preview_refuses_even_with_confirmation() {
        let changes = [change("a", CheckpointChangeKind::Modified)];
        let mut f = facts(&changes, &[], &[]);
        f.expected_state = Some("old");
        f.confirm_overwrite = true;
        let Decision::Blocked(reasons) = decide(&f) else {
            panic!("stale preview must block")
        };
        assert!(reasons[0].contains("changed since the preview"));
        // A stale preview blocks even when nothing would change now.
        let mut f = facts(&[], &[], &[]);
        f.expected_state = Some("old");
        assert!(matches!(decide(&f), Decision::Blocked(_)));
    }

    #[test]
    fn ignored_files_in_the_way_always_refuse() {
        let changes = [change("build/out", CheckpointChangeKind::Added)];
        let ignored = ["build/out".to_owned()];
        let mut f = facts(&changes, &[], &ignored);
        f.confirm_overwrite = true;
        let Decision::Blocked(reasons) = decide(&f) else {
            panic!("ignored overwrite must block")
        };
        assert!(reasons[0].contains("build/out"));
    }

    #[test]
    fn blockers_refuse_and_are_reported_together() {
        let blockers = ["A merge is in progress".to_owned()];
        let ignored = ["x".to_owned()];
        let mut f = facts(&[], &[], &ignored);
        f.blockers = &blockers;
        f.expected_state = Some("old");
        let Decision::Blocked(reasons) = decide(&f) else {
            panic!("blockers must block")
        };
        assert_eq!(reasons.len(), 3);
        assert_eq!(reasons[0], "A merge is in progress");
    }

    #[test]
    fn preview_without_token_does_not_compare_state() {
        let changes = [change("a", CheckpointChangeKind::Deleted)];
        let mut f = facts(&changes, &[], &[]);
        f.expected_state = None;
        f.current_state = "anything";
        assert_eq!(decide(&f), Decision::Proceed);
    }

    #[test]
    fn uncommitted_overwritten_intersects_and_deduplicates() {
        let changes = [
            change("b", CheckpointChangeKind::Modified),
            CheckpointPathChange {
                path: "b".into(),
                area: CheckpointArea::Index,
                kind: CheckpointChangeKind::Modified,
            },
            change("a", CheckpointChangeKind::Added),
            change("c", CheckpointChangeKind::Deleted),
        ];
        let dirty: BTreeSet<String> = ["b", "c", "z"].map(String::from).into();
        assert_eq!(uncommitted_overwritten(&changes, &dirty), ["b", "c"]);
    }

    #[test]
    fn sample_truncates_long_lists() {
        let paths: Vec<String> = (0..7).map(|i| format!("p{i}")).collect();
        assert_eq!(sample(&paths), "p0, p1, p2, p3, p4 and 2 more");
    }

    #[test]
    fn state_token_depends_on_every_input() {
        let base = state_token(Some("h"), "i", "w", "c");
        assert_eq!(base, state_token(Some("h"), "i", "w", "c"));
        assert_eq!(base.len(), 64);
        for other in [
            state_token(None, "i", "w", "c"),
            state_token(Some("h"), "j", "w", "c"),
            state_token(Some("h"), "i", "x", "c"),
            state_token(Some("h"), "i", "w", "d"),
        ] {
            assert_ne!(base, other);
        }
    }

    #[test]
    fn ref_components_reject_unsafe_names() {
        assert_eq!(
            ref_name("workspace_1", "checkpoint_a-b").unwrap(),
            "refs/ade/checkpoints/workspace_1/checkpoint_a-b"
        );
        for bad in [
            "",
            "-x",
            ".x",
            "a/b",
            "a..b",
            "a b",
            "a.lock",
            &"x".repeat(129),
        ] {
            assert!(!valid_component(bad), "{bad}");
        }
    }

    #[test]
    fn labels_are_single_line_and_bounded() {
        assert!(valid_label("before refactor"));
        assert!(!valid_label("  "));
        assert!(!valid_label("a\nb"));
        assert!(!valid_label(&"x".repeat(201)));
    }

    #[test]
    fn message_round_trips_metadata() {
        let metadata = Metadata {
            checkpoint_id: "checkpoint_1".into(),
            workspace_id: "workspace_1".into(),
            kind: CheckpointKind::Safety,
            label: Some("quote \" and colon: x".into()),
            head: None,
            branch: Some("main".into()),
            created_at: 42,
            coverage: CheckpointCoverage {
                files: 2,
                untracked_files: 1,
                symlinks: 0,
                submodules: 1,
                ignored_entries: 3,
                not_covered: vec!["ignored files".into()],
            },
        };
        let message = encode_message(&metadata).unwrap();
        assert!(message.starts_with("ADE checkpoint checkpoint_1\n\n"));
        assert_eq!(decode_message(&message).unwrap(), metadata);
        assert!(decode_message("ordinary commit\n").is_err());
        assert!(decode_message("x\n\nade-checkpoint-v1: {broken\n").is_err());
    }

    #[test]
    fn commit_objects_parse_tree_parents_and_message() {
        let raw = "tree t1\nparent p1\nparent p2\nauthor ADE <a> 1 +0000\ncommitter ADE <a> 1 +0000\n\nADE checkpoint x\n\nbody\n";
        let commit = parse_commit(raw).unwrap();
        assert_eq!(commit.tree, "t1");
        assert_eq!(commit.parents, ["p1", "p2"]);
        assert_eq!(commit.message, "ADE checkpoint x\n\nbody\n");
        assert!(parse_commit("tree t1\n").is_err());
        assert!(parse_commit("parent p\n\nmsg").is_err());
    }

    #[test]
    fn name_status_parses_all_kinds_and_rejects_others() {
        let changes = parse_name_status(
            "A\0new file\0M\0dir/m\0D\0gone\0T\0link\0",
            CheckpointArea::Index,
        )
        .unwrap();
        assert_eq!(changes.len(), 4);
        assert_eq!(changes[0].path, "new file");
        assert_eq!(changes[0].kind, CheckpointChangeKind::Added);
        assert_eq!(changes[3].kind, CheckpointChangeKind::TypeChanged);
        assert!(changes.iter().all(|c| c.area == CheckpointArea::Index));
        assert!(
            parse_name_status("", CheckpointArea::Worktree)
                .unwrap()
                .is_empty()
        );
        assert!(parse_name_status("U\0x\0", CheckpointArea::Worktree).is_err());
        assert!(parse_name_status("M\0", CheckpointArea::Worktree).is_err());
    }

    #[test]
    fn modes_are_counted_and_unknown_modes_fail() {
        assert_eq!(
            count_modes("100644\x00100755\x00120000\x00160000\x00").unwrap(),
            (3, 1, 1)
        );
        assert!(count_modes("040000\0").is_err());
    }

    #[test]
    fn hidden_index_entries_are_detected() {
        assert!(!has_hidden_entries("H a\0H b\0? c\0"));
        assert!(has_hidden_entries("H a\0h b\0"));
        assert!(has_hidden_entries("S sparse\0"));
        assert!(!has_hidden_entries(""));
    }

    impl RestoreFacts<'_> {
        fn verdict_for_test(&self) -> CheckpointRestoreVerdict {
            decide(self).verdict()
        }
    }
}
