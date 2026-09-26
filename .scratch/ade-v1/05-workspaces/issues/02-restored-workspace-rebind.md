# Fence restored workspace roots until explicit rebind

Status: implementation in review (restore fence only)
Type: implementation ticket
Requirements: F061, F065, R007, R014, R017, 05-S11 (partial)
Owner: unassigned; start after the attachment schema-v11 migration is integrated
Depends on: stable workspace and repository identity, runtime lease admission, managed backend snapshot

Outcome: A profile restored into a new identity can read its history without executing against the source profile's checkout. An owner must explicitly rebind each external workspace and repository to a verified path before agent, terminal, service, script, review or worktree side effects resume. The source profile's private default workspace is remapped to the new private workspace while its stable workspace ID and history remain intact.

The current backend snapshot preserves absolute roots in both indexed SQLite columns and JSON records. Startup may lease saved script and service owners, and commands may run at those paths before the user sees a warning. A new profile must not inherit those execution capabilities. The current `workspace.open` deduplicates by root and cannot implicitly clear a restore fence.

Implementation sequence:

1. Persist a versioned `needs_rebind` state for restored workspaces and repositories. Keep catalog and history readable while fenced. A missing or replaced path cannot silently become a different workspace.
2. Centralize execution admission for every workspace and repository operation. Gate agent send/resume and queue dispatch, terminal create/raw stream/restart, service and script lifecycle, health probes, review/Git mutations and reads that inspect the source checkout, worktree lifecycle, and stable URL target/remap. Startup restore and lease refresh must skip fenced roots without erasing unresolved resource claims. Stop/retire cleanup may remain available only with exact owner identity.
3. Add an explicit rebind operation that validates the selected directory and Git common directory, handles aliases/replacement, and atomically updates indexed roots and JSON records while preserving workspace/repository IDs. Rebind must not transfer externally owned Worktrunk removal authority.
4. Make profile restore set these fences before first daemon start. Remap the source private default workspace to the new profile's private directory in both storage representations, and publish the registry only after validation.

E2E acceptance through real ADE processes and public commands:

- Back up a profile with an external Git workspace, conversation, queued prompt, script, service, terminal, review data and worktree lifecycle history. Restore beside the source. History and catalog remain readable; no old-root execution, Git review, worktree mutation, proxy route or background health probe occurs. Public side-effect commands reject with a stable `needs_rebind` error.
- Explicitly rebind to a new checkout. The same workspace/conversation IDs now support a real terminal, agent, service, script and review flow. The original checkout and profile remain unchanged.
- Kill during rebind, then restart: the record is wholly fenced or wholly bound. Race rebind with symlink/path replacement and conflicting physical claims. One valid owner wins; an unverifiable case remains fenced.
- Cover two workspaces sharing a repository, and a path whose Git common directory differs from the saved repository identity. Rebinding one workspace does not silently rebind another.

Current slice: the restored backend records `needs_rebind` on each saved
workspace and repository, and `worktree_lifecycle_needs_rebind` on both record
kinds so Worktrunk remains fenced even without a matching core repository.
The daemon preserves catalogue and conversation reads, but
rejects execution through agent, terminal, service, script, review and
worktree entry points with a stable `needs_rebind` failure. The lifecycle
database has its own fence for repositories that were never registered in the
core catalogue. Opening a child of a fenced root inherits the fence without
running Git there. While any restored claim remains pending, newly opened
unknown roots are fenced too, because they may alias an old linked checkout.
Schema 12 prevents older daemons from ignoring these
binding fields. Startup does not
lease saved external roots or launch the old default terminal. An exact
attachment inspection can verify restored SQLite payloads without executing
in a workspace.

Remaining: no `workspace.rebind` or `repository.rebind` command is exposed.
The fence intentionally stays set until physical identity, alias handling,
shared repository claims, and inherited Worktrunk removal authority can be
validated together. The full acceptance cases above, including crash and
path-replacement races, remain open. This is a dependency of complete R014
restore; the backend-only snapshot in `5455362` does not solve it.
