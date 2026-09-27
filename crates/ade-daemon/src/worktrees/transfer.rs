//! Carrying uncommitted changes between trees (F064), fetched creation
//! sources (F065) and ignored-resource rules (F068). Every Git command runs
//! through the lifecycle supervisor under the repository lock; the decisions
//! live in [`super::carry`] and [`super::resources`].
use super::carry::{self, parse_status};
use super::resources::{self, Facts, Plan};
use super::{
    Data, LEDGER, Operation, Repository, authority, git, policy, put, repository_binding_matches,
    run_input, successful, tree_phase, valid,
};
use super::{JobStatus, Worktrees};
use crate::host_resources::{Settlement, Target};
use crate::model::new_id;
use ade_core::contract::resources::{ClaimMode, ClaimPurpose};
use ade_core::contract::worktrees::{
    CarryApply, CarryBlocker, CarryKeepReason, CarrySourceOutcome, ResourceOutcome,
    WorktreeCarryPreview, WorktreeCarryPreviewRequest, WorktreeCarryRequest, WorktreeCarryResult,
    WorktreeFetchSource, WorktreeResourceResult, WorktreeResourcesApplyRequest,
};
use ade_core::error::LifecycleFailure;
use ade_core::worktrees::ResourceMode;
use anyhow::{Context, Result, anyhow, bail, ensure};
use serde_json::{Value, json};
use std::{
    ffi::OsStr,
    fs::File,
    path::{Path, PathBuf},
};

/// A refusal or failure with its own code and recovery. The message names
/// paths and refs, never command output.
#[derive(Debug)]
pub(super) struct Refusal {
    pub code: &'static str,
    pub recovery: &'static str,
    pub message: String,
}
impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for Refusal {}

fn refusal(code: &'static str, recovery: &'static str, message: impl Into<String>) -> Refusal {
    Refusal {
        code,
        recovery,
        message: message.into(),
    }
}

/// What admission reserved for a carry.
pub(super) struct CarryAdmitted {
    source: PathBuf,
    target: PathBuf,
    paths: Option<Vec<String>>,
    expect_head: Option<String>,
    clean: bool,
    source_claim: String,
    target_claim: String,
}
impl CarryAdmitted {
    pub fn target(&self) -> &Path {
        &self.target
    }
    pub fn claims(&self) -> [&String; 2] {
        [&self.source_claim, &self.target_claim]
    }
}

/// Removes a temporary index file however the snapshot ends.
struct TempIndex(PathBuf);
impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let _ = std::fs::remove_file(self.0.with_extension("index.lock"));
    }
}

const STATUS: [&str; 6] = [
    "status",
    "--porcelain=v2",
    "-z",
    "--untracked-files=all",
    "--no-renames",
    "--ignore-submodules=none",
];

/// The identity carry commits carry, so no user configuration is needed.
const AUTHOR: [(&str, &str); 4] = [
    ("GIT_AUTHOR_NAME", "ADE carry"),
    ("GIT_AUTHOR_EMAIL", "ade-carry@localhost"),
    ("GIT_COMMITTER_NAME", "ADE carry"),
    ("GIT_COMMITTER_EMAIL", "ade-carry@localhost"),
];

fn nul_list(paths: &[String]) -> Vec<u8> {
    let mut input = Vec::new();
    for path in paths {
        input.extend_from_slice(path.as_bytes());
        input.push(0);
    }
    input
}

fn canonical(path: &str) -> Result<PathBuf> {
    let path = std::fs::canonicalize(path).with_context(|| format!("{path} is unavailable"))?;
    path.to_str().context("Path must be UTF-8")?;
    Ok(path)
}

fn text(path: &Path) -> &str {
    path.to_str().unwrap_or_default()
}

impl Worktrees {
    /// Runs Git in `tree` through the supervisor under `lock`. Returns the
    /// raw output; the caller judges the exit status.
    fn git_at(
        &self,
        repo: &Repository,
        lock: &File,
        tree: &Path,
        args: &[&str],
        env: &[(&str, &OsStr)],
        input: Option<Vec<u8>>,
    ) -> Result<Value> {
        let mut full = vec!["-C".to_owned(), text(tree).to_owned()];
        full.extend(args.iter().map(|arg| (*arg).to_owned()));
        let mut command = self.command_for(repo, &full)?;
        command.env("GIT_OPTIONAL_LOCKS", "0");
        for (key, value) in env {
            command.env(key, value);
        }
        run_input(command, repo.config.timeout_seconds, Some(lock), input)
    }

    /// Runs Git and returns its stdout, trailing newlines removed; a
    /// non-zero exit is an error.
    fn git_ok(
        &self,
        repo: &Repository,
        lock: &File,
        tree: &Path,
        args: &[&str],
        env: &[(&str, &OsStr)],
        input: Option<Vec<u8>>,
    ) -> Result<String> {
        let output = self.git_at(repo, lock, tree, args, env, input)?;
        Ok(successful(&output)?.trim_end_matches('\n').to_owned())
    }

    fn status_of(
        &self,
        repo: &Repository,
        lock: &File,
        tree: &Path,
    ) -> Result<Vec<carry::StatusEntry>> {
        let output = self.git_at(repo, lock, tree, &STATUS, &[], None)?;
        parse_status(successful(&output)?)
    }

    fn head_of(&self, repo: &Repository, lock: &File, tree: &Path) -> Option<String> {
        self.git_ok(
            repo,
            lock,
            tree,
            &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
            &[],
            None,
        )
        .ok()
        .filter(|head| carry::object_id(head))
    }

    /// The tree of `base` with the working-tree state of `paths` from `tree`,
    /// built in a temporary index. Neither the tree's index nor its files
    /// change; Git only writes objects.
    fn carry_snapshot(
        &self,
        repo: &Repository,
        lock: &File,
        tree: &Path,
        base: &str,
        paths: &[String],
    ) -> Result<String> {
        let index = TempIndex(self.directory.join(format!("{}.index", new_id("carry"))));
        let env = [
            ("GIT_INDEX_FILE", index.0.as_os_str()),
            ("GIT_LITERAL_PATHSPECS", OsStr::new("1")),
        ];
        self.git_ok(repo, lock, tree, &["read-tree", base], &env, None)?;
        self.git_ok(
            repo,
            lock,
            tree,
            &["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
            &env,
            Some(nul_list(paths)),
        )?;
        let written = self.git_ok(repo, lock, tree, &["write-tree"], &env, None)?;
        ensure!(carry::object_id(&written), "Git wrote no snapshot tree");
        Ok(written)
    }

    /// Confirms `path` is a listed, available tree of this repository.
    fn listed_tree(&self, repo: &Repository, lock: Option<&File>, path: &Path) -> Result<Value> {
        let listing = match lock {
            Some(lock) => self.list(repo, lock)?,
            None => super::parse_listing(&git(
                &repo.root,
                &["worktree", "list", "--porcelain", "-z"],
            )?)?,
        };
        let item = listing
            .as_array()
            .and_then(|items| items.iter().find(|item| item["path"] == text(path)))
            .cloned()
            .with_context(|| format!("{} is not a tree of this repository", path.display()))?;
        ensure!(
            item["prunable"] != true && item["bare"] != true,
            "{} is unavailable to Git; refresh and inspect it",
            path.display()
        );
        Ok(item)
    }

    /// `worktree.carry.preview`: the source's changes and blockers.
    pub(super) fn carry_preview(&self, request: &WorktreeCarryPreviewRequest) -> Result<Value> {
        let id = valid("repository_id", &request.repository_id)?;
        let repo: Repository = super::read_json(&self.data.lock().unwrap().db, "repositories", id)?;
        ensure!(
            repository_binding_matches(&repo),
            ade_core::error::NeedsRebind
        );
        let source = canonical(valid("source", &request.source)?)?;
        self.listed_tree(&repo, None, &source)?;
        let head = git(
            text(&source),
            &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        )
        .ok()
        .filter(|head| carry::object_id(head));
        let mut command = std::process::Command::new("git");
        super::neutral(&mut command);
        command
            .current_dir(&source)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .args(STATUS);
        let output = super::run(command, repo.config.timeout_seconds, None)?;
        let status = parse_status(successful(&output)?)?;
        let selection = carry::select(&status, request.paths.as_deref(), head.as_deref(), None);
        super::reply(&WorktreeCarryPreview {
            tag: Default::default(),
            repository_id: id.into(),
            source: text(&source).into(),
            head,
            carriable: selection.blockers.is_empty(),
            entries: selection.entries,
            blockers: selection.blockers,
        })
    }

    /// Admits a carry: checks paths and authority, then claims the source
    /// for shared use and the target exclusively, so no terminal, Agent or
    /// other profile works in the target while it changes.
    pub(super) fn admit_carry(
        &self,
        d: &Data,
        repo: &Repository,
        request: &WorktreeCarryRequest,
        operation_id: &str,
    ) -> Result<CarryAdmitted> {
        let source = canonical(valid("source", &request.source)?)?;
        let target = canonical(valid("target", &request.target)?)?;
        ensure!(source != target, "Carry needs two different trees");
        ensure!(
            target != Path::new(&repo.root),
            "The primary checkout cannot receive a carry; create a tree first"
        );
        if let Some(paths) = &request.paths {
            ensure!(
                !paths.is_empty() && paths.len() <= carry::MAX_REQUESTED,
                "Carry takes 1–{} paths",
                carry::MAX_REQUESTED
            );
            for path in paths {
                ensure!(
                    carry::safe_relative(path.trim_end_matches('/')),
                    "Carry paths must be relative paths inside the tree"
                );
            }
        }
        if let Some(head) = &request.expect_head {
            ensure!(carry::object_id(head), "expect_head must be a commit ID");
        }
        let target_text = text(&target);
        ensure!(
            authority(&d.db, &repo.id, target_text)? == policy::Authority::Verified,
            "The target must be a tree ADE created or adopted"
        );
        carry::may_receive(tree_phase(
            &d.db,
            &repo.id,
            repo.binding_generation,
            target_text,
        )?)?;
        for path in [&source, &target] {
            ensure!(
                !d.removing.iter().any(|removing| path.starts_with(removing)),
                "Worktree removal is in progress"
            );
        }
        ensure!(
            !d.leases.keys().any(|lease| lease.starts_with(&target)),
            "The target has an active terminal or Agent. Close them before carrying changes into it."
        );
        let target_claim = self.resources.acquire(
            Target::Existing(&target),
            ClaimMode::Exclusive,
            ClaimPurpose::Use,
            Some(operation_id),
        )?;
        let source_claim = match self.resources.acquire(
            Target::Existing(&source),
            ClaimMode::Shared,
            ClaimPurpose::Use,
            Some(operation_id),
        ) {
            Ok(claim) => claim,
            Err(error) => {
                self.resources.settle(&target_claim, Settlement::Release);
                return Err(error);
            }
        };
        Ok(CarryAdmitted {
            source,
            target,
            paths: request.paths.clone(),
            expect_head: request.expect_head.clone(),
            clean: request.clean_source == Some(true),
            source_claim,
            target_claim,
        })
    }

    /// Writes the carry record to the ledger row so an interruption from
    /// here on still names the saved commit.
    fn save_carry(&self, job: &mut Operation, record: &WorktreeCarryResult) -> Result<()> {
        job.result["carry"] = serde_json::to_value(record)?;
        put(&self.data.lock().unwrap().db, LEDGER, &job.id, job)
    }

    /// `worktree.carry`: snapshot, save, apply, verify, then optionally clean
    /// the source. Nothing is discarded on any failure: the snapshot commit
    /// is kept under its ref before the target changes.
    pub(super) fn execute_carry(
        &self,
        repo: Repository,
        mut job: Operation,
        lock: File,
        admitted: CarryAdmitted,
    ) {
        let CarryAdmitted {
            source,
            target,
            paths,
            expect_head,
            clean,
            source_claim,
            target_claim,
        } = admitted;
        // Whether each tree was handed a change, and whether its state was
        // read back afterwards.
        let (mut target_dispatched, mut target_observed) = (false, false);
        let (mut source_dispatched, mut source_observed) = (false, false);
        let mut status = None;
        job.result = json!({"value": {"path": text(&target)}});
        let result = (|| -> Result<()> {
            ensure!(
                repository_binding_matches(&repo),
                ade_core::error::NeedsRebind
            );
            self.listed_tree(&repo, Some(&lock), &source)?;
            self.listed_tree(&repo, Some(&lock), &target)?;
            {
                let d = self.data.lock().unwrap();
                ensure!(
                    authority(&d.db, &repo.id, text(&target))? == policy::Authority::Verified,
                    "Worktree removal authority changed; refresh and inspect before retrying"
                );
                carry::may_receive(tree_phase(
                    &d.db,
                    &repo.id,
                    repo.binding_generation,
                    text(&target),
                )?)?;
            }
            if !carry::target_clean(&self.status_of(&repo, &lock, &target)?) {
                bail!(refusal(
                    "carry_target_dirty",
                    "inspect_target",
                    format!(
                        "{} has uncommitted changes; carry only into a clean tree",
                        target.display()
                    ),
                ));
            }
            let head = self.head_of(&repo, &lock, &source);
            let selection = carry::select(
                &self.status_of(&repo, &lock, &source)?,
                paths.as_deref(),
                head.as_deref(),
                expect_head.as_deref(),
            );
            if !selection.blockers.is_empty() {
                job.result["blockers"] = json!(selection.blockers);
                bail!(refusal(
                    "carry_blocked",
                    "preview_carry",
                    format!(
                        "Carry is blocked: {}. Run worktree.carry.preview for details",
                        blocker_names(&selection.blockers)
                    ),
                ));
            }
            let base = head.context("Source has no commit")?;
            let mut record = WorktreeCarryResult {
                source: text(&source).into(),
                target: text(&target).into(),
                base: base.clone(),
                commit: None,
                ref_name: carry::carry_ref(&job.id),
                paths: selection.paths,
                target_head: None,
                applied: None,
                conflicts: Vec::new(),
                verified: false,
                source_outcome: CarrySourceOutcome::Kept,
                source_reason: None,
            };
            self.save_carry(&mut job, &record)?;
            let tree = self.carry_snapshot(&repo, &lock, &source, &base, &record.paths)?;
            let author: Vec<(&str, &OsStr)> = AUTHOR
                .iter()
                .map(|(key, value)| (*key, OsStr::new(*value)))
                .collect();
            let message = format!("ADE carry\n\nref: {}\n", record.ref_name);
            let commit = self.git_ok(
                &repo,
                &lock,
                &source,
                &["commit-tree", &tree, "-p", &base, "-F", "-"],
                &author,
                Some(message.into_bytes()),
            )?;
            ensure!(carry::object_id(&commit), "Git wrote no carry commit");
            // An empty old value creates the ref only if it does not exist.
            self.git_ok(
                &repo,
                &lock,
                &source,
                &[
                    "update-ref",
                    "-m",
                    "ade carry",
                    &record.ref_name,
                    &commit,
                    "",
                ],
                &[],
                None,
            )?;
            record.commit = Some(commit.clone());
            self.save_carry(&mut job, &record)?;
            let saved = format!("The changes are saved in {}", record.ref_name);
            let target_head = self
                .head_of(&repo, &lock, &target)
                .context("Target has no commit")?;
            record.target_head = Some(target_head.clone());
            let (applied_tree, apply) = if target_head == base {
                (tree.clone(), CarryApply::Exact)
            } else {
                let merge_base = format!("--merge-base={base}");
                let output = self.git_at(
                    &repo,
                    &lock,
                    &target,
                    &[
                        "merge-tree",
                        "--write-tree",
                        "-z",
                        "--name-only",
                        "--no-messages",
                        &merge_base,
                        &target_head,
                        &commit,
                    ],
                    &[],
                    None,
                )?;
                let (merged, conflicts) = carry::parse_merge(
                    output["exit_code"].as_i64(),
                    output["stdout"].as_str().unwrap_or_default(),
                )?;
                if !conflicts.is_empty() {
                    record.applied = Some(CarryApply::Conflicted);
                    record.conflicts = conflicts;
                    self.save_carry(&mut job, &record)?;
                    bail!(refusal(
                        "carry_conflict",
                        "resolve_from_carry_ref",
                        format!(
                            "The carried changes conflict with {} in {} paths; nothing was applied and the source was kept. {saved}",
                            target.display(),
                            record.conflicts.len()
                        ),
                    ));
                }
                (merged, CarryApply::Merged)
            };
            // Recheck immediately before the target changes.
            if !carry::target_clean(&self.status_of(&repo, &lock, &target)?)
                || self.head_of(&repo, &lock, &target).as_deref() != Some(&target_head)
            {
                bail!(refusal(
                    "carry_target_dirty",
                    "inspect_target",
                    format!(
                        "{} changed during the carry; nothing was applied. {saved}",
                        target.display()
                    ),
                ));
            }
            target_dispatched = true;
            let applied = self.git_at(
                &repo,
                &lock,
                &target,
                &["read-tree", "-m", "-u", &target_head, &applied_tree],
                &[],
                None,
            );
            let index_tree = self.git_ok(&repo, &lock, &target, &["write-tree"], &[], None);
            let after = self.status_of(&repo, &lock, &target);
            // A command that never started had no effect; any other error
            // leaves the outcome to what the read-back shows.
            let exited = match &applied {
                Ok(_) => true,
                Err(error) => {
                    error.downcast_ref::<LifecycleFailure>()
                        == Some(&LifecycleFailure::LifecycleUnavailable)
                }
            };
            target_observed = exited && index_tree.is_ok() && after.is_ok();
            record.applied = Some(apply);
            record.verified = applied
                .as_ref()
                .is_ok_and(|output| successful(output).is_ok())
                && matches!((&index_tree, &after),
                    (Ok(index_tree), Ok(after)) if carry::target_verified(after, index_tree, &applied_tree));
            self.save_carry(&mut job, &record)?;
            if !record.verified {
                bail!(refusal(
                    "carry_unverified",
                    "inspect_target_before_retry",
                    format!(
                        "The carry into {} did not read back as applied; the source was kept. {saved}",
                        target.display()
                    ),
                ));
            }
            match carry::may_clean(clean, record.verified, apply == CarryApply::Exact).and_then(
                |()| {
                    let head_now = self.head_of(&repo, &lock, &source);
                    let snapshot_now = self
                        .carry_snapshot(&repo, &lock, &source, &base, &record.paths)
                        .ok();
                    carry::source_unchanged(
                        &base,
                        head_now.as_deref(),
                        &tree,
                        snapshot_now.as_deref(),
                    )
                },
            ) {
                Err(reason) => record.source_reason = Some(reason),
                Ok(()) => {
                    source_dispatched = true;
                    let cleaned =
                        self.clean_source(&repo, &lock, &source, &base, &tree, &record.paths);
                    source_observed = cleaned.is_ok();
                    record.source_outcome = match cleaned {
                        Ok(true) => CarrySourceOutcome::Cleaned,
                        Ok(false) | Err(_) => CarrySourceOutcome::CleanupIncomplete,
                    };
                }
            }
            self.save_carry(&mut job, &record)?;
            status = Some(carry::carry_status(
                record.verified,
                clean,
                record.source_outcome,
            ));
            if status == Some(JobStatus::Partial) {
                bail!(refusal(
                    "carry_source_kept",
                    "inspect_source",
                    format!(
                        "The changes were carried into {} and verified, but the source was not cleaned ({}). {saved}",
                        target.display(),
                        match (record.source_outcome, record.source_reason) {
                            (CarrySourceOutcome::CleanupIncomplete, _) => "cleanup incomplete",
                            (_, Some(CarryKeepReason::BaseDiffers)) =>
                                "the target started from another commit",
                            (_, Some(CarryKeepReason::SourceChanged)) => "the source changed",
                            _ => "not verified",
                        }
                    ),
                ));
            }
            Ok(())
        })();
        for (claim, dispatched, observed) in [
            (&target_claim, target_dispatched, target_observed),
            (&source_claim, source_dispatched, source_observed),
        ] {
            let settlement = if dispatched && !observed {
                Settlement::Quarantine("carry_outcome_unknown")
            } else {
                Settlement::Release
            };
            self.resources.settle(claim, settlement);
        }
        let status = status.or(result.is_err().then_some(JobStatus::Failed));
        self.finish(repo, job, lock, result, status, Vec::new());
    }

    /// Removes the carried changes from the source: resets their index
    /// entries and files to `base`, and deletes the files `base` lacks.
    /// Returns whether the source then reads back clean for those paths.
    fn clean_source(
        &self,
        repo: &Repository,
        lock: &File,
        source: &Path,
        base: &str,
        tree: &str,
        paths: &[String],
    ) -> Result<bool> {
        let literal = [("GIT_LITERAL_PATHSPECS", OsStr::new("1"))];
        let changes = carry::parse_name_status(&self.git_ok(
            repo,
            lock,
            source,
            &[
                "diff-tree",
                "-r",
                "--no-renames",
                "-z",
                "--name-status",
                base,
                tree,
            ],
            &[],
            None,
        )?)?;
        let (added, in_base): (Vec<_>, Vec<_>) =
            changes.into_iter().partition(|(status, _)| *status == 'A');
        let in_base: Vec<String> = in_base.into_iter().map(|(_, path)| path).collect();
        // Reset only paths Git knows, in `base` or in the index, so an
        // untracked file never reaches a pathspec that matches nothing.
        let mut known: Vec<String> = self
            .git_ok(
                repo,
                lock,
                source,
                &[
                    "ls-files",
                    "-z",
                    "--cached",
                    "--pathspec-from-file=-",
                    "--pathspec-file-nul",
                ],
                &literal,
                Some(nul_list(paths)),
            )?
            .split('\0')
            .filter(|path| !path.is_empty())
            .map(str::to_owned)
            .collect();
        let missing: Vec<String> = in_base
            .iter()
            .filter(|path| !known.contains(path))
            .cloned()
            .collect();
        known.extend(missing);
        if !known.is_empty() {
            self.git_ok(
                repo,
                lock,
                source,
                &[
                    "reset",
                    "-q",
                    base,
                    "--pathspec-from-file=-",
                    "--pathspec-file-nul",
                ],
                &literal,
                Some(nul_list(&known)),
            )?;
        }
        if !in_base.is_empty() {
            self.git_ok(
                repo,
                lock,
                source,
                &[
                    "checkout",
                    base,
                    "--pathspec-from-file=-",
                    "--pathspec-file-nul",
                ],
                &literal,
                Some(nul_list(&in_base)),
            )?;
        }
        for (_, path) in added {
            let file = source.join(&path);
            match std::fs::symlink_metadata(&file) {
                Ok(metadata) if !metadata.is_dir() => std::fs::remove_file(&file)?,
                Ok(_) => bail!("{path} became a directory"),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        let base_tree = self.git_ok(
            repo,
            lock,
            source,
            &["rev-parse", "--verify", &format!("{base}^{{tree}}")],
            &[],
            None,
        )?;
        Ok(self.carry_snapshot(repo, lock, source, base, paths)? == base_tree)
    }

    /// Fetches a creation source into its own ref and returns the commit.
    /// Only configured remotes are accepted, never URLs.
    pub(super) fn fetch_source(
        &self,
        repo: &Repository,
        lock: &File,
        job: &Operation,
        fetch: &WorktreeFetchSource,
    ) -> Result<(String, String)> {
        let root = Path::new(&repo.root);
        let remotes: Vec<String> = self
            .git_ok(repo, lock, root, &["remote"], &[], None)?
            .lines()
            .map(str::to_owned)
            .collect();
        carry::validate_fetch(&fetch.remote, &fetch.reference, &remotes)?;
        self.git_ok(
            repo,
            lock,
            root,
            &["check-ref-format", &fetch.reference],
            &[],
            None,
        )
        .map_err(|_| anyhow!("Invalid fetch ref"))?;
        let local = carry::fetched_ref(&job.id);
        let refspec = format!("+{}:{local}", fetch.reference);
        self.git_ok(
            repo,
            lock,
            root,
            &[
                "fetch",
                "--no-tags",
                "--no-recurse-submodules",
                "--no-write-fetch-head",
                "--no-auto-maintenance",
                "--",
                &fetch.remote,
                &refspec,
            ],
            &[],
            None,
        )
        .map_err(|error| {
            anyhow!(refusal(
                "fetch_failed",
                "check_remote_access",
                format!(
                    "Could not fetch {} from {}: {}",
                    fetch.reference,
                    fetch.remote,
                    ade_core::error::error_envelope(error)["message"]
                        .as_str()
                        .unwrap_or("Git failed")
                ),
            ))
        })?;
        let commit = self.git_ok(
            repo,
            lock,
            root,
            &["rev-parse", "--verify", &format!("{local}^{{commit}}")],
            &[],
            None,
        )?;
        ensure!(carry::object_id(&commit), "The fetched ref names no commit");
        Ok((local, commit))
    }

    /// Admits `worktree.resources.apply` with a shared-use claim, as setup does.
    pub(super) fn admit_resources(
        &self,
        d: &Data,
        repo: &Repository,
        request: &WorktreeResourcesApplyRequest,
        operation_id: &str,
    ) -> Result<(PathBuf, String)> {
        let path = canonical(valid("path", &request.path)?)?;
        ensure!(
            path != Path::new(&repo.root),
            "Resource rules apply only in linked trees"
        );
        ensure!(
            !repo.config.resources.is_empty(),
            "The repository has no resource rules; configure them first"
        );
        ensure!(
            authority(&d.db, &repo.id, text(&path))? == policy::Authority::Verified,
            "Resource rules apply only in a tree ADE created or adopted"
        );
        resources::may_apply(tree_phase(
            &d.db,
            &repo.id,
            repo.binding_generation,
            text(&path),
        )?)?;
        let claim = self.resources.acquire(
            Target::Existing(&path),
            ClaimMode::Shared,
            ClaimPurpose::Use,
            Some(operation_id),
        )?;
        Ok((path, claim))
    }

    /// `worktree.resources.apply`.
    pub(super) fn execute_resources(
        &self,
        repo: Repository,
        mut job: Operation,
        lock: File,
        path: PathBuf,
        claim: String,
    ) {
        job.result = json!({"value": {"path": text(&path)}});
        let result = (|| -> Result<()> {
            ensure!(
                repository_binding_matches(&repo),
                ade_core::error::NeedsRebind
            );
            self.listed_tree(&repo, Some(&lock), &path)?;
            ensure!(
                authority(&self.data.lock().unwrap().db, &repo.id, text(&path))?
                    == policy::Authority::Verified,
                "Worktree removal authority changed; refresh and inspect before retrying"
            );
            let results = self.apply_resources(&repo, &lock, &path);
            job.result["resources"] = json!(results);
            resources_outcome(&results)
        })();
        self.resources.settle(&claim, Settlement::Release);
        self.finish(repo, job, lock, result, None, Vec::new());
    }

    /// Applies every rule of the repository to `tree`, in order. Never
    /// replaces anything; every rule ends in a reported outcome.
    pub(super) fn apply_resources(
        &self,
        repo: &Repository,
        lock: &File,
        tree: &Path,
    ) -> Vec<WorktreeResourceResult> {
        let root = Path::new(&repo.root);
        repo.config
            .resources
            .iter()
            .map(|rule| {
                let mut result = WorktreeResourceResult {
                    path: rule.path.clone(),
                    mode: rule.mode,
                    outcome: ResourceOutcome::Skipped,
                    error: None,
                };
                let source = root.join(&rule.path);
                let destination = tree.join(&rule.path);
                let ignored = if rule.mode == ResourceMode::Skip {
                    None
                } else {
                    self.git_at(
                        repo,
                        lock,
                        root,
                        &["check-ignore", "-q", "--", &rule.path],
                        &[],
                        None,
                    )
                    .ok()
                    .and_then(|output| match output["exit_code"].as_i64() {
                        Some(0) => Some(true),
                        Some(1) => Some(false),
                        _ => None,
                    })
                };
                let facts = Facts {
                    source: resources::source_kind(&source),
                    ignored,
                    destination_exists: std::fs::symlink_metadata(&destination).is_ok(),
                    contained: resources::contained(root, &source)
                        && resources::contained(tree, &destination),
                };
                let outcome = match resources::plan(rule.mode, facts) {
                    Plan::Report(outcome) => Ok(outcome),
                    Plan::Copy => (|| -> Result<ResourceOutcome> {
                        let (bytes, entries) = match resources::measure(&source) {
                            Ok(size) => size,
                            Err(_) => return Ok(ResourceOutcome::TooLarge),
                        };
                        if !resources::copy_fits(bytes, entries) {
                            return Ok(ResourceOutcome::TooLarge);
                        }
                        self.make_parent(tree, &destination)?;
                        resources::copy_new(&source, &destination)?;
                        Ok(ResourceOutcome::Copied)
                    })(),
                    Plan::Link => (|| -> Result<ResourceOutcome> {
                        self.make_parent(tree, &destination)?;
                        std::os::unix::fs::symlink(&source, &destination)?;
                        Ok(ResourceOutcome::Linked)
                    })(),
                };
                match outcome {
                    Ok(outcome) => result.outcome = outcome,
                    Err(error) => {
                        result.outcome = ResourceOutcome::Failed;
                        result.error = Some(error.to_string().chars().take(512).collect());
                    }
                }
                result
            })
            .collect()
    }

    /// Creates the destination's parent directories and confirms they still
    /// resolve inside the tree.
    fn make_parent(&self, tree: &Path, destination: &Path) -> Result<()> {
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)?;
        }
        ensure!(
            resources::contained(tree, destination),
            "Destination resolves outside the tree"
        );
        Ok(())
    }
}

/// The error a set of resource results leaves, if any.
pub(super) fn resources_outcome(results: &[WorktreeResourceResult]) -> Result<()> {
    let outcomes: Vec<ResourceOutcome> = results.iter().map(|result| result.outcome).collect();
    if resources::outcomes_ok(&outcomes) {
        return Ok(());
    }
    let failed: Vec<&str> = results
        .iter()
        .filter(|result| {
            matches!(
                result.outcome,
                ResourceOutcome::Failed | ResourceOutcome::Unsafe
            )
        })
        .map(|result| result.path.as_str())
        .collect();
    Err(refusal(
        "resource_failed",
        "inspect_resources",
        format!(
            "Resource rules failed for {}; see result.resources. Nothing was replaced",
            failed.join(", ")
        ),
    )
    .into())
}

fn blocker_names(blockers: &[CarryBlocker]) -> String {
    blockers
        .iter()
        .map(|blocker| {
            serde_json::to_value(blocker)
                .ok()
                .and_then(|value| value.as_str().map(str::to_owned))
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(", ")
}
