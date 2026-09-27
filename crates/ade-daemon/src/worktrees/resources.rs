//! Ignored-resource rules (F068). A rule names one ignored path of the
//! primary checkout and whether a tree gets a copy, a link or nothing.
//! Nothing ignored reaches a tree without a rule, so secrets such as `.env`
//! are never copied silently. Existing files are never replaced.
//!
//! The literal-path, ignored-only and no-clobber rules follow the pattern of
//! Orca's `.worktreeinclude` handling (MIT); no code was copied.
use super::carry::safe_relative;
use ade_core::contract::worktrees::{ResourceOutcome, WorktreePhase};
use ade_core::worktrees::{ResourceMode, ResourceRule};
use anyhow::{Context, Result, bail, ensure};
use std::{
    fs::{self, OpenOptions},
    io,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
};

/// At most this many rules per repository.
pub const MAX_RULES: usize = 64;
/// A copy may hold at most this many bytes …
pub const MAX_COPY_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// … and this many files, directories and links.
pub const MAX_COPY_ENTRIES: u64 = 200_000;

/// Limits `worktree.configure` enforces before storing rules.
pub fn validate_rules(rules: &[ResourceRule]) -> Result<()> {
    ensure!(
        rules.len() <= MAX_RULES,
        "At most {MAX_RULES} resource rules are allowed"
    );
    for (i, rule) in rules.iter().enumerate() {
        let path = rule.path.as_str();
        ensure!(
            path.len() <= 1024
                && safe_relative(path)
                && !path.starts_with('!')
                && !path.contains(['*', '?', '[', '\\']),
            "Resource path {path} must be a literal relative path without globs, '..' or .git"
        );
        for other in &rules[..i] {
            let (a, b) = (other.path.as_str(), path);
            ensure!(
                a != b
                    && !b.strip_prefix(a).is_some_and(|rest| rest.starts_with('/'))
                    && !a.strip_prefix(b).is_some_and(|rest| rest.starts_with('/')),
                "Resource rules {a} and {b} overlap"
            );
        }
    }
    Ok(())
}

/// What the source path is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceKind {
    Missing,
    File,
    Directory,
    Symlink,
    /// A socket, FIFO or device.
    Other,
}

/// Everything one rule's decision depends on, gathered by the caller.
#[derive(Clone, Copy, Debug)]
pub struct Facts {
    pub source: SourceKind,
    /// Whether Git ignores the path in the primary checkout; `None` when
    /// Git could not say.
    pub ignored: Option<bool>,
    pub destination_exists: bool,
    /// Both the source's and the destination's parent directories resolve
    /// inside their own trees.
    pub contained: bool,
}

/// What to do for one rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Plan {
    Copy,
    Link,
    Report(ResourceOutcome),
}

/// Decides one rule. Every doubt reports instead of acting.
pub fn plan(mode: ResourceMode, facts: Facts) -> Plan {
    use ResourceOutcome::*;
    if mode == ResourceMode::Skip {
        return Plan::Report(Skipped);
    }
    if facts.source == SourceKind::Missing {
        return Plan::Report(Missing);
    }
    if facts.ignored != Some(true) {
        return Plan::Report(NotIgnored);
    }
    if facts.destination_exists {
        return Plan::Report(Conflict);
    }
    if !facts.contained || facts.source == SourceKind::Other {
        return Plan::Report(Unsafe);
    }
    match mode {
        ResourceMode::Copy => Plan::Copy,
        ResourceMode::Link => Plan::Link,
        ResourceMode::Skip => Plan::Report(Skipped),
    }
}

/// `worktree.resources.apply` runs in a tree that is ready, adopted, or
/// whose setup failed or stopped, never while lifecycle work is in progress.
pub fn may_apply(phase: Option<WorktreePhase>) -> Result<()> {
    match phase {
        Some(WorktreePhase::Creating | WorktreePhase::SettingUp | WorktreePhase::TearingDown) => {
            bail!("Worktree lifecycle work is in progress; wait for it to settle")
        }
        Some(WorktreePhase::TeardownFailed | WorktreePhase::TeardownInterrupted) => {
            bail!("The tree's teardown did not finish; inspect it first")
        }
        _ => Ok(()),
    }
}

/// Whether a link just created stays: only when `git check-ignore` in the
/// tree exited 0 for it. Git treats a symbolic link as a file, so a
/// directory-only pattern such as `node_modules/` ignores the primary's
/// directory but not a link to it; an unignored link would leave the tree
/// dirty and block its cleanup.
pub fn link_kept(check_ignore_exit: Option<i64>) -> bool {
    check_ignore_exit == Some(0)
}

/// Whether a measured copy fits the limits.
pub fn copy_fits(bytes: u64, entries: u64) -> bool {
    bytes <= MAX_COPY_BYTES && entries <= MAX_COPY_ENTRIES
}

/// Whether every outcome lets setup continue. Only an unsafe path or a
/// failed copy or link stops it; the rest are reported.
pub fn outcomes_ok(outcomes: &[ResourceOutcome]) -> bool {
    !outcomes
        .iter()
        .any(|outcome| matches!(outcome, ResourceOutcome::Unsafe | ResourceOutcome::Failed))
}

/// The source kind, without following a final symbolic link.
pub fn source_kind(path: &Path) -> SourceKind {
    match fs::symlink_metadata(path) {
        Err(_) => SourceKind::Missing,
        Ok(metadata) if metadata.file_type().is_symlink() => SourceKind::Symlink,
        Ok(metadata) if metadata.is_dir() => SourceKind::Directory,
        Ok(metadata) if metadata.is_file() => SourceKind::File,
        Ok(_) => SourceKind::Other,
    }
}

/// Whether the nearest existing ancestor of `path`'s parent resolves inside
/// `root`, so a symbolic link in tracked content cannot redirect the rule.
pub fn contained(root: &Path, path: &Path) -> bool {
    let Ok(root) = root.canonicalize() else {
        return false;
    };
    path.parent()
        .into_iter()
        .flat_map(Path::ancestors)
        .find_map(|ancestor| ancestor.canonicalize().ok())
        .is_some_and(|resolved| resolved.starts_with(&root))
}

/// Counts bytes and entries beneath `path` without following links. Refuses
/// sockets, FIFOs and devices.
pub fn measure(path: &Path) -> Result<(u64, u64)> {
    let metadata = fs::symlink_metadata(path)?;
    let kind = metadata.file_type();
    if kind.is_symlink() {
        return Ok((0, 1));
    }
    if kind.is_file() {
        return Ok((metadata.len(), 1));
    }
    ensure!(kind.is_dir(), "{} is not a regular file", path.display());
    let (mut bytes, mut entries) = (0, 1);
    for child in fs::read_dir(path)? {
        let (b, e) = measure(&child?.path())?;
        bytes += b;
        entries += e;
        ensure!(copy_fits(bytes, entries), "Copy exceeds its limits");
    }
    Ok((bytes, entries))
}

/// Copies `source` to `destination` without following links and without
/// replacing anything: every file, directory and link is created new.
pub fn copy_new(source: &Path, destination: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    let kind = metadata.file_type();
    if kind.is_symlink() {
        std::os::unix::fs::symlink(fs::read_link(source)?, destination)
            .with_context(|| format!("Could not create {}", destination.display()))?;
    } else if kind.is_dir() {
        fs::create_dir(destination)
            .with_context(|| format!("Could not create {}", destination.display()))?;
        for child in fs::read_dir(source)? {
            let child = child?;
            copy_new(&child.path(), &destination.join(child.file_name()))?;
        }
        fs::set_permissions(
            destination,
            fs::Permissions::from_mode(metadata.permissions().mode() & 0o7777),
        )?;
    } else if kind.is_file() {
        let mut input = fs::File::open(source)?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(metadata.permissions().mode() & 0o7777)
            .open(destination)
            .with_context(|| format!("Could not create {}", destination.display()))?;
        io::copy(&mut input, &mut output)?;
        output.sync_all()?;
    } else {
        bail!("{} is not a regular file", source.display());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_link_stays_only_when_git_ignores_it_in_the_tree() {
        assert!(link_kept(Some(0)));
        // Not ignored (a directory-only pattern), or Git could not say.
        assert!(!link_kept(Some(1)));
        assert!(!link_kept(Some(128)));
        assert!(!link_kept(None));
    }

    fn rule(path: &str, mode: ResourceMode) -> ResourceRule {
        ResourceRule {
            path: path.into(),
            mode,
        }
    }

    fn facts() -> Facts {
        Facts {
            source: SourceKind::File,
            ignored: Some(true),
            destination_exists: false,
            contained: true,
        }
    }

    #[test]
    fn rules_are_literal_contained_and_disjoint() {
        assert!(
            validate_rules(&[
                rule(".env", ResourceMode::Copy),
                rule("node_modules", ResourceMode::Link),
                rule("apps/web/.env.local", ResourceMode::Skip),
            ])
            .is_ok()
        );
        for bad in [
            "../x",
            "/abs",
            "*.env",
            "!keep",
            ".git/config",
            "a//b",
            "a\\b",
        ] {
            assert!(
                validate_rules(&[rule(bad, ResourceMode::Copy)]).is_err(),
                "{bad}"
            );
        }
        assert!(
            validate_rules(&[
                rule("apps", ResourceMode::Link),
                rule("apps/web", ResourceMode::Copy)
            ])
            .is_err()
        );
        assert!(
            validate_rules(&[rule("a", ResourceMode::Copy), rule("a", ResourceMode::Link)])
                .is_err()
        );
        // `ap` and `apps` do not overlap.
        assert!(
            validate_rules(&[
                rule("ap", ResourceMode::Copy),
                rule("apps", ResourceMode::Link)
            ])
            .is_ok()
        );
        let many: Vec<_> = (0..=MAX_RULES)
            .map(|i| rule(&format!("r{i}"), ResourceMode::Skip))
            .collect();
        assert!(validate_rules(&many).is_err());
    }

    #[test]
    fn only_ignored_present_uncontested_contained_sources_are_materialized() {
        use ResourceOutcome::*;
        assert_eq!(plan(ResourceMode::Copy, facts()), Plan::Copy);
        assert_eq!(plan(ResourceMode::Link, facts()), Plan::Link);
        assert_eq!(plan(ResourceMode::Skip, facts()), Plan::Report(Skipped));
        let cases = [
            (
                Facts {
                    source: SourceKind::Missing,
                    ..facts()
                },
                Missing,
            ),
            (
                Facts {
                    ignored: Some(false),
                    ..facts()
                },
                NotIgnored,
            ),
            (
                Facts {
                    ignored: None,
                    ..facts()
                },
                NotIgnored,
            ),
            (
                Facts {
                    destination_exists: true,
                    ..facts()
                },
                Conflict,
            ),
            (
                Facts {
                    contained: false,
                    ..facts()
                },
                Unsafe,
            ),
            (
                Facts {
                    source: SourceKind::Other,
                    ..facts()
                },
                Unsafe,
            ),
        ];
        for (facts, outcome) in cases {
            assert_eq!(plan(ResourceMode::Copy, facts), Plan::Report(outcome));
            assert_eq!(plan(ResourceMode::Link, facts), Plan::Report(outcome));
        }
    }

    #[test]
    fn limits_and_outcomes_decide_whether_setup_continues() {
        assert!(copy_fits(MAX_COPY_BYTES, MAX_COPY_ENTRIES));
        assert!(!copy_fits(MAX_COPY_BYTES + 1, 1));
        assert!(!copy_fits(0, MAX_COPY_ENTRIES + 1));
        use ResourceOutcome::*;
        assert!(outcomes_ok(&[
            Copied, Linked, Skipped, Missing, NotIgnored, Conflict, TooLarge
        ]));
        assert!(!outcomes_ok(&[Copied, Unsafe]));
        assert!(!outcomes_ok(&[Failed]));
    }

    #[test]
    fn rules_apply_only_outside_lifecycle_work() {
        assert!(may_apply(None).is_ok());
        assert!(may_apply(Some(WorktreePhase::Ready)).is_ok());
        assert!(may_apply(Some(WorktreePhase::SetupFailed)).is_ok());
        assert!(may_apply(Some(WorktreePhase::SetupInterrupted)).is_ok());
        assert!(may_apply(Some(WorktreePhase::SettingUp)).is_err());
        assert!(may_apply(Some(WorktreePhase::TeardownFailed)).is_err());
    }
}
