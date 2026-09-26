# Fence restored workspace roots until explicit rebind

Status: partial implementation; full acceptance remains open
Type: implementation ticket
Requirements: F061, F065, R007, R014, R017, 05-S11 (partial)
Owner: unassigned
Depends on: stable workspace and repository identity, runtime lease admission, managed backend snapshot

Outcome: A profile restored into a new identity can read its history without executing against the source profile's checkout. An owner must explicitly rebind each external workspace and repository to a verified path before agent, terminal, service, script, review or worktree side effects resume. The source profile's private default workspace is remapped to the new private workspace while its stable workspace ID and history remain intact.

The backend snapshot preserves absolute roots in both indexed SQLite columns and JSON records. Without a restore fence, startup could lease saved script and service owners, and commands could run at those paths before the user sees a warning. A new profile must not inherit those execution capabilities. `workspace.open` deduplicates by root and cannot implicitly clear a restore fence.

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
core catalogue. While any restored claim remains pending, opening a child or
unknown root is refused before creating a workspace identity, because it may
alias an old linked checkout.
Schema 12 prevents older daemons from ignoring these
binding fields. Startup does not
lease saved external roots or launch the old default terminal. An exact
attachment inspection can verify restored SQLite payloads without executing
in a workspace.

The public protocol now exposes `worktree.rebind.list`, `worktree.rebind`,
`repository.rebind.list`, `repository.rebind`, `workspace.rebind.list`, and
`workspace.rebind`; the CLI exposes the three rebind actions and the
Worktrunk list. Core and
Worktrunk lifecycle stores record current and immutable source device/inode
identities. A selected directory and Git common directory must match the
expected lineage; old restored stores without reliable source identity remain
fenced. Linked core and lifecycle repositories must follow the same current
binding. Rebind preserves repository, workspace and conversation IDs. Real
process E2Es cover shared repositories, renamed sources, repeated rebinds,
cross-store source claims and incompatible schema migrations. Independent
review found no remaining P1/P2 in the initial rebind paths.

## Comments

- 2026-09-26: The review found and commit `6e3f0a5` closed source-checkout bypasses for a
  repository-less workspace, renamed source directories, linked repository
  identity, cross-store source claims in both directions, and divergent second
  rebinds. The full acceptance cases above remain open: host-wide physical
  claims across profiles, arbitrary absolute source paths in restored
  service/script configuration, a crash during rebind, and a path replacement
  race between validation and child launch need further work. Path-based child
  launch retains a check/use window unless execution is rooted in an opened
  directory descriptor. Do not close F061/R014 on this slice alone.
- 2026-09-26: The desktop now lists pending Worktrunk, repository, and
  workspace bindings, guides explicit path selection in that order, and
  disables fenced workspace actions while history remains visible. It detects
  live path replacement through the effective binding catalog. A schema-12
  backup with no saved physical identity is reported as unrebindable. The
  daemon avoids creating a new workspace on restored startup, reconciles a
  crash after the last binding commit, and fences a linked workspace when its
  Git common directory diverges from its repository. The admission-to-child
  path replacement race still blocks full F061/R014 acceptance.
