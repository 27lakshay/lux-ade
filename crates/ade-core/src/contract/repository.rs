//! Repository clone and publish contracts (F062, decision D08).
//!
//! ADE runs the system `git` with the user's own configuration and
//! credentials: credential helpers, SSH agent and keys. It calls no forge API,
//! creates no remote repository and never prompts; a remote that needs an
//! interactive login fails with Git's message.
//!
//! `repository.clone` clones a remote into a new folder and registers it as a
//! project. `repository.publish` initialises Git in a local folder when needed,
//! records an initial commit only when asked, adds the remote and pushes the
//! current branch without force. Both are effect commands. A failure after the
//! first change is a partial outcome that names exactly what was done:
//! cloned but not registered, or initialised but not pushed. Neither command
//! overwrites an existing folder, remote or remote branch.
use super::{FrameSpec, OperationSpec, Tier};
use crate::model::WorkspaceRecord;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<RepositoryCoverageRequest, RepositoryCoverage>(
            "repository.coverage",
            Tier::Query,
        ),
        OperationSpec::new::<RepositoryCloneRequest, RepositoryCloned>(
            "repository.clone",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<RepositoryPublishPreviewRequest, RepositoryPublishPreview>(
            "repository.publish.preview",
            Tier::Query,
        ),
        OperationSpec::new::<RepositoryPublishRequest, RepositoryPublished>(
            "repository.publish",
            Tier::EffectCommand,
        ),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![]
}

/// `repository.coverage`: the transports and forge behaviour ADE supports (D08).
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct RepositoryCoverageRequest {}

/// `repository.clone`: clone `url` into a new folder and register it as a project.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RepositoryCloneRequest {
    pub operation_id: String,
    /// An `https://`, `ssh://`, `user@host:path` or `file://` URL without a password.
    pub url: String,
    /// The absolute path of the folder to create. Its parent must exist and the
    /// path itself must not; ADE never clones into an existing path.
    pub destination: String,
    /// The branch to check out; the remote's default branch when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

/// `repository.publish.preview`: what `repository.publish` would do, or why it refuses.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RepositoryPublishPreviewRequest {
    /// The folder to publish; it must be a Git repository's top level or not
    /// belong to any repository.
    pub path: String,
    pub url: String,
    /// The remote to add or reuse; `origin` when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
    /// The branch a new repository starts on; `main` when absent. Ignored when
    /// the folder already has a current branch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_branch: Option<String>,
    /// Allows an initial commit of every non-ignored file when the repository
    /// has no commits yet.
    #[serde(default)]
    pub create_initial_commit: bool,
}

/// `repository.publish`: initialise if needed, add the remote and push the current branch.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RepositoryPublishRequest {
    pub operation_id: String,
    pub path: String,
    /// An `https://`, `ssh://`, `user@host:path` or `file://` URL without a
    /// password. The remote repository must already exist; ADE does not create it.
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_branch: Option<String>,
    /// Required when the repository has no commits: stage every non-ignored
    /// file and commit it with `commit_message`. Git's own author identity is used.
    #[serde(default)]
    pub create_initial_commit: bool,
    /// One line of at most 200 characters; `Initial commit` when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit_message: Option<String>,
}

wire_tag!(RepositoryCoverageTag, "repository_coverage");
wire_tag!(RepositoryClonedTag, "repository_cloned");
wire_tag!(RepositoryPublishPreviewTag, "repository_publish_preview");
wire_tag!(RepositoryPublishedTag, "repository_published");

/// A way of naming a Git remote.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RepositoryTransport {
    Https,
    Ssh,
    /// `user@host:path`, which Git runs over SSH.
    ScpLike,
    File,
    /// Unencrypted `http://`; refused.
    Http,
    /// The unauthenticated `git://` daemon protocol; refused.
    GitDaemon,
    /// `<helper>::<address>` remote helpers, including `ext::`; refused.
    RemoteHelper,
    /// A bare local path; refused in favour of `file://`.
    LocalPath,
}

/// Whether ADE accepts one transport, and why.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct TransportCoverage {
    pub transport: RepositoryTransport,
    pub supported: bool,
    pub example: String,
    pub note: String,
}

/// The `repository.coverage` reply: ordinary Git only, with named coverage (D08).
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct RepositoryCoverage {
    #[serde(rename = "type")]
    pub tag: RepositoryCoverageTag,
    pub transports: Vec<TransportCoverage>,
    /// Always false: no forge API is called.
    pub forge_apis: bool,
    /// How authentication happens.
    pub credentials: String,
    /// Work ADE does not do for clone or publish.
    pub excluded: Vec<String>,
}

/// How a clone ended.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RepositoryCloneOutcome {
    /// Cloned, verified and registered as a project.
    Registered,
    /// Cloned and verified, but registration failed. The clone stays in
    /// place; `workspace.open` on `destination` registers it.
    ClonedNotRegistered,
}

/// The `repository.clone` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct RepositoryCloned {
    #[serde(rename = "type")]
    pub tag: RepositoryClonedTag,
    pub outcome: RepositoryCloneOutcome,
    pub url: String,
    /// The canonical path of the new clone.
    pub destination: String,
    /// The checked-out commit; absent when the remote repository is empty.
    pub head: Option<String>,
    /// The checked-out branch; absent when HEAD is detached.
    pub branch: Option<String>,
    /// The registered project; absent when `outcome` is `cloned_not_registered`.
    pub workspace: Option<WorkspaceRecord>,
    pub registration_error: Option<String>,
}

/// One step `repository.publish` takes, in order.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RepositoryPublishStep {
    /// `git init` in a folder that is not a repository.
    Initialize,
    /// Stage every non-ignored file and record the first commit.
    Commit,
    /// Add the remote; skipped when it already names the same URL.
    AddRemote,
    /// Push the current branch without force and set its upstream.
    Push,
    /// Read the remote branch back and compare it with the pushed commit.
    Verify,
}

/// Whether publish may run.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RepositoryPublishVerdict {
    Ready,
    /// The repository has no commits; pass `create_initial_commit`.
    NeedsInitialCommit,
    Blocked,
}

/// The `repository.publish.preview` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct RepositoryPublishPreview {
    #[serde(rename = "type")]
    pub tag: RepositoryPublishPreviewTag,
    pub verdict: RepositoryPublishVerdict,
    /// The canonical folder.
    pub path: String,
    pub remote: String,
    /// The branch that would be pushed.
    pub branch: Option<String>,
    /// The steps publish would take, in order.
    pub steps: Vec<RepositoryPublishStep>,
    /// Uncommitted changes that publish would leave out of the push.
    pub uncommitted_changes: bool,
    pub blocked_reasons: Vec<String>,
}

/// How a publish ended.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RepositoryPublishOutcome {
    /// Pushed, and the remote branch was read back at the pushed commit.
    Published,
    /// Some local steps ran but nothing was confirmed on the remote. The
    /// fields say exactly which steps completed; `failed_step` says where it stopped.
    NotPushed,
}

/// The `repository.publish` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct RepositoryPublished {
    #[serde(rename = "type")]
    pub tag: RepositoryPublishedTag,
    pub outcome: RepositoryPublishOutcome,
    pub path: String,
    pub remote: String,
    pub url: String,
    pub branch: String,
    /// This publish ran `git init`.
    pub initialized: bool,
    /// The initial commit this publish recorded.
    pub initial_commit: Option<String>,
    /// This publish added the remote.
    pub remote_added: bool,
    /// The local commit that was, or would have been, pushed.
    pub commit: Option<String>,
    /// The remote branch was read back at `commit`.
    pub pushed: bool,
    pub failed_step: Option<RepositoryPublishStep>,
    pub failure: Option<String>,
    /// Uncommitted changes that were not part of the push.
    pub uncommitted_changes: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn publish_request_defaults_optional_fields() {
        let request: RepositoryPublishRequest = serde_json::from_value(json!({
            "operation_id": "op-1", "path": "/tmp/p", "url": "https://example.com/a.git"
        }))
        .unwrap();
        assert!(!request.create_initial_commit);
        assert_eq!(request.remote, None);
        assert_eq!(request.commit_message, None);
    }

    #[test]
    fn cloned_reply_uses_snake_case_outcome() {
        let reply = RepositoryCloned {
            tag: Default::default(),
            outcome: RepositoryCloneOutcome::ClonedNotRegistered,
            url: "https://example.com/a.git".into(),
            destination: "/tmp/a".into(),
            head: None,
            branch: None,
            workspace: None,
            registration_error: Some("fenced".into()),
        };
        let value = serde_json::to_value(&reply).unwrap();
        assert_eq!(value["type"], "repository_cloned");
        assert_eq!(value["outcome"], "cloned_not_registered");
    }
}
