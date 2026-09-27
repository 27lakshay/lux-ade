# Phase 1: scripts and files contracts

Status: returned
Type: slice evidence
Branch: claude/wf_e0896549-359-9
Worker: Phase 1 typed domains, scripts worker
Requirements: none (contract typing of existing operations)

## Outcome

`script.*` and `file.*` now have typed request and reply contracts in
`crates/ade-core/src/contract/scripts.rs` and `contract/files.rs`. The daemon
handlers in `crates/ade-daemon/src/scripts.rs` and `files.rs` decode requests
into those types and build replies from them, with unchanged wire shapes. The
CLI (`apps/cli/src/commands/services.ts`) and Electron main
(`apps/desktop/src/main/services.ts`, `files.ts`) now call these operations
through `dailyUseCommand`, which validates each request and reply against the
generated contracts.

## Operation tiers

| Operation | Tier | Request | Reply |
|---|---|---|---|
| `script.list` | query | `ScriptListRequest` | `ScriptList` |
| `script.inspect` | query | `ScriptInspectRequest` | `ScriptInspection` |
| `script.start` | effect command | `ScriptStartRequest` | `ScriptRun` |
| `script.stop` | effect command | `ScriptStopRequest` | `ScriptRun` |
| `script.retire` | effect command | `ScriptRetireRequest` | `ScriptRetired` |
| `script.runs` | query | `ScriptRunsRequest` | `ScriptRuns` |
| `file.list` | query | `FileListRequest` | `FileList` |
| `file.search` | query | `FileSearchRequest` | `FileSearch` |
| `file.preview` | query | `FilePreviewRequest` | `FilePreview` |

`file.list` and `file.search` are queries. They read only, but a page request
consumes its in-memory cursor. The architecture table lists "file browse
cursors" as idempotent commands; these cursors are ephemeral and not durable
state, so query fits them better.

No receipts moved. None of these operations had a `request_id`, operation
lookup or other receipt table, so `script.start`, `script.stop` and
`script.retire` carry no `operation_id` yet.

## Wire shapes not fully confirmed

These fields pass through as `serde_json::Value`:
- `metrics` and `exit_status` on a run: the runtime supervisor's terminal metrics.
- `output` on `script.inspect`: the runtime's `terminal.tail` reply.
- `durable_output` on `script.inspect`: the `service_logs::tail` reply.
- `toolchain` on `script.start`: the toolchain description.

Small behaviour changes, all for malformed requests only. No current caller sends these:
- A wrongly typed field that the handler used to coerce now fails with
  `Invalid request: ...`. This covers a non-string `name` or `run_id` (was
  "Missing script ..."), a non-integer `tail_bytes` (silently became 8192), and
  a non-string `path` on `file.list` (listed the root).
- Missing fields keep their messages: `Missing script name`,
  `Missing script run ID`, `Missing query`, `Missing path`. `Invalid file page
  limit` and `Invalid file cursor` also keep theirs.

## Checks

- `pnpm check:static`: pass
- In-process tests added: schema round trips in
  `crates/ade-core/src/contract/scripts.rs` and `contract/files.rs`
  (`#[cfg(test)]`).

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 35 | 5 | 5 | 0 |

## References

None.

## Open

- `crates/ade-core/src/contract/tests.rs`: this slice appended its nine
  operations to the tier list in `every_operation_declares_a_tier_and_named_types`.
  Otherwise `check:static` fails. The coordinator should merge that list across workers.
- `crates/ade-core/src/scripts.rs` now derives `JsonSchema` on `Script`.
- The typed `decode` helper is `pub(crate)` in `crates/ade-daemon/src/scripts.rs`,
  and `files.rs` reuses it. It could move beside `sessions.rs`'s `decode` later.
