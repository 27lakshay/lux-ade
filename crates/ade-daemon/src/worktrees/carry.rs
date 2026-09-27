//! Pure carry decisions: reading Git status, selecting the changes to carry,
//! verifying the target and deciding whether the source may be cleaned.
//! Nothing here touches Git, the filesystem or the database.
use ade_core::contract::resources::ClaimMode;
use ade_core::contract::worktrees::{
    CarryBlocker, CarryChange, CarryKeepReason, CarrySourceOutcome, WorktreeCarryEntry,
    WorktreeOperationStatus, WorktreePhase,
};
use anyhow::{Result, bail, ensure};
use sha2::{Digest, Sha256};

/// A carry refuses more changed paths than this.
pub const MAX_CHANGES: usize = 10_000;
/// A request names at most this many paths.
pub const MAX_REQUESTED: usize = 1_000;

/// One record of `git status --porcelain=v2 -z --untracked-files=all
/// --no-renames`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatusEntry {
    pub path: String,
    pub change: CarryChange,
    pub staged: bool,
    pub unstaged: bool,
    pub submodule: bool,
}

/// Parses porcelain v2 status with NUL terminators. Header (`#`) and ignored
/// (`!`) records are skipped. A rename record is refused: the caller asks for
/// `--no-renames`, so one means the output is not what was asked for.
pub fn parse_status(text: &str) -> Result<Vec<StatusEntry>> {
    let mut entries = Vec::new();
    for record in text.split('\0').filter(|record| !record.is_empty()) {
        let (kind, rest) = record.split_at(1);
        match kind {
            "#" | "!" => continue,
            "?" => {
                let path = rest.strip_prefix(' ').unwrap_or_default();
                ensure!(!path.is_empty(), "Invalid Git status record");
                entries.push(StatusEntry {
                    path: path.into(),
                    change: CarryChange::Untracked,
                    staged: false,
                    unstaged: true,
                    submodule: false,
                });
            }
            "1" | "u" => {
                // `1 XY sub mH mI mW hH hI path`; `u XY sub m1 m2 m3 mW h1 h2 h3 path`.
                let fields = if kind == "1" { 8 } else { 10 };
                let parts: Vec<&str> = record.splitn(fields + 1, ' ').collect();
                ensure!(parts.len() == fields + 1, "Invalid Git status record");
                let xy = parts[1].as_bytes();
                ensure!(xy.len() == 2, "Invalid Git status record");
                let (x, y) = (xy[0], xy[1]);
                let path = parts[fields];
                ensure!(!path.is_empty(), "Invalid Git status record");
                // Staged as added, then deleted from the working tree: no
                // net change from `HEAD`, and nothing to carry or clean.
                if kind == "1" && x == b'A' && y == b'D' {
                    continue;
                }
                entries.push(StatusEntry {
                    path: path.into(),
                    change: if kind == "u" {
                        CarryChange::Unmerged
                    } else {
                        change_of(x, y)
                    },
                    staged: kind == "u" || x != b'.',
                    unstaged: kind == "u" || y != b'.',
                    submodule: parts[2].starts_with('S'),
                });
            }
            "2" => bail!("Git status reported a rename despite --no-renames"),
            _ => bail!("Invalid Git status record"),
        }
    }
    Ok(entries)
}

/// The change a tracked record describes, from `HEAD` to the working tree.
fn change_of(x: u8, y: u8) -> CarryChange {
    if x == b'T' || y == b'T' {
        CarryChange::TypeChanged
    } else if x == b'D' || y == b'D' {
        CarryChange::Deleted
    } else if x == b'A' || y == b'A' {
        CarryChange::Added
    } else {
        CarryChange::Modified
    }
}

/// A path relative to a tree root that cannot escape it or reach Git's
/// administrative files.
pub fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.contains('\0')
        && !path.starts_with('/')
        && path.split('/').all(|part| {
            !part.is_empty() && part != "." && part != ".." && !part.eq_ignore_ascii_case(".git")
        })
}

/// What the request selects, with every reason it cannot run.
#[derive(Debug, PartialEq, Eq)]
pub struct Selection {
    pub entries: Vec<WorktreeCarryEntry>,
    pub blockers: Vec<CarryBlocker>,
    /// Exact paths handed to Git, in status order.
    pub paths: Vec<String>,
}

fn covers(requested: &str, path: &str) -> bool {
    path == requested
        || path
            .strip_prefix(requested)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// Selects the changes a request names: every change when `requested` is
/// `None`, otherwise each path and everything beneath it. A requested path
/// with no change is a blocker, never silently dropped.
pub fn select(
    status: &[StatusEntry],
    requested: Option<&[String]>,
    head: Option<&str>,
    expect_head: Option<&str>,
) -> Selection {
    let mut blockers = Vec::new();
    let mut add = |blocker| {
        if !blockers.contains(&blocker) {
            blockers.push(blocker);
        }
    };
    if head.is_none() {
        add(CarryBlocker::UnbornHead);
    }
    if expect_head.is_some() && expect_head != head {
        add(CarryBlocker::HeadChanged);
    }
    if let Some(requested) = requested {
        if requested.len() > MAX_REQUESTED
            || requested
                .iter()
                .any(|path| !safe_relative(path.trim_end_matches('/')))
        {
            add(CarryBlocker::InvalidPath);
        }
        for path in requested {
            let path = path.trim_end_matches('/');
            if safe_relative(path) && !status.iter().any(|entry| covers(path, &entry.path)) {
                add(CarryBlocker::NotChanged);
            }
        }
    }
    if status.len() > MAX_CHANGES {
        add(CarryBlocker::TooManyChanges);
    }
    let mut entries = Vec::with_capacity(status.len());
    let mut paths = Vec::new();
    for entry in status {
        let selected = requested.is_none_or(|requested| {
            requested
                .iter()
                .any(|path| covers(path.trim_end_matches('/'), &entry.path))
        });
        let blocker = if !selected {
            None
        } else if entry.change == CarryChange::Unmerged {
            Some(CarryBlocker::Unmerged)
        } else if entry.submodule {
            Some(CarryBlocker::Submodule)
        } else {
            None
        };
        if let Some(blocker) = blocker {
            add(blocker);
        }
        if selected {
            paths.push(entry.path.clone());
        }
        entries.push(WorktreeCarryEntry {
            path: entry.path.clone(),
            change: entry.change,
            staged: entry.staged,
            unstaged: entry.unstaged,
            selected,
            blocker,
        });
    }
    if paths.is_empty() {
        add(CarryBlocker::NoChanges);
    }
    Selection {
        entries,
        blockers,
        paths,
    }
}

/// A target may receive a carry only when Git reports nothing uncommitted.
pub fn target_clean(status: &[StatusEntry]) -> bool {
    status.is_empty()
}

/// After the carry is applied, the target's changes must all be staged, with
/// nothing unstaged, untracked or unmerged: the working tree then equals the
/// index, whose tree the caller compares with the applied tree.
pub fn target_verified(status: &[StatusEntry], index_tree: &str, applied_tree: &str) -> bool {
    index_tree == applied_tree
        && status.iter().all(|entry| {
            entry.staged
                && !entry.unstaged
                && !matches!(entry.change, CarryChange::Untracked | CarryChange::Unmerged)
        })
}

/// Whether the source may be cleaned before re-reading it. Only an exact,
/// verified carry qualifies: a merged result differs from the source content
/// by design, so nothing proves the source's changes arrived intact.
pub fn may_clean(requested: bool, verified: bool, exact: bool) -> Result<(), CarryKeepReason> {
    if !requested {
        Err(CarryKeepReason::NotRequested)
    } else if !verified {
        Err(CarryKeepReason::NotVerified)
    } else if !exact {
        Err(CarryKeepReason::BaseDiffers)
    } else {
        Ok(())
    }
}

/// Refuses source cleanup while any path has both staged and unstaged
/// changes: the carry snapshot records only the working-tree version, so a
/// reset would leave the staged version unreachable.
pub fn index_intact(entries: &[StatusEntry]) -> Result<(), CarryKeepReason> {
    if entries.iter().any(|entry| entry.staged && entry.unstaged) {
        Err(CarryKeepReason::StagedAndUnstaged)
    } else {
        Ok(())
    }
}

/// Whether the source still holds exactly the snapshot: the same `HEAD` and
/// the same content for every carried path.
pub fn source_unchanged(
    base: &str,
    head_now: Option<&str>,
    snapshot: &str,
    snapshot_now: Option<&str>,
) -> Result<(), CarryKeepReason> {
    if head_now == Some(base) && snapshot_now == Some(snapshot) {
        Ok(())
    } else {
        Err(CarryKeepReason::SourceChanged)
    }
}

/// The ledger status of a carry that reached the target. A requested source
/// cleanup that did not happen is partial, never success.
pub fn carry_status(
    verified: bool,
    clean_requested: bool,
    source: CarrySourceOutcome,
) -> WorktreeOperationStatus {
    match (verified, clean_requested, source) {
        (false, _, _) => WorktreeOperationStatus::Failed,
        (true, false, _) | (true, true, CarrySourceOutcome::Cleaned) => {
            WorktreeOperationStatus::Succeeded
        }
        (true, true, _) => WorktreeOperationStatus::Partial,
    }
}

/// The ref that keeps a carry's snapshot, derived from its operation ID so
/// recovery can find it from the ledger row alone.
pub fn carry_ref(operation_id: &str) -> String {
    format!("refs/ade/carry/{}", short_hash(operation_id))
}

/// The ref a fetched source lands in, derived from the operation ID.
pub fn fetched_ref(operation_id: &str) -> String {
    format!("refs/ade/fetched/{}", short_hash(operation_id))
}

fn short_hash(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .take(12)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Parses `git merge-tree --write-tree -z --name-only --no-messages`: the
/// merged tree, then the conflicted paths. Any conflicted path, or exit status
/// 1, is a conflict; any other non-zero status is an error.
pub fn parse_merge(exit_code: Option<i64>, stdout: &str) -> Result<(String, Vec<String>)> {
    let mut records = stdout.split('\0').filter(|record| !record.is_empty());
    let tree = records.next().unwrap_or_default().trim().to_owned();
    let conflicts: Vec<String> = records.map(str::to_owned).collect();
    match exit_code {
        Some(0 | 1) => {}
        _ => bail!("Git could not merge the carried changes"),
    }
    ensure!(
        !tree.is_empty() && tree.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "Git merge returned no tree"
    );
    if exit_code == Some(1) && conflicts.is_empty() {
        bail!("Git reported a conflicted merge without naming a path");
    }
    Ok((tree, conflicts))
}

/// A commit name as Git prints it.
pub fn object_id(text: &str) -> bool {
    matches!(text.len(), 40 | 64) && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Parses `git diff-tree -r -z --name-status`: a status letter, then a path.
pub fn parse_name_status(text: &str) -> Result<Vec<(char, String)>> {
    let records: Vec<&str> = text
        .split('\0')
        .filter(|record| !record.is_empty())
        .collect();
    ensure!(
        records.len().is_multiple_of(2),
        "Invalid Git name-status output"
    );
    records
        .chunks(2)
        .map(|pair| {
            let status = pair[0].chars().next().unwrap_or(' ');
            ensure!(
                matches!(status, 'A' | 'M' | 'D' | 'T') && pair[0].len() == 1,
                "Unexpected Git change {}",
                pair[0]
            );
            Ok((status, pair[1].to_owned()))
        })
        .collect()
}

/// The carried paths Git knows, so a reset never names a path that matches
/// nothing: those in the index (`index` is `git ls-files -z --cached`
/// output) and those in `base`, in `paths` order then `in_base` order,
/// without repeats. `git ls-files` has no `--pathspec-from-file`, so the
/// whole index is listed and filtered here.
pub fn known_paths(index: &str, paths: &[String], in_base: &[String]) -> Vec<String> {
    let indexed: std::collections::HashSet<&str> =
        index.split('\0').filter(|path| !path.is_empty()).collect();
    let mut known: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let candidates = paths
        .iter()
        .filter(|path| indexed.contains(path.as_str()))
        .chain(in_base);
    for path in candidates {
        if seen.insert(path.as_str()) {
            known.push(path.clone());
        }
    }
    known
}

/// The carried paths a cleanup read-back snapshots: those present in the
/// source (`present`) or in `base`. A carried addition the cleanup deleted
/// is neither, and naming it would fail the snapshot on a pathspec that
/// matches nothing. An empty result means every carried path is absent from
/// both, which is exactly `base` for those paths.
pub fn readback_paths(
    paths: &[String],
    in_base: &[String],
    present: impl Fn(&str) -> bool,
) -> Vec<String> {
    paths
        .iter()
        .filter(|path| in_base.contains(path) || present(path))
        .cloned()
        .collect()
}

/// A tree may receive a carry when it is ready or has no recorded phase
/// (adopted). Setup, teardown and failed phases refuse.
pub fn may_receive(phase: Option<WorktreePhase>) -> Result<()> {
    match phase {
        None | Some(WorktreePhase::Ready) => Ok(()),
        Some(_) => bail!("The target is not ready; finish or recover its setup first"),
    }
}

/// How a carry claims its source. A carry that cleans the source rewrites
/// and deletes files there, so it needs the source to itself: a terminal,
/// Agent or restore still writing there could have an edit overwritten that
/// neither the saved commit nor the target holds. `source_leased` is whether
/// this profile holds a lease inside the source; the exclusive claim then
/// refuses new leases and every other profile's use until it settles.
pub fn source_claim(clean: bool, source_leased: bool) -> Result<ClaimMode> {
    if !clean {
        return Ok(ClaimMode::Shared);
    }
    ensure!(
        !source_leased,
        "The source has an active terminal or Agent. Close them before carrying with clean_source, or carry without cleaning."
    );
    Ok(ClaimMode::Exclusive)
}

/// A fetch source must name a configured remote and a full ref. URLs,
/// refspecs and option-like values are refused before Git sees them.
pub fn validate_fetch(remote: &str, reference: &str, remotes: &[String]) -> Result<()> {
    ensure!(
        !remote.starts_with('-') && remotes.iter().any(|known| known == remote),
        "Fetch remote {remote} is not a configured remote; add it with git remote first"
    );
    ensure!(
        reference.len() <= 256
            && reference.starts_with("refs/")
            && !reference.ends_with('/')
            && !reference.ends_with(".lock")
            && !reference.contains("..")
            && !reference.contains("//")
            && !reference
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || ":+*?[\\^~@{".contains(c)),
        "Fetch ref must be a full ref such as refs/pull/12/head"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status() -> Vec<StatusEntry> {
        parse_status(concat!(
            "# branch.oid abc\0",
            "1 .M N... 100644 100644 100644 aaa aaa src/a.rs\0",
            "1 M. N... 100644 100644 100644 aaa bbb src/b.rs\0",
            "1 D. N... 100644 000000 000000 aaa 000 gone\0",
            "1 A. N... 000000 100644 100644 000 ccc added file\0",
            "1 .M SC.. 160000 160000 160000 aaa aaa vendor/sub\0",
            "u UU N... 100644 100644 100644 100644 a b c conflict.txt\0",
            "? new dir/x y\0",
            "! ignored.env\0",
        ))
        .unwrap()
    }

    #[test]
    fn status_records_parse_with_spaces_submodules_and_conflicts() {
        let entries = status();
        assert_eq!(entries.len(), 7);
        assert_eq!(entries[0].change, CarryChange::Modified);
        assert!(!entries[0].staged && entries[0].unstaged);
        assert!(entries[1].staged && !entries[1].unstaged);
        assert_eq!(entries[2].change, CarryChange::Deleted);
        assert_eq!(entries[3].path, "added file");
        assert_eq!(entries[3].change, CarryChange::Added);
        assert!(entries[4].submodule);
        assert_eq!(entries[5].change, CarryChange::Unmerged);
        assert_eq!(entries[6].path, "new dir/x y");
        assert_eq!(entries[6].change, CarryChange::Untracked);
        assert!(parse_status("2 R. N... 1 1 1 a b R100 x\0y\0").is_err());
        assert!(parse_status("1 .M N... short\0").is_err());
        assert!(parse_status("").unwrap().is_empty());
    }

    #[test]
    fn selecting_everything_blocks_on_conflicts_and_submodules() {
        let selection = select(&status(), None, Some("abc"), None);
        assert_eq!(
            selection.blockers,
            vec![CarryBlocker::Submodule, CarryBlocker::Unmerged]
        );
        assert_eq!(selection.paths.len(), 7);
    }

    #[test]
    fn selecting_paths_takes_directories_and_refuses_unchanged_or_unsafe_paths() {
        let requested = vec!["src/".to_owned(), "new dir".to_owned()];
        let selection = select(&status(), Some(&requested), Some("abc"), Some("abc"));
        assert!(selection.blockers.is_empty(), "{:?}", selection.blockers);
        assert_eq!(selection.paths, vec!["src/a.rs", "src/b.rs", "new dir/x y"]);
        assert!(!selection.entries[2].selected);
        // `sr` is a prefix of `src` but not a directory above it.
        let selection = select(&status(), Some(&["sr".into()]), Some("abc"), None);
        assert!(selection.blockers.contains(&CarryBlocker::NotChanged));
        assert!(selection.blockers.contains(&CarryBlocker::NoChanges));
        for bad in ["../x", "/etc/passwd", ".git/config", "a/./b", ""] {
            let selection = select(&status(), Some(&[bad.into()]), Some("abc"), None);
            assert!(
                selection.blockers.contains(&CarryBlocker::InvalidPath),
                "{bad}"
            );
        }
    }

    #[test]
    fn heads_must_exist_and_match_the_preview() {
        let requested = vec!["src".to_owned()];
        let selection = select(&status(), Some(&requested), None, None);
        assert!(selection.blockers.contains(&CarryBlocker::UnbornHead));
        let selection = select(&status(), Some(&requested), Some("abc"), Some("def"));
        assert_eq!(selection.blockers, vec![CarryBlocker::HeadChanged]);
        assert!(select(&[], None, Some("abc"), None).blockers == vec![CarryBlocker::NoChanges]);
    }

    #[test]
    fn target_verification_requires_staged_only_changes_and_the_applied_tree() {
        let staged = parse_status("1 M. N... 100644 100644 100644 a b f\0").unwrap();
        assert!(target_verified(&staged, "t1", "t1"));
        assert!(!target_verified(&staged, "t1", "t2"));
        let unstaged = parse_status("1 MM N... 100644 100644 100644 a b f\0").unwrap();
        assert!(!target_verified(&unstaged, "t1", "t1"));
        let untracked = parse_status("? stray\0").unwrap();
        assert!(!target_verified(&untracked, "t1", "t1"));
        assert!(target_clean(&[]) && !target_clean(&untracked));
    }

    #[test]
    fn the_source_is_cleaned_only_after_an_exact_verified_unchanged_carry() {
        assert_eq!(
            may_clean(false, true, true),
            Err(CarryKeepReason::NotRequested)
        );
        assert_eq!(
            may_clean(true, false, true),
            Err(CarryKeepReason::NotVerified)
        );
        assert_eq!(
            may_clean(true, true, false),
            Err(CarryKeepReason::BaseDiffers)
        );
        assert_eq!(may_clean(true, true, true), Ok(()));
    }

    #[test]
    fn cleanup_keeps_a_source_with_staged_and_unstaged_changes() {
        let entry = |staged, unstaged| StatusEntry {
            path: "a.txt".into(),
            change: CarryChange::Modified,
            staged,
            unstaged,
            submodule: false,
        };
        assert_eq!(
            index_intact(&[entry(true, false), entry(false, true)]),
            Ok(())
        );
        assert_eq!(
            index_intact(&[entry(true, true)]),
            Err(CarryKeepReason::StagedAndUnstaged)
        );
        assert_eq!(source_unchanged("b", Some("b"), "t", Some("t")), Ok(()));
        for (head, tree) in [(Some("c"), Some("t")), (Some("b"), Some("u")), (None, None)] {
            assert_eq!(
                source_unchanged("b", head, "t", tree),
                Err(CarryKeepReason::SourceChanged)
            );
        }
    }

    #[test]
    fn a_requested_cleanup_that_did_not_happen_is_partial() {
        use CarrySourceOutcome::*;
        use WorktreeOperationStatus::*;
        assert_eq!(carry_status(true, false, Kept), Succeeded);
        assert_eq!(carry_status(true, true, Cleaned), Succeeded);
        assert_eq!(carry_status(true, true, Kept), Partial);
        assert_eq!(carry_status(true, true, CleanupIncomplete), Partial);
        assert_eq!(carry_status(false, true, Kept), Failed);
    }

    #[test]
    fn refs_are_stable_per_operation_and_ref_safe() {
        let name = carry_ref("op 1/../x");
        assert_eq!(name, carry_ref("op 1/../x"));
        assert_ne!(name, carry_ref("op 2"));
        assert!(name.starts_with("refs/ade/carry/") && name.len() == "refs/ade/carry/".len() + 24);
        assert!(fetched_ref("k").starts_with("refs/ade/fetched/"));
    }

    #[test]
    fn merge_output_distinguishes_clean_conflicted_and_failed() {
        let tree = "a".repeat(40);
        assert_eq!(
            parse_merge(Some(0), &format!("{tree}\0")).unwrap(),
            (tree.clone(), vec![])
        );
        let (_, conflicts) = parse_merge(Some(1), &format!("{tree}\0f\0dir/g h\0")).unwrap();
        assert_eq!(conflicts, vec!["f", "dir/g h"]);
        assert!(parse_merge(Some(1), &format!("{tree}\0")).is_err());
        assert!(parse_merge(Some(128), "").is_err());
        assert!(parse_merge(None, &tree).is_err());
        assert!(object_id(&tree) && !object_id("HEAD"));
    }

    #[test]
    fn source_cleanup_resets_only_indexed_or_base_paths_once() {
        let owned = |items: &[&str]| {
            items
                .iter()
                .map(|item| (*item).to_owned())
                .collect::<Vec<_>>()
        };
        let index = "a.txt\0b dir/x\0staged-new\0keep\0";
        let paths = owned(&["a.txt", "untracked", "staged-new", "b dir/x"]);
        let in_base = owned(&["a.txt", "deleted"]);
        assert_eq!(
            known_paths(index, &paths, &in_base),
            owned(&["a.txt", "staged-new", "b dir/x", "deleted"])
        );
        assert!(known_paths("", &owned(&["untracked"]), &[]).is_empty());
    }

    #[test]
    fn the_cleanup_read_back_skips_additions_that_are_gone() {
        let owned = |items: &[&str]| {
            items
                .iter()
                .map(|item| (*item).to_owned())
                .collect::<Vec<_>>()
        };
        let paths = owned(&["modified", "deleted", "added-gone", "added-back"]);
        let in_base = owned(&["modified", "deleted"]);
        assert_eq!(
            readback_paths(&paths, &in_base, |path| path == "added-back"
                || path == "modified"),
            owned(&["modified", "deleted", "added-back"])
        );
        assert!(readback_paths(&owned(&["added-gone"]), &[], |_| false).is_empty());
    }

    #[test]
    fn staged_then_deleted_additions_are_no_change() {
        let entries = parse_status("1 AD N... 000000 100644 000000 0 a gone\0").unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn name_status_pairs_parse_and_unknown_letters_refuse() {
        assert_eq!(
            parse_name_status("M\0a b\0A\0new\0D\0old\0").unwrap(),
            vec![
                ('M', "a b".into()),
                ('A', "new".into()),
                ('D', "old".into())
            ]
        );
        assert!(parse_name_status("R100\0a\0").is_err());
        assert!(parse_name_status("M\0").is_err());
    }

    #[test]
    fn only_ready_or_adopted_trees_receive_a_carry() {
        assert!(may_receive(None).is_ok());
        assert!(may_receive(Some(WorktreePhase::Ready)).is_ok());
        for phase in [
            WorktreePhase::Creating,
            WorktreePhase::SettingUp,
            WorktreePhase::SetupFailed,
            WorktreePhase::TearingDown,
        ] {
            assert!(may_receive(Some(phase)).is_err());
        }
    }

    #[test]
    fn cleaning_the_source_needs_it_exclusively_and_unleased() {
        // Without cleaning, the source is only read and may stay in use.
        assert_eq!(source_claim(false, false).unwrap(), ClaimMode::Shared);
        assert_eq!(source_claim(false, true).unwrap(), ClaimMode::Shared);
        // An Agent or shell still writing in the source could lose an edit to
        // the cleaning checkout, so the carry is refused before it starts.
        assert!(source_claim(true, true).is_err());
        // Otherwise the exclusive claim keeps new writers out until cleaned.
        assert_eq!(source_claim(true, false).unwrap(), ClaimMode::Exclusive);
    }

    #[test]
    fn fetch_sources_name_configured_remotes_and_full_refs() {
        let remotes = vec!["origin".to_owned(), "upstream".to_owned()];
        assert!(validate_fetch("origin", "refs/pull/12/head", &remotes).is_ok());
        assert!(validate_fetch("upstream", "refs/merge-requests/3/head", &remotes).is_ok());
        assert!(validate_fetch("https://evil/x", "refs/pull/1/head", &remotes).is_err());
        assert!(validate_fetch("--upload-pack=x", "refs/pull/1/head", &remotes).is_err());
        for bad in [
            "pull/1/head",
            "refs/pull/1/head:refs/heads/main",
            "+refs/pull/1/head",
            "refs/pull/*/head",
            "refs/pull/../x",
            "refs/x.lock",
            "refs/a b",
        ] {
            assert!(validate_fetch("origin", bad, &remotes).is_err(), "{bad}");
        }
    }
}
