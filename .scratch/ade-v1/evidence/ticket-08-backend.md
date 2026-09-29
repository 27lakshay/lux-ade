# Ticket 08, backend half: schema squash and compatibility shims (D19)

Status: built. Branch `claude/agent-ab0ed489faadb48db`, rebased once on `main` at `76d7de4`.

## Results

| Check | Result |
|---|---|
| `pnpm check:static` on `809e079` (after the rebase) | passed; 863 Rust tests passed, 1 skipped |
| Full `pnpm test:e2e:protocol:only`, 6 workers, on `3fc21de` | 959 passed, 3 failed, 15 skipped |
| `backup/rebind.spec.ts:228` and `:294` | fail on `main` (`f271738`) too, before any change here: pre-existing |
| `plugin-dev/drain.spec.ts:91` | failed at 6 workers; passed 3 of 3 alone: load, not a timing bug |
| Earlier full run, 2 workers, on `809e079` | 955 passed, 8 failed; the 3 regressions it found are fixed in `3fc21de`; `local-git.spec.ts:143` and `auth.spec.ts:50` passed alone (auth 6 of 6) |

`3fc21de` changes only protocol specs; it passed format, lint and the E2E typecheck, not a
second full gate.

## Commits

| Hash | What |
|---|---|
| `e8ccb4f` | Profile schema created in one transaction at version 21; lifecycle database at version 5; every other version refused; backfills, aliases and old-format restore removed |
| `0dea0f0` | Workspace `terminal_id` and `extra_terminals` removed; runtime protocol gets `runtime::Workspace` |
| `2f2394a` | Catalog `repositories`, `CatalogRepository` and workspace `repository_id` removed; SDK parses the catalog strictly |
| `809e079` | SDK Git journal no longer reads version 1 |
| `3fc21de` | Spec fixes from the full run |

## What an old database sees

- `sessions.sqlite` at version 0 gets the whole schema at version 21 in one transaction
  (a killed creation leaves nothing; unit test). Any other version, 1 to 20 or newer, is
  refused before anything is written: "The profile database PATH has schema version N; this
  build reads only schema 21 and does not upgrade older databases before launch. Delete the
  database to start this profile again". Unit test and E2E `boot.spec.ts`.
- `sessions.worktrees/lifecycle.sqlite3`: the same at version 5, with its own message.
- `schema_migrations` and `terminal_creations` are gone; `user_version` is the marker.
- `ade-control backup restore` reads only format 7 at the current schemas; an older format
  or schema is refused before the target is created (E2E `backup/restore.spec.ts`,
  `backup/corrupt.spec.ts`). The restore fence stays: a current-schema restore needs it.

## Removed

- Store migration chain (20 steps) and its data backfills: project IDs, conversation news and
  seen marks, terminal records from workspace fields (also the backfill on every open),
  service identities, attachment generations, path-binding sources, send-intent columns.
- Prototype `windows` table detection; `terminal_creations` fallback for `terminal.create`.
- Lifecycle chain (versions 2 to 4), `repository_aliases`, `unify_repository_ids`, alias
  lookups in `worktree.*` and `project`, receipts made up for pre-receipt ledger rows,
  ledger defaults for `binding_generation` and `worktree_path`.
- Workspace `terminal_id`, `extra_terminals` and the `workspaces.terminal_id` column.
- `Catalogue.repositories`, `CatalogRepository`, workspace `repository_id`; the
  `workspace.created` hook payload carries `project_id` instead.
- Backup formats 2 to 6 and schemas one behind; the schema-12 fence message.
- SDK: projects built from `repositories`, defaults for fields an older daemon omitted,
  dropping a malformed terminal or window, Git journal version 1.
- CLI: `terminal_id` copy in `ade terminal list`; ownership check through workspace fields.

## Kept, and why

- The primary shell: the terminal record marked `primary`; the runtime key of the primary
  shell stays the workspace ID.
- `workspaces.repository_id` column: the store's internal link to the repository record
  (binding checks, rebind); not on the wire. Read through `Store::workspace_repository`.
- Catalog adopting the lifecycle's ID for a repository the lifecycle registered first.
- `repository.rebind` and `worktree.rebind`: live operations.
- Control-lane fallback to the profile socket: also serves a daemon that could not open
  the lane (comment reworded).

## Left for the coordinator

- `request_id` aliases for `operation_id` on about 35 contract fields, and
  `browser_request_id`. The desktop's `browser.ts` still sends `request_id` to browser
  mutations, so removing them needs desktop changes.
- Other storage compatibility outside the named shims: `legacy_secret_values` moving
  plain-text service secrets, the proxy registry's `route_id` backfill, plugin
  `legacy_reference`, restart-time retirement of "older builds'" terminal attachments,
  receipts that recorded only a summary.
- Open-ended terminal `kind` and `status` strings in the SDK and contract (tolerance for a
  newer daemon), kept as lane C decided.
- Desktop: two test fixtures lost `terminal_id` and `repository_id` (forced by the type).
