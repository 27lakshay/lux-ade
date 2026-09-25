# Projects, worktrees and workspace lifecycle

Status: ready-for-agent
Type: specification
Scope: ADE v1
Implementation status: not verified against this specification; prototype capabilities require E2E acceptance.

## Problem Statement

Users need isolated checkouts and reliable setup/cleanup without losing work when profiles or agents share physical resources.

## Solution

Manage stable workspace identities and creator-owned worktree lifecycle with explicit reservations, checkpoints and recovery.

## User Stories

1. As a user, I want support for Projects and ordinary folders, so that I can work with repositories or plain directories. **F061**
2. As a user, I want support for Repository clone and publish, so that I can start from a remote or publish local work. **F062**
3. As a user, I want support for Managed worktree creation, so that I can isolate agent changes. **F063**
4. As a user, I want support for Carry uncommitted changes, so that I can move current work into an isolated checkout. **F064**
5. As a user, I want support for Adopt branch, checkout, worktree or PR source, so that I can continue existing work in ADE. **F065**
6. As a user, I want support for Worktree naming and defaults, so that I can create predictable workspaces. **F066**
7. As a user, I want support for Workspace setup and teardown hooks, so that I can prepare and clean a workspace consistently. **F067**
8. As a user, I want support for Ignored-resource handling, so that I can make required local resources available in worktrees. **F068**
9. As a user, I want support for Workspace archive and cleanup, so that I can retire workspaces without losing active work. **F069**
10. As a user, I want support for Checkpoints and restore, so that I can recover a previous workspace state. **F070**
11. **05-S11.** As a user, I want to prevent competing profiles from removing active workspaces, so that I can protect shared physical work.
12. **05-S12.** As a user, I want to see unverifiable process ownership, so that I can avoid deleting resources still in use.

## Implementation Decisions

1. HostResources is initially a module shared by per-profile runtimes with a host-local registry and resource-specific OS guards, not a new always-on broker.
2. Key physical checkout claims by host/filesystem identity and generation, not profile path alone. Handle aliases, replacement and unborn-path reservations.
3. Runtime-owned shared-use claims conflict with exclusive removal/lifecycle claims. Persist phases before launching work. Reconcile owners before new conflicting admission after daemon restart.
4. Worktrunk remains the worktree lifecycle adapter. The tool that created a tree removes it. Adoption must not take ownership away from an external creator.
5. Missing heartbeat/PID or released lock does not prove descendants exited. Quarantine unresolved claims. Registry corruption/migration must not silently forget live owners.
6. Concurrent agents in one checkout can conflict with each other and external Git. Make shared workspace versus new worktree an explicit choice.
7. File checkpoints declare coverage and are not process snapshots. Restore and carry-change operations preview effects, detect changed preconditions and report partial failures.

## Testing Decisions

All new tests are end-to-end. Exercise the running Electron application, CLI or public protocol with actual ADE processes, as approved by the user. Assert observable behavior, not internal classes, reducers, database layouts or implementation call counts. Use isolated host/profile/repository fixtures. External protocol fixtures are permitted; report real-provider evidence separately.

Modules exercised through these public interfaces: Workspace commands, runtime leases, HostResources, Git/lifecycle adapter and file checkpoints.

Prior art: Prototype creator markers/worktree leases; Orca shared/exclusive mutation and descendant shutdown cases. Reuse the scenarios at the E2E level; do not copy isolated tests into a new unit suite.

### Feature acceptance

| Requirement | Required end-to-end evidence |
|---|---|
| F061 | Register each kind, reopen it with stable identity and report missing or replaced directories without silently binding unrelated content. |
| F062 | Clone into a selected host/path; publish through configured Git remote/auth flow; preserve partial-operation evidence and never overwrite an existing path silently. |
| F063 | Create a worktree through its lifecycle owner; reserve its physical resource before launch; failed setup is visible and recoverable. |
| F064 | Preview and transfer selected dirty changes; preserve the source until success and report conflicts without discarding unselected work. |
| F065 | Adopt existing resources without ownership takeover; resolve a supported PR source into a checkout without adding the excluded PR management workflow. |
| F066 | Apply naming/base defaults, detect collisions, and record the resolved branch and directory before running hooks. |
| F067 | Run configured hooks with the correct host/workspace context; stream status; expose failure and require safe recovery before destructive cleanup. |
| F068 | Apply explicit copy/link/share rules, report conflicts and preserve externally owned files during cleanup. |
| F069 | Inspect dirty/active state; refuse conflicting removal; route removal through the creator tool and quarantine uncertain execution ownership. |
| F070 | Create a defined file checkpoint, preview restore, handle concurrent edits and disclose untracked/ignored/binary coverage; checkpoint is not arbitrary process rollback. |
| 05-S11 | Race launch and removal through different profiles; only a valid claim wins and no active checkout is deleted. |
| 05-S12 | Escape a fixture descendant and lose its parent; keep the resource uncertain until explicit reconciliation. |

A feature is complete only when its selected behavior and failure path are demonstrated, the relevant other-domain dependencies work, and its evidence/status is recorded in the register. A package installation, UI mock or fixture provider alone does not establish product completion.

## Out of Scope

Disposable VM/container provisioning and automatic attribution of every external file edit are excluded.


## Further Notes

This specification records required behavior, not implemented completeness. The shared v1 register contains all 140 original catalogue dispositions, scope corrections, delivery dependencies and remaining decisions. No source file layout or package candidate overrides the agreed product behavior.
