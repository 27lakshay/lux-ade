//! Ordinary Git beyond single files (F075, D08): branch, stash, merge, fetch,
//! pull and push. Each runs the system `git` through the supervised worker
//! with the user's own configuration and credentials. None forces, rebases,
//! resets or deletes; Git's own refusals are reported with its message.
use super::{Git, decode, text};
use crate::worktrees;
use ade_core::contract::review::{
    ReviewBranchRequest, ReviewFetchRequest, ReviewMergeAction, ReviewMergeRequest,
    ReviewPullRequest, ReviewPushRequest, ReviewStashAction, ReviewStashRequest,
};
use anyhow::{Result, bail, ensure};
use serde_json::{Value, json};

/// Local Git steps: seconds.
const LOCAL_TIMEOUT: u64 = 120;
/// Fetch, pull and push: seconds.
const REMOTE_TIMEOUT: u64 = 10 * 60;

/// A decoded branch, stash, merge, fetch, pull or push request.
pub(super) enum SyncRequest {
    Branch(ReviewBranchRequest),
    Stash(ReviewStashRequest),
    Merge(ReviewMergeRequest),
    Fetch(ReviewFetchRequest),
    Pull(ReviewPullRequest),
    Push(ReviewPushRequest),
}

impl SyncRequest {
    pub(super) fn handles(op: &str) -> bool {
        matches!(
            op,
            "review.branch"
                | "review.stash"
                | "review.merge"
                | "review.fetch"
                | "review.pull"
                | "review.push"
        )
    }

    pub(super) fn decode(op: &str, request: &Value) -> Result<Self> {
        Ok(match op {
            "review.branch" => Self::Branch(decode(request)?),
            "review.stash" => Self::Stash(decode(request)?),
            "review.merge" => Self::Merge(decode(request)?),
            "review.fetch" => Self::Fetch(decode(request)?),
            "review.pull" => Self::Pull(decode(request)?),
            "review.push" => Self::Push(decode(request)?),
            _ => bail!("Unknown review operation"),
        })
    }

    pub(super) fn op(&self) -> &'static str {
        match self {
            Self::Branch(_) => "review.branch",
            Self::Stash(_) => "review.stash",
            Self::Merge(_) => "review.merge",
            Self::Fetch(_) => "review.fetch",
            Self::Pull(_) => "review.pull",
            Self::Push(_) => "review.push",
        }
    }

    pub(super) fn id(&self) -> &str {
        match self {
            Self::Branch(request) => &request.operation_id,
            Self::Stash(request) => &request.operation_id,
            Self::Merge(request) => &request.operation_id,
            Self::Fetch(request) => &request.operation_id,
            Self::Pull(request) => &request.operation_id,
            Self::Push(request) => &request.operation_id,
        }
    }

    pub(super) fn payload(&self) -> Result<Value> {
        Ok(match self {
            Self::Branch(request) => serde_json::to_value(request)?,
            Self::Stash(request) => serde_json::to_value(request)?,
            Self::Merge(request) => serde_json::to_value(request)?,
            Self::Fetch(request) => serde_json::to_value(request)?,
            Self::Pull(request) => serde_json::to_value(request)?,
            Self::Push(request) => serde_json::to_value(request)?,
        })
    }
}

/// A Git step that stopped and left state for the person to resolve, such as
/// merge conflicts. `detail` becomes the failed receipt's `result`.
#[derive(Debug)]
pub(super) struct GitStopped {
    pub message: String,
    pub detail: Value,
}

impl std::fmt::Display for GitStopped {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for GitStopped {}

/// Git's own reason for a failed run, bounded; rebind and unknown outcomes
/// keep their typed errors.
fn checked(out: &Value, action: &str) -> Result<String> {
    match out["exit_code"].as_i64() {
        Some(0) => Ok(out["stdout"].as_str().unwrap_or_default().to_owned()),
        Some(86) | None => worktrees::successful(out).map(str::to_owned),
        Some(code) => {
            let message: String = out["stderr"]
                .as_str()
                .unwrap_or_default()
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .collect::<Vec<_>>()
                .join("; ")
                .chars()
                .take(2000)
                .collect();
            if message.is_empty() {
                bail!("{action} failed with exit code {code}")
            }
            bail!("{action} failed: {message}")
        }
    }
}

impl Git<'_> {
    fn local(&self, args: &[&str], action: &str) -> Result<String> {
        checked(&self.run(args, None, LOCAL_TIMEOUT)?, action)
    }

    fn remote(&self, args: &[&str], action: &str) -> Result<String> {
        checked(&self.run_remote(args, REMOTE_TIMEOUT)?, action)
    }

    /// Whether a quiet `rev-parse --verify` finds `name`.
    fn resolves(&self, name: &str) -> Result<Option<String>> {
        let out = self.run(
            &["rev-parse", "--verify", "--quiet", name],
            None,
            LOCAL_TIMEOUT,
        )?;
        Ok(match out["exit_code"].as_i64() {
            Some(0) => out["stdout"].as_str().map(|s| s.trim().to_owned()),
            Some(1) => None,
            _ => Some(checked(&out, "git rev-parse")?.trim().to_owned()),
        })
    }

    fn head(&self) -> Result<Option<String>> {
        self.resolves("HEAD^{commit}")
    }

    fn config(&self, key: &str) -> Result<Option<String>> {
        let out = self.run(&["config", "--get", key], None, LOCAL_TIMEOUT)?;
        Ok(match out["exit_code"].as_i64() {
            Some(0) => out["stdout"].as_str().map(|s| s.trim().to_owned()),
            Some(1) => None,
            _ => Some(checked(&out, "git config")?.trim().to_owned()),
        })
    }

    /// The configured remote names.
    fn remotes(&self) -> Result<Vec<String>> {
        Ok(self
            .local(&["remote"], "git remote")?
            .lines()
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect())
    }

    /// The branch's upstream: remote name and remote ref.
    fn upstream(&self, branch: &str) -> Result<Option<(String, String)>> {
        let remote = self.config(&format!("branch.{branch}.remote"))?;
        let merge = self.config(&format!("branch.{branch}.merge"))?;
        Ok(remote.zip(merge).filter(|(remote, _)| remote != "."))
    }

    fn conflicts(&self) -> Result<Vec<String>> {
        let state = self.status()?;
        Ok(state["files"]
            .as_array()
            .map(|files| {
                files
                    .iter()
                    .filter(|file| file["conflict"] == true)
                    .filter_map(|file| file["path"].as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default())
    }
}

fn reviewed_index(state: &Value, token: &str) -> Result<()> {
    ensure!(
        state["index_token"] == token,
        "HEAD, branch or staged changes moved since review; refresh before continuing"
    );
    Ok(())
}

fn current_branch(state: &Value) -> Result<String> {
    let branch = state["branch"].as_str().unwrap_or_default();
    ensure!(
        !branch.is_empty() && branch != "(detached)",
        "HEAD is detached; switch to a branch first"
    );
    Ok(branch.to_owned())
}

/// A configured remote name, never a URL or an option.
fn known_remote(git: &Git, remote: &str) -> Result<String> {
    let remote = text("remote", remote)?;
    ensure!(
        !remote.starts_with('-') && git.remotes()?.iter().any(|name| name == remote),
        "Unknown remote {remote}; use a configured remote name"
    );
    Ok(remote.to_owned())
}

fn branch_name(git: &Git, name: &str) -> Result<String> {
    let name = text("name", name)?;
    ensure!(
        !name.starts_with('-')
            && git.run(&["check-ref-format", "--branch", name], None, LOCAL_TIMEOUT)?["exit_code"]
                == 0,
        "Invalid branch name"
    );
    Ok(name.to_owned())
}

fn remote_ref_name(merge: &str) -> &str {
    merge.strip_prefix("refs/heads/").unwrap_or(merge)
}

pub(super) fn run(git: &Git, state: &Value, request: &SyncRequest) -> Result<Value> {
    match request {
        SyncRequest::Branch(request) => branch(git, state, request),
        SyncRequest::Stash(request) => stash(git, state, request),
        SyncRequest::Merge(request) => merge(git, state, request),
        SyncRequest::Fetch(request) => fetch(git, state, request),
        SyncRequest::Pull(request) => pull(git, state, request),
        SyncRequest::Push(request) => push(git, state, request),
    }
}

fn branch(git: &Git, state: &Value, request: &ReviewBranchRequest) -> Result<Value> {
    reviewed_index(state, &request.index_token)?;
    ensure!(
        request.create || request.switch,
        "Choose create, switch or both"
    );
    let name = branch_name(git, &request.name)?;
    let exists = git.resolves(&format!("refs/heads/{name}"))?.is_some();
    if request.create {
        ensure!(!exists, "Branch {name} already exists");
        ensure!(git.head()?.is_some(), "Commit before creating a branch");
    } else {
        ensure!(exists, "Branch {name} does not exist");
    }
    match (request.create, request.switch) {
        (true, true) => git.local(&["switch", "--quiet", "-c", &name], "git switch")?,
        (true, false) => git.local(&["branch", "--no-track", &name], "git branch")?,
        _ => git.local(&["switch", "--quiet", "--no-guess", &name], "git switch")?,
    };
    let after = git.status()?;
    Ok(json!({
        "action": "branch", "name": name, "created": request.create,
        "branch": after["branch"], "head": git.head()?,
    }))
}

fn stash(git: &Git, state: &Value, request: &ReviewStashRequest) -> Result<Value> {
    ensure!(
        state["revision"] == request.revision.as_str(),
        "Changes moved since review; refresh before stashing"
    );
    ensure!(
        state["conflicts"] == 0,
        "Resolve conflicting files before stashing"
    );
    match request.action {
        ReviewStashAction::Push => {
            let files = state["files"].as_array().cloned().unwrap_or_default();
            ensure!(
                files
                    .iter()
                    .any(|file| request.include_untracked || file["untracked"] != true),
                "There are no changes to stash"
            );
            ensure!(git.head()?.is_some(), "Commit before stashing");
            let mut args = vec!["stash", "push", "--quiet"];
            if request.include_untracked {
                args.push("--include-untracked");
            }
            let message;
            if let Some(text_value) = &request.message {
                message = text("message", text_value)?.to_owned();
                args.extend(["--message", &message]);
            }
            // Stash passes Git's own `:/` pathspec to its internal clean of
            // untracked files; literal pathspecs would make that clean a
            // no-op and leave saved files behind. No user path is passed here.
            let mut command = git.worker_command(&args)?;
            command.env("GIT_LITERAL_PATHSPECS", "0");
            checked(
                &worktrees::run_input(command, LOCAL_TIMEOUT, Some(&git.guard.file), None)?,
                "git stash push",
            )?;
            Ok(json!({
                "action": "stash_push", "stash": git.resolves("refs/stash")?,
                "branch": state["branch"], "head": git.head()?,
            }))
        }
        ReviewStashAction::Pop => {
            ensure!(
                request.message.is_none() && !request.include_untracked,
                "Pop takes no message or untracked option"
            );
            let stash = git
                .resolves("refs/stash")?
                .ok_or_else(|| anyhow::anyhow!("There is no stash to pop"))?;
            let out = git.run(&["stash", "pop", "--quiet"], None, LOCAL_TIMEOUT)?;
            if out["exit_code"] != 0 {
                let conflicts = git.conflicts()?;
                if !conflicts.is_empty() {
                    return Err(GitStopped {
                        message: format!(
                            "Stash pop stopped with conflicts in {} file(s); the stash was kept. Resolve and stage them",
                            conflicts.len()
                        ),
                        detail: json!({"action": "stash_pop", "stash": stash, "conflicts": conflicts}),
                    }
                    .into());
                }
                checked(&out, "git stash pop")?;
            }
            Ok(json!({
                "action": "stash_pop", "stash": stash,
                "branch": state["branch"], "head": git.head()?,
            }))
        }
    }
}

fn merge(git: &Git, state: &Value, request: &ReviewMergeRequest) -> Result<Value> {
    reviewed_index(state, &request.index_token)?;
    let merging = git.resolves("MERGE_HEAD")?;
    match request.action {
        ReviewMergeAction::Abort => {
            ensure!(request.target.is_none(), "Abort takes no target");
            ensure!(merging.is_some(), "No merge is in progress");
            git.local(&["merge", "--abort"], "git merge --abort")?;
            Ok(json!({"action": "merge_abort", "branch": state["branch"], "head": git.head()?}))
        }
        ReviewMergeAction::Merge => {
            let branch = current_branch(state)?;
            let target = text(
                "target",
                request
                    .target
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("Missing or invalid target"))?,
            )?;
            ensure!(!target.starts_with('-'), "Invalid merge target");
            ensure!(merging.is_none(), "A merge is already in progress");
            ensure!(
                state["conflicts"] == 0,
                "Resolve conflicting files before merging"
            );
            let before = git
                .head()?
                .ok_or_else(|| anyhow::anyhow!("Commit before merging"))?;
            let commit = git
                .resolves(&format!("{target}^{{commit}}"))?
                .ok_or_else(|| anyhow::anyhow!("Unknown merge target {target}"))?;
            let out = git.run(&["merge", "--no-edit", target], None, LOCAL_TIMEOUT)?;
            if out["exit_code"] != 0 {
                let conflicts = git.conflicts()?;
                if !conflicts.is_empty() {
                    return Err(GitStopped {
                        message: format!(
                            "Merge stopped with conflicts in {} file(s). Resolve, stage and commit them, or abort the merge",
                            conflicts.len()
                        ),
                        detail: json!({"action": "merge", "target": target, "target_commit": commit,
                            "branch": branch, "head": before, "conflicts": conflicts}),
                    }
                    .into());
                }
                checked(&out, "git merge")?;
            }
            let head = git.head()?;
            Ok(json!({
                "action": "merge", "target": target, "target_commit": commit, "branch": branch,
                "before": before, "head": head,
                "fast_forward": head.as_deref() == Some(commit.as_str()) && commit != before,
            }))
        }
    }
}

/// `refname objectname` lines under one remote's tracking refs. Symbolic
/// refs such as `origin/HEAD` follow their target and are left out.
fn tracking(git: &Git, remote: &str) -> Result<Vec<String>> {
    Ok(git
        .local(
            &[
                "for-each-ref",
                "--format=%(if)%(symref)%(then)%(else)%(refname) %(objectname)%(end)",
                &format!("refs/remotes/{remote}/"),
            ],
            "git for-each-ref",
        )?
        .lines()
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect())
}

fn fetch(git: &Git, state: &Value, request: &ReviewFetchRequest) -> Result<Value> {
    let remote = match &request.remote {
        Some(remote) => known_remote(git, remote)?,
        None => {
            let upstream = match state["branch"].as_str() {
                Some(branch) if branch != "(detached)" => git.upstream(branch)?,
                _ => None,
            };
            known_remote(
                git,
                upstream
                    .as_ref()
                    .map_or("origin", |(remote, _)| remote.as_str()),
            )?
        }
    };
    let before = tracking(git, &remote)?;
    git.remote(&["fetch", "--quiet", &remote], "git fetch")?;
    let after = tracking(git, &remote)?;
    let updated: Vec<&str> = after
        .iter()
        .filter(|line| !before.contains(line))
        .filter_map(|line| line.split(' ').next())
        .collect();
    Ok(json!({"action": "fetch", "remote": remote, "updated": updated, "head": git.head()?}))
}

fn pull(git: &Git, state: &Value, request: &ReviewPullRequest) -> Result<Value> {
    reviewed_index(state, &request.index_token)?;
    let branch = current_branch(state)?;
    let (remote, merge) = git.upstream(&branch)?.ok_or_else(|| {
        anyhow::anyhow!("Branch {branch} has no upstream; push it to a remote first")
    })?;
    let remote = known_remote(git, &remote)?;
    let before = git.head()?;
    git.remote(
        &[
            "pull",
            "--ff-only",
            "--no-rebase",
            "--quiet",
            &remote,
            &merge,
        ],
        "git pull",
    )?;
    let head = git.head()?;
    Ok(json!({
        "action": "pull", "branch": branch, "remote": remote,
        "upstream": format!("{remote}/{}", remote_ref_name(&merge)),
        "before": before, "head": head, "fast_forward": before != head,
    }))
}

fn push(git: &Git, state: &Value, request: &ReviewPushRequest) -> Result<Value> {
    reviewed_index(state, &request.index_token)?;
    let branch = current_branch(state)?;
    let head = git
        .head()?
        .ok_or_else(|| anyhow::anyhow!("Commit before pushing"))?;
    let upstream = git.upstream(&branch)?;
    let (remote, destination, set_upstream) = match (&request.remote, &upstream) {
        (Some(remote), Some((configured, merge))) if remote == configured => {
            (known_remote(git, remote)?, merge.clone(), false)
        }
        (Some(remote), upstream) => (
            known_remote(git, remote)?,
            format!("refs/heads/{branch}"),
            upstream.is_none(),
        ),
        (None, Some((remote, merge))) => (known_remote(git, remote)?, merge.clone(), false),
        (None, None) => bail!("Branch {branch} has no upstream; choose a remote to push to"),
    };
    ensure!(
        destination.starts_with("refs/heads/"),
        "Upstream {destination} is not a branch"
    );
    // Never forced: Git rejects a push that would drop remote commits.
    git.remote(
        &["push", "--quiet", &remote, &format!("HEAD:{destination}")],
        "git push",
    )?;
    if set_upstream {
        git.local(
            &["config", &format!("branch.{branch}.remote"), &remote],
            "git config",
        )?;
        git.local(
            &["config", &format!("branch.{branch}.merge"), &destination],
            "git config",
        )?;
    }
    // Read the remote branch back so success means the remote has the commit.
    let remote_head = git.remote(&["ls-remote", &remote, &destination], "git ls-remote")?;
    let verified = remote_head
        .lines()
        .any(|line| line.split('\t').next() == Some(head.as_str()));
    ensure!(
        verified,
        "Push finished but {remote} does not show {destination} at {head}; fetch to inspect it"
    );
    Ok(json!({
        "action": "push", "branch": branch, "remote": remote,
        "remote_ref": destination, "head": head, "verified": verified,
        "upstream_set": set_upstream,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failures_carry_git_message_and_keep_unknown_outcomes_typed() {
        let failed = json!({"exit_code": 1, "stdout": "", "stderr": "error: rejected\n hint: fetch first\n"});
        assert_eq!(
            checked(&failed, "git push").unwrap_err().to_string(),
            "git push failed: error: rejected; hint: fetch first"
        );
        let silent = json!({"exit_code": 128, "stdout": "", "stderr": ""});
        assert_eq!(
            checked(&silent, "git fetch").unwrap_err().to_string(),
            "git fetch failed with exit code 128"
        );
        let unknown = json!({"exit_code": null, "stdout": "", "stderr": ""});
        assert!(
            checked(&unknown, "git push")
                .unwrap_err()
                .downcast_ref::<ade_core::error::LifecycleFailure>()
                .is_some()
        );
        assert_eq!(
            checked(&json!({"exit_code": 0, "stdout": "x"}), "git").unwrap(),
            "x"
        );
    }

    #[test]
    fn upstream_names_drop_the_heads_prefix() {
        assert_eq!(remote_ref_name("refs/heads/main"), "main");
        assert_eq!(remote_ref_name("main"), "main");
    }
}
