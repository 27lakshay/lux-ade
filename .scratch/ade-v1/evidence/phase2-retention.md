# retention

Status: returned
Type: slice evidence
Branch: claude/wf_146e803f-a25-9
Worker: Phase 2 round C, retention slice
Requirements: F138 (retention and cleanup, backend); D15 (artifact retention and spool limits); architecture section 10 (GC excludes in-flight and referenced data; bounded logs; retention status)

## Outcome

The daemon now prunes effect receipts on a schedule and exposes a typed preview-and-apply pair for cleanup. `retention.preview` lists every item retention would remove and names the set with a `generation`. `retention.apply` gathers again under the session lock and removes items only when the new set has the same generation. Each removal checks its item's fingerprint first and confirms the item is gone before it reports `removed`. F138 is not fully accepted; it still needs E2E and UI evidence.

Design points:

- Eligibility is decided by pure functions in `crates/ade-daemon/src/retention.rs`. The session layer (`crates/ade-daemon/src/sessions/retention.rs`) only collects facts and carries out removals. A fact it could not observe means the item is kept.
- **Receipts.** A background thread in `Sessions` runs `receipts::prune` 60 s after start and then every 6 hours. It covers `sessions.sqlite`, the lifecycle store, the review store and the plugin store. Each store's outcome is recorded in `retention_prunes`, and the preview reports it along with the count still past retention. A store that fails is retried on the next tick.
- **Attachments.** Candidates follow the existing reclaim rules (`attachment_reclaim_preview`: no message, draft, queued prompt or unresolved send). An unreferenced upload younger than 24 hours may still be in flight, so it is kept. A row with no recorded upload time (`created_at` 0) is also kept. Apply goes through `attachment_reclaim_apply`, which checks the generation and the references again in its own transaction. The existing single-attachment reply stays the same, and its `automatic_gc_eligible` is still false: nothing removes an attachment without an explicit apply.
- **Skill blobs.** A candidate is a `skill_blobs` content hash that no `skill_bundles` row references. Removal checks the row count and byte fingerprint in an immediate transaction and deletes only while the hash is still unreferenced.
- **Service and script logs (the runtime's durable PTY spool).** A key in `<data>/service-logs` is kept when any of these maps to it: a runtime terminal, a workspace terminal, a workspace extra terminal (script runs), a service record's `terminal_id`, or a `terminal_creations` row. If the runtime terminal list cannot be read, or the runtime is draining, no service log is judged, and the reason appears under `withheld`. An unowned key must also have been idle for 7 days. Keys with a link or special file are never touched, and neither are files whose names the runtime would not write.
- **Diagnostic logs.** Rotated `<process>.<YYYY-MM-DD>.jsonl` files older than 30 days are candidates. The newest file of each process is always kept.
- **Unbounded process logs.** `daemon.log` and `runtime.log` are reported under `observed_logs` with their sizes. They are not truncated, because another process appends to them and a truncate could lose that process's writes.
- The generation is a SHA-256 over the policy version, the sorted items and their fingerprints, and a truncation flag. Changing a rule invalidates every earlier preview. A preview lists at most 500 candidates, in sorted order.
- Apply is replay-safe only when complete. A complete apply is stored in `retention_applies` and replayed with `replayed: true`. After a partial apply, the set has changed, so a retry is refused with "preview again". Stored results are dropped after 30 days, on the prune schedule.
- New tables (`retention_applies`, `retention_prunes`) are created idempotently in `sessions.sqlite`. No migration or backup pin changed.

## Operation tiers

| Operation | Tier | Request | Response |
|---|---|---|---|
| `retention.preview` | query | `RetentionPreviewRequest` | `RetentionPreview` |
| `retention.apply` | idempotent command (applies only to the previewed generation; a completed generation replays) | `RetentionApplyRequest` | `RetentionApply` |

CLI: `apps/cli/src/commands/retention.ts` adds `retention preview` and `retention apply GENERATION`.

## Checks

- `pnpm check:static`: pass
- In-process tests added: `crates/ade-daemon/src/retention.rs` (attachment, skill blob, service log and diagnostic log verdicts, file-name parsing, generation stability, prune schedule), `crates/ade-daemon/src/sessions/retention.rs` (a malformed runtime terminal list fails closed) and `crates/ade-core/src/contract/retention.rs` (schema round trips).
- A throwaway in-process smoke test exercised the SQL and file paths once and was then deleted, as the test policy requires. It covered the attachment grace window and reclaim, skill blob fingerprint refusal and removal, service log ownership through the workspace terminal key, refusal after a file changed, removal and confirmation, unrelated files left alone, the newest diagnostic log kept, and idempotent table creation. It is not part of the gate.
- Verified only statically: the scheduler thread, reading the runtime terminal list, apply under the live session lock, the other stores' prune connections, and the CLI wiring.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 55 | 10 | 10 | 0 |

## References

- Orca @ ade-evaluation-2026-09-24, `src/shared/workspace-cleanup.test.ts` — pattern: cleanup candidates with fingerprints that are checked again before removal.
- OpenCode-v2 @ ade-evaluation-2026-09-24, `packages/core/src/file-retention.ts` — pattern: an mtime cutoff for file retention. ADE keeps each process's current file and fails closed on an unreadable time.
- No code copied.

## Open

- E2E coverage: preview then apply against a live daemon, a set that changes between the two, and replay after a lost reply. Also the scheduler recording a prune, and a live service's log never being listed.
- UI: a storage and retention panel that shows candidates, withheld categories, receipt state and observed logs.
- `daemon.log` and `runtime.log` still grow without a bound. The runtime and the control launcher (their owners) should rotate their own stdout logs. This slice only reports their size.
- The host resource registry's `operations` table is shared across profiles and is not pruned here. Its owner (`host_resources`) should prune it.
- The in-memory browser receipts last for one process and need no pruning.
- Attachment and skill blob removals free pages inside SQLite, not disk space. Reclaiming disk needs `VACUUM` or `incremental_vacuum`, which is not scheduled.
- Configurable retention (user-set limits) is not implemented. The policy is fixed and reported in `policy`.
- Shared-file change outside this domain: `ade_runtime::service_logs::key` became `pub`, so the daemon computes the same key the runtime writes. The coordinator should confirm the terminals owner accepts this.
