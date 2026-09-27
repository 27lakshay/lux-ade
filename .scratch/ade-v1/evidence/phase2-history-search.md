# history-search

Status: returned
Type: slice evidence
Branch: claude/wf_ffe8a658-434-9
Worker: Phase 2 round B, history-search slice
Requirements: F043 (work search, backend), F041 (combined history, backend); architecture section 6 (search indexes as recoverable asynchronous projections)

## Outcome

The daemon keeps an SQLite FTS5 index (contentless, `contentless_delete=1`, `unicode61 remove_diacritics 2`) over conversation message text and review feedback notes and paths. Triggers on `messages` append a journal row per insert, update or delete inside the writer's own transaction. A background indexer applies the journal on its own connection in short batches and records a high-water mark, so it catches up or rebuilds after a crash without replaying changes. Typed `history.*` operations provide paginated search and a combined listing across conversations and providers, both with provenance. Each search reply states the index lag. Neither requirement is fully accepted; both need E2E and UI evidence.

Design points:

- Tables live in `sessions.sqlite`, the database that owns messages. They are created idempotently by `History::open` (`CREATE ... IF NOT EXISTS`), which runs after `Store::open`. No migration or backup version pin changed.
- The indexer re-reads each changed message's current state rather than replaying deltas. Streaming in-place updates, deletes and crash-repeated batches all converge.
- `plan()` rebuilds under a new epoch when the index version changes, when the index is first created, or when the journal head is behind the recorded high-water mark. A rebuild backfills by message ID with a persisted resume point. Changes made during the rebuild are journalled and applied afterwards.
- Search results are joined to live `messages` and `conversations`, so a deleted record never appears, even before the indexer applies the deletion. Excerpts come from the current message text, not from index copies.
- Status (`epoch`, `rebuilding`, `pending_changes`, `caught_up`, `last_error`) is read in the same snapshot as the results. A rebuild is never reported as caught up.
- Search cursors carry the epoch, so a cursor from before a rebuild is refused ("expired; search again") instead of paging wrong rows.
- User queries are sanitized: every term is a quoted FTS5 string, and only a trailing `*` survives as a prefix. The query allows up to 16 terms and 256 bytes. A term with no letters or digits is dropped.
- A `workspace_id` or `conversation_id` filter that names no record is an error, not an empty result.

## Operation tiers

| Operation | Tier | Request | Response |
|---|---|---|---|
| `history.search` | query | `HistorySearchRequest` | `HistorySearch` |
| `history.list` | query | `HistoryListRequest` | `HistoryList` |
| `history.index.status` | query | `HistoryIndexStatusRequest` | `HistoryIndexReply` |
| `history.index.rebuild` | idempotent command (compare-and-set on `expected_epoch`) | `HistoryIndexRebuildRequest` | `HistoryIndexReply` |

CLI: `apps/cli/src/commands/history.ts` adds `history search`, `history list`, `history index status` and `history index rebuild`.

## Checks

- `pnpm check:static`: pass
- In-process tests added: `crates/ade-daemon/src/history/core.rs` (catch-up planning, lag, journal collapse, query sanitizing, cursors, feedback text, excerpts) and `crates/ade-core/src/contract/history.rs` (schema round-trips).
- A throwaway in-process smoke test ran the SQL path once and was then deleted, as the test policy requires. It covered backfill, pagination, prefix and diacritic-folded matches, journal catch-up with `observed_at`, in-place update, delete-before-apply exclusion, idempotent rebuild, cursor expiry, unknown-filter refusal and reopen. It is not part of the gate.

Verified only statically (types, Clippy, contract check), with no committed runtime coverage:
- the SQL statements, triggers and FTS5 behaviour in `crates/ade-daemon/src/history.rs`
- the background indexer thread and its retry after failure
- the `sessions.rs` dispatch and the CLI module

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 70 | 5 | 10 | 0 |

## References

- paseo @ ade-evaluation-2026-09-24, `packages/server/src/server/agent-history-search.ts`, studied. Paseo searches names only and avoids "an incomplete subset of transcripts"; ADE searches transcripts and reports index lag explicitly instead.
- SQLite FTS5 documentation (contentless-delete tables, `unicode61` options), consulted for table options. The bundled `libsqlite3-sys` 0.38.2 builds SQLite 3.53.2 with `-DSQLITE_ENABLE_FTS5`, which was confirmed in its `build.rs`.

## Open

- E2E (when UI work begins): F043 "search, open the correct resource, remove deleted records, show lag", and F041 "search/read normalized history across providers with native session references".
- UI: search and combined-history surfaces, and lag display.
- Conversation titles are not full-text indexed. The listing scans `conversations` with `json_extract` ordering, which is fine at current scale but has no index.
- Messages carry no creation time. `observed_at` is the first journalled change and is null for messages indexed by a backfill.
- The listing orders by `updated_at`, which changes. A conversation updated mid-paging can move ahead of the cursor (documented in the contract).
- External session import (F042) and attachments are not indexed. Rewind (F039) deletes messages, which the delete trigger already covers.
- Shared files: `crates/ade-daemon/src/lib.rs` (+1 line `pub mod history;`), `crates/ade-daemon/src/sessions.rs` (a `history` field, its open call and a `history.*` dispatch branch) and `apps/cli/src/index.ts` (import, usage fragment and command-area entry: 3 lines).
