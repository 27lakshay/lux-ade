//! Worktree lifecycle contracts: repository registration, linked-tree listing,
//! switch, create, setup, adopt, remove, cleanup, refresh, configuration,
//! operation receipts, archive records, rebind, carrying uncommitted changes
//! between trees and ignored-resource rules.
//!
//! Effect commands carry `operation_id`. Replies describe exactly what the
//! lifecycle daemon sends.
use super::{FrameSpec, OperationSpec, Tier};
use crate::worktrees::{Config, Hook, ResourceMode, ResourceRule};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn operations() -> Vec<OperationSpec> {
    vec![
        OperationSpec::new::<WorktreeRepositoryRequest, WorktreeState>(
            "worktree.repository",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<WorktreeGetRequest, WorktreeState>("worktree.get", Tier::Query),
        OperationSpec::new::<WorktreeSwitchRequest, WorktreeState>(
            "worktree.switch",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<WorktreeAdoptRequest, WorktreeState>(
            "worktree.adopt",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<WorktreeRemoveRequest, WorktreeState>(
            "worktree.remove",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<WorktreeRefreshRequest, WorktreeState>(
            "worktree.refresh",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<WorktreeConfigureRequest, WorktreeState>(
            "worktree.configure",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<WorktreeOperationRequest, WorktreeOperationReply>(
            "worktree.operation",
            Tier::Query,
        ),
        OperationSpec::new::<WorktreeRebindRequest, WorktreeState>(
            "worktree.rebind",
            Tier::IdempotentCommand,
        ),
        OperationSpec::new::<WorktreeRebindListRequest, WorktreeRebindCatalog>(
            "worktree.rebind.list",
            Tier::Query,
        ),
        OperationSpec::new::<WorktreeCreateRequest, WorktreeState>(
            "worktree.create",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<WorktreeSetupRequest, WorktreeState>(
            "worktree.setup",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<WorktreeCleanupPlanRequest, WorktreeCleanupPlan>(
            "worktree.cleanup.plan",
            Tier::Query,
        ),
        OperationSpec::new::<WorktreeCleanupRequest, WorktreeState>(
            "worktree.cleanup",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<WorktreeArchivedRequest, WorktreeArchive>(
            "worktree.archived",
            Tier::Query,
        ),
        OperationSpec::new::<WorktreeCarryPreviewRequest, WorktreeCarryPreview>(
            "worktree.carry.preview",
            Tier::Query,
        ),
        OperationSpec::new::<WorktreeCarryRequest, WorktreeState>(
            "worktree.carry",
            Tier::EffectCommand,
        ),
        OperationSpec::new::<WorktreeResourcesApplyRequest, WorktreeState>(
            "worktree.resources.apply",
            Tier::EffectCommand,
        ),
    ]
}

pub fn frames() -> Vec<FrameSpec> {
    vec![]
}

/// `worktree.repository`: register the Git repository containing `path`, or
/// return the one already registered for its common directory.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeRepositoryRequest {
    pub path: String,
}

/// `worktree.get`: read a registered repository's lifecycle state.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeGetRequest {
    pub project_id: String,
}

/// `worktree.switch`: check out `target` in a linked tree, creating the branch
/// when `create` is true.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeSwitchRequest {
    pub project_id: String,
    /// Caller-owned operation ID.
    pub operation_id: String,
    /// A branch name, or the path of an existing linked tree.
    pub target: String,
    /// Start point for a new branch; the daemon uses `HEAD` when it is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    /// Absolute path for a new tree, directly inside the configured directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create: Option<bool>,
}

/// `worktree.adopt`: take ADE removal authority over an existing linked tree.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeAdoptRequest {
    /// The caller's operation ID. The daemon keeps a receipt under it: a
    /// retry with the same ID and payload returns the recorded outcome, and
    /// the same ID with another payload is a conflict.
    pub operation_id: String,
    pub project_id: String,
    pub path: String,
    /// Must equal the canonical form of `path`. Optional in Rust only so a
    /// missing value keeps the daemon's own error message.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(required)]
    pub confirm_path: Option<String>,
}

/// What `worktree.remove` does with the removed tree's branch.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BranchPolicy {
    Keep,
    /// Delete the branch only if Git reports it merged.
    Merged,
}

/// `worktree.remove`: remove a clean ADE-owned linked tree.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeRemoveRequest {
    pub project_id: String,
    /// Caller-owned operation ID.
    pub operation_id: String,
    pub path: String,
    /// Branch policy; the daemon uses `keep` when it is absent. The daemon
    /// reads the raw string so an unknown policy keeps its own error message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Option<BranchPolicy>")]
    pub delete_branch: Option<String>,
    /// Forced removal is unavailable; `true` is rejected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_path: Option<String>,
}

/// `worktree.refresh`: re-read the Git worktree listing under the repository lock.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeRefreshRequest {
    pub project_id: String,
    /// Caller-owned operation ID.
    pub operation_id: String,
}

/// `worktree.configure`: replace a repository's lifecycle configuration.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeConfigureRequest {
    pub project_id: String,
    pub config: WorktreeConfigInput,
}

/// The configuration a caller sends. Absent fields take their defaults; the
/// stored form is [`Config`].
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(default, deny_unknown_fields)]
pub struct WorktreeConfigInput {
    /// Parent directory for new trees; the repository's parent when absent.
    pub directory: Option<String>,
    /// Git command timeout; the daemon accepts 5 to 300.
    pub timeout_seconds: u64,
    /// Prefix for branches `worktree.create` names: letters, digits, `.`,
    /// `_`, `-` and `/`, at most 64 bytes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_prefix: Option<String>,
    /// Start point for `worktree.create` when the request names none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_base: Option<String>,
    /// Setup hooks, at most 8, run in order inside each tree ADE creates.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub setup: Vec<Hook>,
    /// Teardown hooks, at most 8, run in order before ADE removes a tree.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub teardown: Vec<Hook>,
    /// Ignored-resource rules, at most 64, applied in each tree ADE creates
    /// before its setup hooks.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub resources: Vec<ResourceRule>,
}

impl Default for WorktreeConfigInput {
    fn default() -> Self {
        let Config {
            directory,
            timeout_seconds,
            branch_prefix,
            default_base,
            setup,
            teardown,
            resources,
        } = Config::default();
        Self {
            directory,
            timeout_seconds,
            branch_prefix,
            default_base,
            setup,
            teardown,
            resources,
        }
    }
}

impl From<WorktreeConfigInput> for Config {
    fn from(input: WorktreeConfigInput) -> Self {
        Self {
            directory: input.directory,
            timeout_seconds: input.timeout_seconds,
            branch_prefix: input.branch_prefix,
            default_base: input.default_base,
            setup: input.setup,
            teardown: input.teardown,
            resources: input.resources,
        }
    }
}

/// `worktree.create`: create a branch and a linked tree from the repository's
/// naming defaults, then run its setup hooks. With neither `name` nor
/// `branch`, the daemon generates the first free `wt-N` name.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeCreateRequest {
    pub project_id: String,
    /// Caller-owned operation ID.
    pub operation_id: String,
    /// A workspace name; the branch is the configured prefix plus its slug.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// An exact branch name, used without the prefix. Conflicts with `name`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// Start point; the configured `default_base`, then `HEAD`, when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    /// Absolute path for the tree, directly inside the configured directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Start from a ref fetched from a configured remote, such as a pull
    /// request head. Conflicts with `base`. Only the fetch is performed; ADE
    /// adds no pull-request workflow.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fetch: Option<WorktreeFetchSource>,
}

/// A ref to fetch from a configured remote into `refs/ade/fetched/…`. The
/// new branch starts at the fetched commit.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WorktreeFetchSource {
    /// A remote name from `git remote`; URLs are refused.
    pub remote: String,
    /// A full ref on the remote, such as `refs/pull/12/head` or
    /// `refs/merge-requests/12/head`.
    #[serde(rename = "ref")]
    pub reference: String,
}

/// `worktree.setup`: run the setup hooks again in an ADE-owned tree, such as
/// one whose setup failed or was interrupted. Only a full success makes it ready.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeSetupRequest {
    pub project_id: String,
    /// Caller-owned operation ID.
    pub operation_id: String,
    pub path: String,
}

/// `worktree.cleanup.plan`: classify every linked tree for cleanup without
/// changing anything.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeCleanupPlanRequest {
    pub project_id: String,
}

/// `worktree.cleanup`: run teardown hooks, remove and archive the named
/// trees. Each tree is classified again before its exclusive removal claim;
/// a blocked tree is skipped, never forced.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeCleanupRequest {
    pub project_id: String,
    /// Caller-owned operation ID.
    pub operation_id: String,
    /// One to 32 tree paths, each from `worktree.cleanup.plan`.
    pub paths: Vec<String>,
    /// Branch policy for every removed tree; `keep` when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delete_branch: Option<BranchPolicy>,
}

/// `worktree.archived`: list the archive records of removed trees.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeArchivedRequest {
    pub project_id: String,
}

/// `worktree.operation`: read one lifecycle operation receipt in full.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeOperationRequest {
    pub project_id: String,
    /// The operation's ID.
    pub operation_id: String,
}

/// `worktree.carry.preview`: list a tree's uncommitted changes and whether
/// each can be carried. Changes nothing.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeCarryPreviewRequest {
    pub project_id: String,
    /// The tree whose changes would move: the primary checkout or a linked tree.
    pub source: String,
    /// Paths relative to the tree root to select; every change when absent.
    /// A directory selects the changes beneath it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paths: Option<Vec<String>>,
}

/// `worktree.carry`: move uncommitted changes from `source` into the clean,
/// ADE-owned tree `target`. The changes are first saved as a commit under
/// `refs/ade/carry/…`, which ADE never deletes, then applied to the target
/// and verified. The source is cleaned only when `clean_source` is true, the
/// target verified exactly, and the source is unchanged since the snapshot.
/// A failure never discards anything.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeCarryRequest {
    pub project_id: String,
    /// Caller-owned operation ID.
    pub operation_id: String,
    pub source: String,
    pub target: String,
    /// As in `worktree.carry.preview`; every change when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paths: Option<Vec<String>>,
    /// The source `HEAD` the caller previewed; a different `HEAD` refuses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expect_head: Option<String>,
    /// Remove the carried changes from the source after verification.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clean_source: Option<bool>,
}

/// `worktree.resources.apply`: apply the repository's ignored-resource rules
/// to an ADE-owned tree, such as an adopted one. Existing files are never
/// replaced.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeResourcesApplyRequest {
    pub project_id: String,
    /// Caller-owned operation ID.
    pub operation_id: String,
    pub path: String,
}

/// `worktree.rebind`: bind a restored lifecycle repository to a verified checkout.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeRebindRequest {
    pub project_id: String,
    pub path: String,
}

/// `worktree.rebind.list`: list lifecycle repositories and whether each needs a rebind.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default)]
pub struct WorktreeRebindListRequest {}

wire_tag!(WorktreeStateTag, "worktree_state");
wire_tag!(WorktreeOperationTag, "worktree_operation");
wire_tag!(WorktreeRebindCatalogTag, "worktree_rebind_catalog");
wire_tag!(WorktreeCleanupPlanTag, "worktree_cleanup_plan");
wire_tag!(WorktreeArchiveTag, "worktree_archive");
wire_tag!(WorktreeCarryPreviewTag, "worktree_carry_preview");

/// A repository's lifecycle state: the reply to every command except
/// `worktree.operation` and `worktree.rebind.list`.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeState {
    #[serde(rename = "type")]
    pub tag: WorktreeStateTag,
    pub repository: WorktreeRepository,
    /// The cached Git listing, primary checkout first.
    pub worktrees: Vec<WorktreeItem>,
    /// Whether a lifecycle or review operation holds the repository.
    pub busy: bool,
    /// The newest 100 operations, newest first, without command output.
    pub operations: Vec<WorktreeOperation>,
}

/// A registered lifecycle repository. Device and inode identities are decimal strings.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeRepository {
    pub id: String,
    /// The primary checkout, where lifecycle commands run.
    pub root: String,
    pub common_dir: String,
    /// The common directory before the first rebind.
    pub source_common_dir: Option<String>,
    pub root_device: Option<String>,
    pub root_inode: Option<String>,
    pub source_root_device: Option<String>,
    pub source_root_inode: Option<String>,
    pub common_device: Option<String>,
    pub common_inode: Option<String>,
    pub source_common_device: Option<String>,
    pub source_common_inode: Option<String>,
    pub needs_rebind: bool,
    pub binding_generation: i64,
    pub config: Config,
    pub refreshed_at: Option<i64>,
}

/// Whether a tree is ready for an Agent, from its latest `worktree.switch`.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SetupState {
    Ready,
    Preparing,
    Interrupted,
    Failed,
}

/// One entry of `git worktree list`, with ADE's ownership and setup state.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeItem {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detached: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bare: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lock_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prunable: Option<bool>,
    /// Whether ADE holds removal authority over this tree.
    pub ade_owned: bool,
    pub setup_state: SetupState,
    /// The tree's lifecycle phase, for trees ADE created or ran hooks in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<WorktreePhase>,
}

/// Where a tree stands in ADE's setup and teardown lifecycle. Only `ready`
/// admits an Agent.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorktreePhase {
    /// Names are recorded and Git is creating the tree.
    Creating,
    /// Setup hooks are running.
    SettingUp,
    Ready,
    /// A setup hook failed or timed out. The tree is kept; retry `worktree.setup`.
    SetupFailed,
    /// Setup stopped with an unknown outcome. Inspect the tree before retrying.
    SetupInterrupted,
    /// Teardown hooks or the removal are running.
    TearingDown,
    /// A teardown hook failed or timed out. The tree is kept.
    TeardownFailed,
    /// Teardown or removal stopped with an unknown outcome.
    TeardownInterrupted,
}

/// Whether a hook ran as a setup or a teardown hook.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HookPhase {
    Setup,
    Teardown,
}

/// How one hook run ended.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HookVerdict {
    Succeeded,
    /// Exited with a non-zero status, or could not start.
    Failed,
    /// Killed at its time limit; descendants that left its process group may
    /// still run.
    TimedOut,
    /// Its output pipes stayed open after it exited, or its state could not
    /// be read; descendants may still run.
    Unknown,
}

/// One hook run, as recorded in an operation's `result.hooks` or in a
/// cleanup tree's `hooks`.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeHookRun {
    pub name: String,
    pub phase: HookPhase,
    pub verdict: HookVerdict,
    pub exit_code: Option<i32>,
    pub elapsed_ms: u64,
    /// The last 64 KiB of stdout, then of stderr. `worktree_state` omits it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    /// Whether earlier output was dropped.
    pub truncated: bool,
}

/// Why a tree cannot be cleaned up now.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CleanupBlocker {
    /// The repository's primary checkout is never removed.
    PrimaryCheckout,
    /// ADE has no removal authority; adopt the tree first.
    External,
    /// The ownership marker no longer matches.
    AuthorityChanged,
    Locked,
    /// Git reports the tree missing or prunable.
    Unavailable,
    /// Uncommitted or untracked files.
    Dirty,
    /// Git status could not be read.
    StatusUnknown,
    /// A terminal, Agent, service or script of this profile uses the tree.
    ActiveWork,
    /// Another claim, possibly another profile's, holds the tree.
    ClaimHeld,
    /// A quarantined claim marks the tree's execution ownership uncertain.
    ClaimUncertain,
    /// The host resource registry cannot confirm claims.
    RegistryUnavailable,
    /// Another lifecycle operation runs in this repository.
    LifecycleRunning,
    /// Setup failed or was interrupted; recover with `worktree.setup` or an
    /// explicit `worktree.remove`.
    SetupIncomplete,
    /// Teardown failed or was interrupted; recover with an explicit `worktree.remove`.
    TeardownIncomplete,
    /// Git's listing does not contain the path.
    NotListed,
}

/// One linked tree's cleanup classification.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeCleanupCandidate {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<WorktreePhase>,
    /// True only when `blockers` is empty.
    pub eligible: bool,
    pub blockers: Vec<CleanupBlocker>,
}

/// The `worktree.cleanup.plan` reply: every linked tree, primary excluded.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeCleanupPlan {
    #[serde(rename = "type")]
    pub tag: WorktreeCleanupPlanTag,
    pub project_id: String,
    pub trees: Vec<WorktreeCleanupCandidate>,
}

/// What `worktree.cleanup` did with one tree.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CleanupOutcome {
    /// Teardown ran, the tree was removed and an archive record was written.
    Archived,
    /// A blocker kept the tree; nothing ran.
    Skipped,
    /// Teardown or removal failed; the tree is kept. See `error`.
    Failed,
    /// The outcome could not be confirmed; the removal claim stays quarantined.
    Unknown,
}

/// One tree in a cleanup operation's `result.trees`.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeCleanupTree {
    pub path: String,
    pub outcome: CleanupOutcome,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blockers: Vec<CleanupBlocker>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hooks: Vec<WorktreeHookRun>,
    /// Whether the merged branch was deleted, when the policy asked for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_deleted: Option<bool>,
}

/// The record ADE keeps for a tree it removed. The branch, unless deleted,
/// is the way back to the work.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeArchiveEntry {
    pub path: String,
    pub branch: Option<String>,
    /// The commit the tree had checked out when it was removed.
    pub head: Option<String>,
    pub branch_deleted: bool,
    /// The `worktree.remove` or `worktree.cleanup` operation that removed it.
    pub operation_id: String,
    pub archived_at: i64,
}

/// The `worktree.archived` reply, newest first, at most 200 records.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeArchive {
    #[serde(rename = "type")]
    pub tag: WorktreeArchiveTag,
    pub project_id: String,
    pub entries: Vec<WorktreeArchiveEntry>,
}

/// A lifecycle operation's status in its ledger.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeOperationStatus {
    Running,
    Succeeded,
    /// The tree was removed but its branch was kept, or a cleanup archived
    /// some of its trees and not others.
    Partial,
    Failed,
    /// The daemon stopped while the operation ran; inspect before retrying.
    Interrupted,
}

/// One lifecycle operation from the ledger. The daemon stores this shape.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeOperation {
    /// The caller's operation ID.
    pub id: String,
    pub project_id: String,
    pub binding_generation: i64,
    /// The request as the caller sent it, including `op`.
    #[schemars(with = "Value")]
    pub request: Value,
    pub worktree_path: Option<String>,
    pub status: WorktreeOperationStatus,
    /// Command output and its `value`; `null` until the command runs.
    /// `worktree_state` omits `stdout` and `stderr`.
    #[schemars(with = "Value")]
    pub result: Value,
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery: Option<String>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
}

/// The `worktree.operation` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeOperationReply {
    #[serde(rename = "type")]
    pub tag: WorktreeOperationTag,
    pub operation: WorktreeOperation,
    /// The setup or teardown hook the operation is running now. Present only
    /// while a hook runs; the daemon keeps it in memory, so a restarted daemon
    /// reports the interrupted operation without it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub running_hook: Option<WorktreeHookProgress>,
}

/// A hook that is still running: which one, how far the operation has got,
/// and the latest output, bounded to its last 16 KiB.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeHookProgress {
    pub name: String,
    pub phase: HookPhase,
    /// The tree the hook runs in.
    pub path: String,
    /// The hook's position in its phase, from 0.
    pub index: u32,
    /// How many hooks the phase has configured.
    pub total: u32,
    pub started_at: i64,
    pub elapsed_ms: u64,
    /// The last 16 KiB of stdout and stderr, interleaved as they arrived.
    pub output: String,
    /// Whether earlier output was dropped.
    pub truncated: bool,
    /// The hooks of this phase that have finished, without their output.
    pub completed: Vec<WorktreeHookRun>,
}

/// How a path differs from `HEAD` in the source tree.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CarryChange {
    Added,
    Modified,
    Deleted,
    TypeChanged,
    Untracked,
    /// An unresolved merge conflict; never carried.
    Unmerged,
}

/// Why a carry cannot run as asked.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CarryBlocker {
    /// A selected path has an unresolved merge conflict.
    Unmerged,
    /// A selected path is a submodule; submodule changes are not carried.
    Submodule,
    /// A requested path has no uncommitted change.
    NotChanged,
    /// A requested path is absolute, contains `..` or names `.git`.
    InvalidPath,
    /// Nothing is selected.
    NoChanges,
    /// More than 10000 changed paths.
    TooManyChanges,
    /// The source has no commit to carry from.
    UnbornHead,
    /// The source `HEAD` differs from `expect_head`.
    HeadChanged,
}

/// One changed path in the source.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct WorktreeCarryEntry {
    pub path: String,
    pub change: CarryChange,
    /// The index differs from `HEAD`. Carried changes arrive staged.
    pub staged: bool,
    /// The working tree differs from the index.
    pub unstaged: bool,
    pub selected: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocker: Option<CarryBlocker>,
}

/// The `worktree.carry.preview` reply. Ignored files are never listed or
/// carried; ignored-resource rules handle them.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeCarryPreview {
    #[serde(rename = "type")]
    pub tag: WorktreeCarryPreviewTag,
    pub project_id: String,
    pub source: String,
    /// The source commit; pass it as `expect_head`. `null` when unborn.
    pub head: Option<String>,
    pub entries: Vec<WorktreeCarryEntry>,
    pub blockers: Vec<CarryBlocker>,
    /// True only when `blockers` is empty.
    pub carriable: bool,
}

/// How the carried changes reached the target.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CarryApply {
    /// The target was at the source commit; the result equals the snapshot.
    Exact,
    /// The target was elsewhere; a clean three-way merge was applied.
    Merged,
    /// The merge conflicted; nothing was applied. See `conflicts`.
    Conflicted,
}

/// What happened to the carried changes in the source.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CarrySourceOutcome {
    Kept,
    Cleaned,
    /// Cleaning started but the source does not read back clean. The carry
    /// ref still holds every change.
    CleanupIncomplete,
}

/// Why the source kept its changes.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CarryKeepReason {
    NotRequested,
    /// The target was not verified.
    NotVerified,
    /// The target started from another commit, so its content cannot be
    /// compared with the snapshot exactly.
    BaseDiffers,
    /// The source changed after the snapshot.
    SourceChanged,
    /// A source path has both staged and unstaged changes. The snapshot keeps
    /// only the working-tree version, so cleaning would lose the staged one.
    StagedAndUnstaged,
}

/// A carry operation's `result.carry`, written to the ledger as each step
/// completes, so an interrupted carry still names its saved commit.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeCarryResult {
    pub source: String,
    pub target: String,
    /// The source commit the snapshot is based on.
    pub base: String,
    /// The snapshot commit, whose parent is `base`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    /// The ref that keeps `commit`; ADE never deletes it.
    pub ref_name: String,
    pub paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_head: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied: Option<CarryApply>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conflicts: Vec<String>,
    /// The target's index and working tree read back as the applied result.
    pub verified: bool,
    pub source_outcome: CarrySourceOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_reason: Option<CarryKeepReason>,
}

/// What an ignored-resource rule did in one tree.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResourceOutcome {
    Copied,
    Linked,
    /// A `skip` rule.
    Skipped,
    /// The primary checkout has no such path.
    Missing,
    /// Git does not ignore the path, or could not say. Tracked and ordinary
    /// untracked files are never materialized.
    NotIgnored,
    /// Something already exists at the destination; it was kept.
    Conflict,
    /// The copy would exceed 2 GiB or 200000 entries; nothing was copied.
    TooLarge,
    /// The source or destination resolves outside its tree, or is not a
    /// file, directory or symbolic link.
    Unsafe,
    /// The copy or link failed; a partial copy is kept for inspection.
    Failed,
}

/// One rule's result, in an operation's `result.resources`.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
pub struct WorktreeResourceResult {
    pub path: String,
    pub mode: ResourceMode,
    pub outcome: ResourceOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The `worktree.rebind.list` reply.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeRebindCatalog {
    #[serde(rename = "type")]
    pub tag: WorktreeRebindCatalogTag,
    pub repositories: Vec<WorktreeRebindCandidate>,
}

/// One lifecycle repository in the rebind catalog.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
pub struct WorktreeRebindCandidate {
    pub id: String,
    pub root: String,
    pub common_dir: String,
    pub needs_rebind: bool,
    /// Whether the saved source identity survives, so a rebind can be verified.
    pub rebindable: bool,
    pub binding_generation: i64,
}

#[cfg(test)]
mod tests {
    use super::super::{DEFINITIONS, bundle};
    use super::*;
    use serde::de::DeserializeOwned;
    use serde_json::json;

    fn names(op: &str) -> (String, String) {
        let bundle = bundle();
        let spec = bundle["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|spec| spec["name"] == op)
            .unwrap_or_else(|| panic!("{op} is registered"))
            .clone();
        (
            spec["request"].as_str().unwrap().to_owned(),
            spec["response"].as_str().unwrap().to_owned(),
        )
    }

    fn errors(name: &str, value: &Value) -> Vec<String> {
        let bundle = bundle();
        let schema = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$defs": bundle["$defs"],
            "$ref": format!("{DEFINITIONS}{name}"),
        });
        jsonschema::validator_for(&schema)
            .unwrap()
            .iter_errors(value)
            .map(|error| error.to_string())
            .collect()
    }

    /// A wire request the daemon receives today decodes, and its canonical
    /// re-encoding matches the generated schema.
    fn request<T: Serialize + DeserializeOwned>(op: &str, wire: Value) -> T {
        let decoded: T = serde_json::from_value(wire).unwrap();
        let mut canonical = serde_json::to_value(&decoded).unwrap();
        canonical["op"] = json!(op);
        let (name, _) = names(op);
        let found = errors(&name, &canonical);
        assert!(found.is_empty(), "{name} rejected {canonical}: {found:?}");
        decoded
    }

    fn reply<T: Serialize + DeserializeOwned>(op: &str, wire: Value) {
        let (_, name) = names(op);
        let found = errors(&name, &wire);
        assert!(found.is_empty(), "{name} rejected {wire}: {found:?}");
        let decoded: T = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), wire);
    }

    fn operation() -> Value {
        json!({"id": "op-1", "project_id": "repository_1", "binding_generation": 0,
            "request": {"op": "worktree.switch", "project_id": "repository_1",
                "target": "feature", "create": true, "operation_id": "op-1"},
            "worktree_path": "/tmp/repo-feature", "status": "failed",
            "result": {"exit_code": 1, "elapsed_ms": 3, "value": {"path": null, "git_exit_code": 1}},
            "error": "Git command failed", "code": "lifecycle_command_failed",
            "recovery": "inspect_repository", "started_at": 1, "finished_at": 2})
    }

    fn state() -> Value {
        json!({"type": "worktree_state",
            "repository": {"id": "repository_1", "root": "/tmp/repo", "common_dir": "/tmp/repo/.git",
                "source_common_dir": null, "root_device": "1", "root_inode": "2",
                "source_root_device": "1", "source_root_inode": "2", "common_device": "1",
                "common_inode": "3", "source_common_device": "1", "source_common_inode": "3",
                "needs_rebind": false, "binding_generation": 0,
                "config": {"directory": null, "timeout_seconds": 60}, "refreshed_at": null},
            "worktrees": [
                {"path": "/tmp/repo", "branch": "main", "ade_owned": false, "setup_state": "ready"},
                {"path": "/tmp/repo-x", "detached": true, "locked": true, "lock_reason": "moving",
                    "prunable": true, "ade_owned": true, "setup_state": "preparing"}],
            "busy": false,
            "operations": [operation(),
                {"id": "op-2", "project_id": "repository_1", "binding_generation": 1,
                    "request": {"op": "worktree.refresh"}, "worktree_path": null,
                    "status": "running", "result": null, "error": null,
                    "started_at": 3, "finished_at": null}]})
    }

    #[test]
    fn effect_requests_carry_operation_id() {
        let switch: WorktreeSwitchRequest = request(
            "worktree.switch",
            json!({"op": "worktree.switch", "project_id": "r", "operation_id": "k",
                "target": "feature", "base": "main", "create": true}),
        );
        assert_eq!(switch.operation_id, "k");
        let switch: WorktreeSwitchRequest = request(
            "worktree.switch",
            json!({"project_id": "r", "operation_id": "k", "target": "feature",
                "base": null, "path": null}),
        );
        assert!(switch.base.is_none() && switch.create.is_none());
        let remove: WorktreeRemoveRequest = request(
            "worktree.remove",
            json!({"project_id": "r", "operation_id": "k", "path": "/tmp/t",
                "delete_branch": "merged"}),
        );
        assert_eq!(remove.delete_branch.as_deref(), Some("merged"));
        let refresh: WorktreeRefreshRequest = request(
            "worktree.refresh",
            json!({"project_id": "r", "operation_id": "k"}),
        );
        assert_eq!(refresh.operation_id, "k");
        let lookup: WorktreeOperationRequest = request(
            "worktree.operation",
            json!({"project_id": "r", "operation_id": "k"}),
        );
        assert_eq!(lookup.operation_id, "k");
    }

    #[test]
    fn remaining_requests_round_trip() {
        request::<WorktreeRepositoryRequest>("worktree.repository", json!({"path": "/tmp/repo"}));
        request::<WorktreeGetRequest>("worktree.get", json!({"project_id": "r"}));
        let adopt: WorktreeAdoptRequest = request(
            "worktree.adopt",
            json!({"operation_id": "o", "project_id": "r", "path": "/tmp/t", "confirm_path": "/tmp/t"}),
        );
        assert_eq!(adopt.confirm_path.as_deref(), Some("/tmp/t"));
        let configure: WorktreeConfigureRequest = request(
            "worktree.configure",
            json!({"project_id": "r", "config": {}}),
        );
        let config = Config::from(configure.config);
        assert_eq!((config.directory, config.timeout_seconds), (None, 60));
        request::<WorktreeRebindRequest>(
            "worktree.rebind",
            json!({"project_id": "r", "path": "/tmp/repo"}),
        );
        request::<WorktreeRebindListRequest>("worktree.rebind.list", json!({}));
    }

    #[test]
    fn request_schemas_reject_what_the_daemon_rejects() {
        let (adopt, _) = names("worktree.adopt");
        assert!(
            !errors(
                &adopt,
                &json!({"op": "worktree.adopt", "project_id": "r", "path": "/p"})
            )
            .is_empty()
        );
        let (remove, _) = names("worktree.remove");
        assert!(
            !errors(
                &remove,
                &json!({"op": "worktree.remove", "project_id": "r", "operation_id": "k",
                    "path": "/p", "delete_branch": "always"})
            )
            .is_empty()
        );
        let (configure, _) = names("worktree.configure");
        assert!(
            !errors(
                &configure,
                &json!({"op": "worktree.configure", "project_id": "r",
                    "config": {"path_template": "x"}})
            )
            .is_empty()
        );
        assert!(
            serde_json::from_value::<WorktreeConfigureRequest>(
                json!({"project_id": "r", "config": {"hooks": true}})
            )
            .is_err()
        );
    }

    #[test]
    fn replies_round_trip() {
        for op in [
            "worktree.repository",
            "worktree.get",
            "worktree.switch",
            "worktree.adopt",
            "worktree.remove",
            "worktree.refresh",
            "worktree.configure",
            "worktree.rebind",
        ] {
            reply::<WorktreeState>(op, state());
        }
        reply::<WorktreeOperationReply>(
            "worktree.operation",
            json!({"type": "worktree_operation", "operation": operation()}),
        );
        reply::<WorktreeOperationReply>(
            "worktree.operation",
            json!({"type": "worktree_operation", "operation": operation(),
                "running_hook": {"name": "install", "phase": "setup", "path": "/tmp/tree",
                    "index": 1, "total": 2, "started_at": 1, "elapsed_ms": 5,
                    "output": "step one\n", "truncated": false,
                    "completed": [{"name": "context", "phase": "setup", "verdict": "succeeded",
                        "exit_code": 0, "elapsed_ms": 3, "truncated": false}]}}),
        );
        reply::<WorktreeRebindCatalog>(
            "worktree.rebind.list",
            json!({"type": "worktree_rebind_catalog", "repositories": [
                {"id": "repository_1", "root": "/tmp/repo", "common_dir": "/tmp/repo/.git",
                    "needs_rebind": true, "rebindable": true, "binding_generation": 2}]}),
        );
    }

    #[test]
    fn lifecycle_requests_round_trip() {
        let create: WorktreeCreateRequest = request(
            "worktree.create",
            json!({"project_id": "r", "operation_id": "k", "name": "Login page",
                "base": "main"}),
        );
        assert_eq!(create.operation_id, "k");
        assert!(create.branch.is_none() && create.path.is_none());
        let setup: WorktreeSetupRequest = request(
            "worktree.setup",
            json!({"project_id": "r", "operation_id": "k", "path": "/tmp/t"}),
        );
        assert_eq!(setup.path, "/tmp/t");
        let cleanup: WorktreeCleanupRequest = request(
            "worktree.cleanup",
            json!({"project_id": "r", "operation_id": "k", "paths": ["/tmp/a", "/tmp/b"],
                "delete_branch": "merged"}),
        );
        assert_eq!(cleanup.delete_branch, Some(BranchPolicy::Merged));
        request::<WorktreeCleanupPlanRequest>("worktree.cleanup.plan", json!({"project_id": "r"}));
        request::<WorktreeArchivedRequest>("worktree.archived", json!({"project_id": "r"}));
        let configure: WorktreeConfigureRequest = request(
            "worktree.configure",
            json!({"project_id": "r", "config": {"branch_prefix": "ade/",
                "default_base": "main",
                "setup": [{"name": "install", "command": ["pnpm", "install"]}],
                "teardown": [{"name": "stop", "command": ["sh", "-c", "exit 0"],
                    "timeout_seconds": 30}]}}),
        );
        let config = Config::from(configure.config);
        assert_eq!(config.setup[0].timeout_seconds, 300);
        assert_eq!(config.teardown[0].timeout_seconds, 30);
        assert!(
            serde_json::from_value::<WorktreeConfigureRequest>(json!({"project_id": "r",
                "config": {"setup": [{"name": "x", "command": ["y"], "shell": true}]}}))
            .is_err()
        );
    }

    #[test]
    fn lifecycle_replies_round_trip() {
        let mut with_phase = state();
        with_phase["worktrees"][1]["phase"] = json!("setup_failed");
        with_phase["repository"]["config"]["setup"] =
            json!([{"name": "install", "command": ["pnpm", "install"]}]);
        reply::<WorktreeState>("worktree.create", with_phase);
        reply::<WorktreeCleanupPlan>(
            "worktree.cleanup.plan",
            json!({"type": "worktree_cleanup_plan", "project_id": "r", "trees": [
                {"path": "/tmp/a", "branch": "ade/wt-1", "phase": "ready", "eligible": true,
                    "blockers": []},
                {"path": "/tmp/b", "eligible": false, "blockers": ["dirty", "claim_uncertain"]}]}),
        );
        reply::<WorktreeArchive>(
            "worktree.archived",
            json!({"type": "worktree_archive", "project_id": "r", "entries": [
                {"path": "/tmp/a", "branch": "ade/wt-1", "head": "abc", "branch_deleted": false,
                    "operation_id": "k", "archived_at": 5}]}),
        );
        let tree: WorktreeCleanupTree = serde_json::from_value(json!({"path": "/tmp/a",
            "outcome": "failed", "error": "Teardown hook stop failed",
            "hooks": [{"name": "stop", "phase": "teardown", "verdict": "timed_out",
                "exit_code": null, "elapsed_ms": 30000, "truncated": false}]}))
        .unwrap();
        assert_eq!(tree.hooks[0].verdict, HookVerdict::TimedOut);
    }

    #[test]
    fn carry_and_resource_requests_round_trip() {
        let carry: WorktreeCarryRequest = request(
            "worktree.carry",
            json!({"project_id": "r", "operation_id": "k", "source": "/tmp/a",
                "target": "/tmp/b", "paths": ["src"], "clean_source": true}),
        );
        assert_eq!(carry.operation_id, "k");
        assert_eq!(carry.clean_source, Some(true));
        request::<WorktreeCarryPreviewRequest>(
            "worktree.carry.preview",
            json!({"project_id": "r", "source": "/tmp/a"}),
        );
        request::<WorktreeResourcesApplyRequest>(
            "worktree.resources.apply",
            json!({"project_id": "r", "operation_id": "k", "path": "/tmp/b"}),
        );
        let create: WorktreeCreateRequest = request(
            "worktree.create",
            json!({"project_id": "r", "operation_id": "k", "name": "pr",
                "fetch": {"remote": "origin", "ref": "refs/pull/12/head"}}),
        );
        assert_eq!(create.fetch.unwrap().reference, "refs/pull/12/head");
        let configure: WorktreeConfigureRequest = request(
            "worktree.configure",
            json!({"project_id": "r", "config": {"resources": [
                {"path": ".env", "mode": "copy"}, {"path": "node_modules", "mode": "link"}]}}),
        );
        assert_eq!(
            Config::from(configure.config).resources[1].mode,
            ResourceMode::Link
        );
        let (configure, _) = names("worktree.configure");
        assert!(
            !errors(
                &configure,
                &json!({"op": "worktree.configure", "project_id": "r",
                    "config": {"resources": [{"path": ".env", "mode": "share"}]}})
            )
            .is_empty()
        );
    }

    #[test]
    fn carry_preview_and_results_round_trip() {
        reply::<WorktreeCarryPreview>(
            "worktree.carry.preview",
            json!({"type": "worktree_carry_preview", "project_id": "r", "source": "/tmp/a",
                "head": "abc", "entries": [
                    {"path": "f", "change": "modified", "staged": false, "unstaged": true,
                        "selected": true},
                    {"path": "m", "change": "unmerged", "staged": true, "unstaged": true,
                        "selected": true, "blocker": "unmerged"}],
                "blockers": ["unmerged"], "carriable": false}),
        );
        reply::<WorktreeState>("worktree.carry", state());
        reply::<WorktreeState>("worktree.resources.apply", state());
        let result = json!({"source": "/a", "target": "/b", "base": "abc", "commit": "def",
            "ref_name": "refs/ade/carry/x", "paths": ["f"], "applied": "exact",
            "verified": true, "source_outcome": "kept", "source_reason": "not_requested"});
        let decoded: WorktreeCarryResult = serde_json::from_value(result.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), result);
        let resource: WorktreeResourceResult = serde_json::from_value(
            json!({"path": ".env", "mode": "copy", "outcome": "not_ignored"}),
        )
        .unwrap();
        assert_eq!(resource.outcome, ResourceOutcome::NotIgnored);
    }
}
