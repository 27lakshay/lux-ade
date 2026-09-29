# 08 — Integration audit

Status: closed
Type: task
Label: wayfinder:task
Assignee: coordinator
Blocked by: [06](06-lane-sdk-reliability.md), [07](07-desktop-switch-over.md)

## Build

1. A read-only review agent audits the merged tree against the map: no durable state or
   multi-step daemon orchestration left in `apps/desktop`; every new operation has a declared
   tier, CLI command and protocol E2E; the architecture doc, CONTEXT.md and decision register
   match the code.
2. Remove every compatibility shim (decision D19: no backwards compatibility before launch):
   workspace `terminal_id` and `extra_terminals` (derived from terminal records), the catalog's
   `repositories` and workspace `repository_id` aliases, the `repository_aliases` table and the
   old lifecycle-ID lookup, the SDK's fallback that builds `projects` from an older daemon, the
   tolerant parsing kept only for older desktops, the one-time localStorage layout import
   (`layout-import.ts`) and its tests, and the prototype `windows` table handling in migrations.
   Squash the store's migration chain into one schema (D19): a new profile gets it at once, any
   other version is refused with a clear message; the data backfills (projects, unread markers,
   seen marks, terminal records) go with it. Backups restore only the current schema.
3. The whole-effort acceptance from the map: the CLI-only window run, the desktop showing it,
   the benchmark.
4. Full `pnpm check:static` and `pnpm test:e2e:protocol` on `main`; retire the lane trees.

## Acceptance

- The review finds nothing serious, or its findings are fixed.
- The map's acceptance list passes; results in `.scratch/ade-v1/evidence/daemon-authority.md`
  and `progress.md`.

## Comments
- 2026-09-29 — Done. Audit fixes `61abe7d`–`088b6c3`; full gate and 976 protocol specs pass. The benchmark holds 60 fps; memory isn't comparable with the old figure and moves to [11](11-electron-memory-floor.md). Evidence: `.scratch/ade-v1/evidence/daemon-authority.md`.
