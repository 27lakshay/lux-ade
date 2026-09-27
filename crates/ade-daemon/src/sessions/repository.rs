//! `repository.*` clone and publish operations (F062). Git work runs without
//! the session lock; receipts live in the profile database and take the lock
//! briefly.
//!
//! Each effect checks everything it can before it records a receipt, so a
//! refusal leaves no receipt. A dispatched receipt names the phase the effect
//! reached. A receipt left open by an earlier daemon process is reconciled
//! from the disk on replay and never runs Git's network step again.
use super::*;
use crate::checkpoints::{outcome, replay_outcome};
use crate::receipts::{self, Admission, Status};
use crate::repository::decide::{
    self, ClonePhase, CloneReconcile, DestinationFacts, PublishPhase, check_destination,
    reconcile_clone,
};
use crate::repository::{self as repo, CLONE_TIMEOUT, Claim, PUSH_TIMEOUT, text};
use ade_core::contract::repository::{
    RepositoryCloneOutcome, RepositoryCloneRequest, RepositoryCloned, RepositoryCoverageRequest,
    RepositoryPublishOutcome, RepositoryPublishPreview, RepositoryPublishPreviewRequest,
    RepositoryPublishRequest, RepositoryPublishStep as Step, RepositoryPublishVerdict,
    RepositoryPublished,
};
use ade_core::model::now_ms;
use rusqlite::{Connection, Transaction, TransactionBehavior};
use std::path::{Path, PathBuf};

fn operation_id(value: &str) -> Result<&str> {
    ensure!(
        !value.is_empty() && value.len() <= 512,
        "Missing or invalid operation_id"
    );
    Ok(value)
}

fn remote_url(url: &str) -> Result<String> {
    decide::parse_remote_url(url)
        .map(|parsed| parsed.url)
        .map_err(|reason| anyhow!(reason))
}

/// The validated, defaulted fields that preview and publish share.
struct PublishInput {
    folder: PathBuf,
    path: String,
    url: String,
    remote: String,
    initial_branch: String,
}

fn publish_input(
    path: &str,
    url: &str,
    remote: Option<&str>,
    initial_branch: Option<&str>,
) -> Result<PublishInput> {
    let url = remote_url(url)?;
    let remote = remote.unwrap_or("origin").to_owned();
    ensure!(decide::valid_remote_name(&remote), "Invalid remote name");
    let folder = std::fs::canonicalize(non_empty("path", path)?)
        .context("The folder to publish is unavailable")?;
    ensure!(folder.is_dir(), "The path to publish must be a folder");
    let initial_branch = initial_branch.unwrap_or("main").to_owned();
    ensure!(
        repo::branch_name_ok(&folder, &initial_branch),
        "Invalid initial_branch"
    );
    let path = folder
        .to_str()
        .context("The folder path must be UTF-8")?
        .to_owned();
    Ok(PublishInput {
        folder,
        path,
        url,
        remote,
        initial_branch,
    })
}

/// What a publish has completed so far.
#[derive(Default)]
struct Progress {
    initialized: bool,
    initial_commit: Option<String>,
    remote_added: bool,
}

impl Progress {
    fn record(&self, input: &PublishInput, branch: &str, phase: &str) -> Value {
        json!({"op": "repository.publish", "phase": phase, "path": input.path,
            "remote": input.remote, "branch": branch, "initialized": self.initialized,
            "initial_commit": self.initial_commit, "remote_added": self.remote_added})
    }
}

impl Sessions {
    fn repository_db<T>(
        &self,
        effect: bool,
        step: impl FnOnce(&Connection) -> Result<T>,
    ) -> Result<T> {
        let d = self.data.lock().unwrap();
        ensure!(!(effect && d.draining), "Application daemon is restarting");
        receipts::ensure(&d.store.connection)?;
        step(&d.store.connection)
    }

    /// Looks an operation ID up without recording anything.
    fn repository_peek(&self, id: &str, op: &str, request: &Value) -> Result<Admission> {
        self.repository_db(true, |db| {
            let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
            receipts::begin(&tx, id, op, request, None, now_ms())
        })
    }

    /// Records a dispatched receipt carrying `record`, the facts reconciliation needs.
    fn repository_dispatch(
        &self,
        id: &str,
        op: &str,
        request: &Value,
        record: &Value,
    ) -> Result<Admission> {
        self.repository_db(true, |db| {
            let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
            let admission = receipts::begin(&tx, id, op, request, None, now_ms())?;
            if admission == Admission::New {
                receipts::settle(&tx, id, Status::Dispatched, Some(record), now_ms())?;
                tx.commit()?;
            }
            Ok(admission)
        })
    }

    fn repository_settle(&self, id: &str, status: Status, result: &Value) -> Result<()> {
        self.repository_db(false, |db| {
            receipts::settle(db, id, status, Some(result), now_ms())
        })
    }

    /// Settles an effect and returns its outcome. If the receipt cannot be
    /// saved, the caller learns that, not the outcome it could not record.
    fn repository_finish(&self, id: &str, result: Result<Value>) -> Result<Value> {
        self.repository_settle(id, Status::Settled, &outcome(&result))
            .with_context(|| {
                format!(
                    "Operation {id} ran but its outcome was not recorded; retry with the same operation ID to reconcile it"
                )
            })?;
        result
    }

    /// Answers a known operation ID. The caller holds the ID's claim, so an
    /// open receipt belongs to an earlier daemon process.
    fn repository_replay(&self, id: &str, admission: Admission) -> Result<Value> {
        let receipt = match admission {
            Admission::New => bail!("Operation {id} was not admitted"),
            Admission::Conflict => bail!("Operation ID was already used for different parameters"),
            Admission::Expired => {
                bail!("Operation ID is past its 30-day receipt retention; use a new operation ID")
            }
            Admission::Replay(receipt) => receipt,
        };
        let record = receipt.result.unwrap_or(Value::Null);
        match receipt.status {
            Status::Settled => replay_outcome(Some(record)),
            Status::Unknown => Err(unknown(id, &record)),
            Status::Accepted | Status::Dispatched | Status::Acknowledged => {
                self.repository_reconcile(id, &record)
            }
        }
    }

    fn repository_reconcile(&self, id: &str, record: &Value) -> Result<Value> {
        match (record["op"].as_str(), record["phase"].as_str()) {
            (Some("repository.clone"), Some(phase @ ("cloning" | "registering"))) => {
                let destination = PathBuf::from(text(record, "destination"));
                let phase = if phase == "cloning" {
                    ClonePhase::Cloning
                } else {
                    ClonePhase::Registering
                };
                let exists = repo::path_exists(&destination);
                let still = exists
                    && repo::is_repository_root(&destination)
                    && repo::head(&destination) == record["head"].as_str().map(str::to_owned);
                match reconcile_clone(phase, exists, still) {
                    CloneReconcile::NothingWritten => self.repository_finish(
                        id,
                        Err(anyhow!("Clone was interrupted before it wrote anything; nothing changed")),
                    ),
                    CloneReconcile::Unknown => {
                        self.repository_settle(id, Status::Unknown, record)?;
                        Err(unknown(id, record))
                    }
                    CloneReconcile::Register => {
                        let reply = self.clone_register(record, &destination);
                        self.repository_finish(id, reply)
                    }
                    CloneReconcile::CloneMissing => self.repository_finish(
                        id,
                        Err(anyhow!(
                            "The verified clone at {} is gone or changed since the interruption; nothing was registered",
                            destination.display()
                        )),
                    ),
                }
            }
            (Some("repository.publish"), Some(phase @ ("local" | "pushing"))) => {
                let phase = if phase == "local" {
                    PublishPhase::Local
                } else {
                    PublishPhase::Pushing
                };
                if decide::publish_interrupted_is_unknown(phase) {
                    self.repository_settle(id, Status::Unknown, record)?;
                    return Err(unknown(id, record));
                }
                let folder = PathBuf::from(text(record, "path"));
                let state = match repo::publish_facts(&folder, &text(record, "remote")) {
                    Ok(facts) => format!(
                        " The folder is {}a repository, has {}commits and {} the remote.",
                        if facts.in_repository { "" } else { "not " },
                        if facts.head_born { "" } else { "no " },
                        if facts.remote_url.is_some() {
                            "has"
                        } else {
                            "does not have"
                        }
                    ),
                    Err(error) => format!(" Its current state could not be read: {error:#}."),
                };
                self.repository_finish(
                    id,
                    Err(anyhow!(
                        "Publish was interrupted before pushing; nothing was pushed.{state} Publish again with a new operation ID to continue"
                    )),
                )
            }
            _ => {
                self.repository_settle(id, Status::Unknown, record)?;
                Err(unknown(id, record))
            }
        }
    }

    pub(super) fn repository_command(self: &Arc<Self>, request: &Value) -> Result<Value> {
        match request["op"].as_str().unwrap_or("") {
            "repository.coverage" => {
                let RepositoryCoverageRequest {} = decode(request)?;
                reply(&decide::coverage())
            }
            "repository.clone" => self.repository_clone(request),
            "repository.publish.preview" => {
                let preview: RepositoryPublishPreviewRequest = decode(request)?;
                let input = publish_input(
                    &preview.path,
                    &preview.url,
                    preview.remote.as_deref(),
                    preview.initial_branch.as_deref(),
                )?;
                let facts = repo::publish_facts(&input.folder, &input.remote)?;
                let plan = repo::plan_publish(
                    &facts,
                    &input.url,
                    &input.initial_branch,
                    preview.create_initial_commit,
                );
                reply(&RepositoryPublishPreview {
                    tag: Default::default(),
                    verdict: plan.verdict,
                    path: input.path,
                    remote: input.remote,
                    branch: plan.branch,
                    steps: plan.steps,
                    uncommitted_changes: facts.uncommitted_changes,
                    blocked_reasons: plan.blocked_reasons,
                })
            }
            "repository.publish" => self.repository_publish(request),
            _ => bail!("Unknown repository operation"),
        }
    }

    /// Registers a verified clone. A registration failure is a partial
    /// outcome, not an error: the clone exists and stays.
    fn clone_register(&self, record: &Value, destination: &Path) -> Result<Value> {
        let path = destination.to_str().context("Destination must be UTF-8")?;
        let (outcome, workspace, registration_error) = match self.open_workspace(path) {
            Ok(workspace) => (RepositoryCloneOutcome::Registered, Some(workspace), None),
            Err(error) => (
                RepositoryCloneOutcome::ClonedNotRegistered,
                None,
                Some(format!("{error:#}")),
            ),
        };
        reply(&RepositoryCloned {
            tag: Default::default(),
            outcome,
            url: text(record, "url"),
            destination: path.to_owned(),
            head: record["head"].as_str().map(str::to_owned),
            branch: record["branch"].as_str().map(str::to_owned),
            workspace,
            registration_error,
        })
    }

    fn repository_clone(self: &Arc<Self>, request: &Value) -> Result<Value> {
        const OP: &str = "repository.clone";
        let clone: RepositoryCloneRequest = decode(request)?;
        let id = operation_id(&clone.operation_id)?;
        let url = remote_url(&clone.url)?;
        if let Some(branch) = &clone.branch {
            ensure!(decide::valid_branch_name(branch), "Invalid branch");
        }
        let raw = Path::new(non_empty("destination", &clone.destination)?);
        let facts = DestinationFacts {
            exists: false,
            parent_is_dir: raw.parent().is_some_and(Path::is_dir),
        };
        // Shape first; existence is checked after the receipt lookup, because
        // a replayed clone finds its own folder there.
        check_destination(&clone.destination, facts).map_err(|reason| anyhow!(reason))?;
        let destination = repo::destination_path(&clone.destination)?;
        let destination_text = destination
            .to_str()
            .context("Destination must be UTF-8")?
            .to_owned();
        let _claim = Claim::acquire(&destination_text, id)?;
        let admission = self.repository_peek(id, OP, request)?;
        if admission != Admission::New {
            return self.repository_replay(id, admission);
        }
        let parent = destination.parent().context("Destination has no parent")?;
        check_destination(
            &destination_text,
            DestinationFacts {
                exists: repo::path_exists(&destination),
                parent_is_dir: parent.is_dir(),
            },
        )
        .map_err(|reason| anyhow!(reason))?;
        let mut record =
            json!({"op": OP, "phase": "cloning", "destination": destination_text, "url": url});
        let admission = self.repository_dispatch(id, OP, request, &record)?;
        if admission != Admission::New {
            return self.repository_replay(id, admission);
        }
        let mut args = vec!["clone", "--no-recurse-submodules"];
        if let Some(branch) = &clone.branch {
            args.extend(["--branch", branch.as_str()]);
        }
        args.extend(["--", &url, &destination_text]);
        let run = repo::git(parent, &args, CLONE_TIMEOUT, true);
        if !run.ok() {
            let (_, what) = decide::clone_failure(run.exit_code, repo::path_exists(&destination));
            let error = anyhow!("{what}. {}", run.failure("git clone"));
            return self.repository_finish(id, Err(error));
        }
        if !repo::is_repository_root(&destination) {
            return self.repository_finish(
                id,
                Err(anyhow!(
                    "git clone reported success but {destination_text} is not a repository; ADE did not register or remove it"
                )),
            );
        }
        record["phase"] = json!("registering");
        record["head"] = json!(repo::head(&destination));
        record["branch"] = json!(repo::current_branch(&destination));
        self.repository_settle(id, Status::Acknowledged, &record)
            .with_context(|| {
                format!(
                    "Cloned into {destination_text} but the receipt could not be updated; it was not registered. Register it with workspace.open"
                )
            })?;
        let result = self.clone_register(&record, &destination);
        self.repository_finish(id, result)
    }

    fn repository_publish(self: &Arc<Self>, request: &Value) -> Result<Value> {
        const OP: &str = "repository.publish";
        let publish: RepositoryPublishRequest = decode(request)?;
        let id = operation_id(&publish.operation_id)?;
        let message = publish
            .commit_message
            .as_deref()
            .unwrap_or("Initial commit");
        ensure!(
            decide::valid_commit_message(message),
            "commit_message must be one line of at most 200 characters"
        );
        let input = publish_input(
            &publish.path,
            &publish.url,
            publish.remote.as_deref(),
            publish.initial_branch.as_deref(),
        )?;
        let _lease = self.worktrees.lease(&input.path)?;
        let _claim = Claim::acquire(&input.path, id)?;
        let admission = self.repository_peek(id, OP, request)?;
        if admission != Admission::New {
            return self.repository_replay(id, admission);
        }
        let facts = repo::publish_facts(&input.folder, &input.remote)?;
        let plan = repo::plan_publish(
            &facts,
            &input.url,
            &input.initial_branch,
            publish.create_initial_commit,
        );
        match plan.verdict {
            RepositoryPublishVerdict::Blocked => {
                bail!("Publish refused: {}", plan.blocked_reasons.join("; "))
            }
            RepositoryPublishVerdict::NeedsInitialCommit => bail!(
                "The folder has no commits. Pass create_initial_commit to commit every non-ignored file first"
            ),
            RepositoryPublishVerdict::Ready => {}
        }
        let branch = plan.branch.clone().context("Publish has no branch")?;
        let mut progress = Progress::default();
        let admission =
            self.repository_dispatch(id, OP, request, &progress.record(&input, &branch, "local"))?;
        if admission != Admission::New {
            return self.repository_replay(id, admission);
        }
        let folder = input.folder.as_path();
        let stop = |progress: &Progress, step: Step, failure: String, commit: Option<String>| {
            reply(&RepositoryPublished {
                tag: Default::default(),
                outcome: RepositoryPublishOutcome::NotPushed,
                path: input.path.clone(),
                remote: input.remote.clone(),
                url: input.url.clone(),
                branch: branch.clone(),
                initialized: progress.initialized,
                initial_commit: progress.initial_commit.clone(),
                remote_added: progress.remote_added,
                commit,
                pushed: false,
                failed_step: Some(step),
                failure: Some(failure),
                uncommitted_changes: uncommitted(folder),
            })
        };
        let local = |args: &[&str]| repo::git(folder, args, 60, false);
        if plan.runs(Step::Initialize) {
            let initial = format!("--initial-branch={branch}");
            let run = local(&["init", "--quiet", &initial]);
            if !run.ok() {
                let result = stop(&progress, Step::Initialize, run.failure("git init"), None);
                return self.repository_finish(id, result);
            }
            progress.initialized = true;
        }
        if plan.runs(Step::Commit) {
            let staged = local(&["add", "--all", "--", "."]);
            let run = if staged.ok() {
                local(&["commit", "--quiet", "-m", message])
            } else {
                staged
            };
            if !run.ok() {
                let result = stop(&progress, Step::Commit, run.failure("Initial commit"), None);
                return self.repository_finish(id, result);
            }
            progress.initial_commit = repo::head(folder);
        }
        if plan.runs(Step::AddRemote) {
            let run = local(&["remote", "add", &input.remote, &input.url]);
            if !run.ok() {
                let commit = repo::head(folder);
                let result = stop(
                    &progress,
                    Step::AddRemote,
                    run.failure("git remote add"),
                    commit,
                );
                return self.repository_finish(id, result);
            }
            progress.remote_added = true;
        }
        let Some(commit) = repo::head(folder) else {
            let result = stop(
                &progress,
                Step::Push,
                "The branch has no commit to push".into(),
                None,
            );
            return self.repository_finish(id, result);
        };
        self.repository_settle(
            id,
            Status::Acknowledged,
            &progress.record(&input, &branch, "pushing"),
        )
        .context("Publish stopped before pushing: its receipt could not be updated")?;
        let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
        let push = repo::git(
            folder,
            &[
                "push",
                "--porcelain",
                "--set-upstream",
                &input.remote,
                &refspec,
            ],
            PUSH_TIMEOUT,
            true,
        );
        let readback = repo::remote_has(folder, &input.remote, &branch, &commit);
        let settlement = decide::push_settlement(push.exit_code, readback.as_ref().ok().copied());
        if settlement == decide::PushSettlement::Unknown {
            // A killed push may have reached the remote; never report it as
            // not pushed, and never push again under this ID.
            let record = progress.record(&input, &branch, "pushing");
            self.repository_settle(id, Status::Unknown, &record)?;
            return Err(unknown(id, &record));
        }
        let result = match readback {
            Ok(true) => reply(&RepositoryPublished {
                tag: Default::default(),
                outcome: RepositoryPublishOutcome::Published,
                path: input.path.clone(),
                remote: input.remote.clone(),
                url: input.url.clone(),
                branch: branch.clone(),
                initialized: progress.initialized,
                initial_commit: progress.initial_commit.clone(),
                remote_added: progress.remote_added,
                commit: Some(commit),
                pushed: true,
                failed_step: None,
                failure: None,
                uncommitted_changes: uncommitted(folder),
            }),
            Ok(false) if push.ok() => stop(
                &progress,
                Step::Verify,
                format!("git push reported success, but the remote branch is not at {commit}"),
                Some(commit),
            ),
            Ok(false) => stop(
                &progress,
                Step::Push,
                push.failure("git push"),
                Some(commit),
            ),
            Err(error) if push.ok() => stop(
                &progress,
                Step::Verify,
                format!("git push reported success, but ADE could not confirm it: {error:#}"),
                Some(commit),
            ),
            Err(_) => stop(
                &progress,
                Step::Push,
                format!(
                    "{}. The remote branch could not be read back either",
                    push.failure("git push")
                ),
                Some(commit),
            ),
        };
        self.repository_finish(id, result)
    }
}

/// Uncommitted changes in `folder`; true when Git cannot say.
fn uncommitted(folder: &Path) -> bool {
    repo::git_ok(
        folder,
        &["status", "--porcelain", "--untracked-files=normal"],
    )
    .map(|status| !status.is_empty())
    .unwrap_or(true)
}

fn unknown(id: &str, record: &Value) -> anyhow::Error {
    let place = ["destination", "path"]
        .iter()
        .find_map(|key| record[*key].as_str())
        .map(|path| format!(" Inspect {path} before trying again."))
        .unwrap_or_default();
    anyhow!(
        "Operation {id} was interrupted while it was running Git; its outcome is unknown and it will not run again.{place}"
    )
}
