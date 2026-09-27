# session-import

Status: returned
Type: slice evidence
Branch: claude/wf_146e803f-a25-4
Worker: Phase 2 round C, session-import slice
Requirements: F042 (external session import, backend); F041 (combined history gains imported provenance); decision D04 (record actual capability; unavailable is explicit)

## Outcome

The daemon imports native Claude Code and Codex sessions from their on-disk stores as read-only conversations with status `imported`. Each import records its provider, native session ID, source file, native working directory and source account in `history_imports`, and history search and listing now return that as `provenance.import`. Import is an idempotent command keyed by provider and native session ID. F042 is not fully accepted; it needs E2E and UI evidence.

Design points:

- Stores. Claude Code: `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<project>/<session id>.jsonl`, from the Claude Code docs. Codex: `<CODEX_HOME or ~/.codex>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl` and `archived_sessions/`, with thread names from `session_index.jsonl`. `account_id` reads that ADE account's native home instead. A missing store is reported as `available: false` with the reason, not as an empty list.
- Claude Code documents its transcript format as internal and changing between versions. The parser therefore ignores known metadata records, and turns an unknown content block into a visible `unrecognized` item. It never guesses. It keeps only the branch that ends at the newest message, following `parentUuid` and, across a compaction, `logicalParentUuid`, so rewound branches do not appear. If the chain cannot be followed to an explicit root, it keeps every message rather than dropping history.
- Codex rollouts are read in both the `{timestamp,type,payload}` envelope and the older top-level item shape. Only the first `session_meta` names the session, because a forked sub-agent rollout repeats its parent's metadata. `event_msg` lines mirror `response_item` lines and are not imported twice. Developer messages are skipped, and injected context (`# AGENTS.md instructions`, a single tag-wrapped block) is imported with kind `context`.
- Private reasoning (`thinking`, `reasoning`) is never imported, which matches the live adapters.
- Tool calls become `tool` messages with `Content::Tool`, and later results are attached to them by call ID. A result whose call is missing is kept as its own message. Text is capped at 256 KiB and tool input or output at 64 KiB, with a visible truncation marker.
- Idempotency. Message IDs are `import:<provider>:<session>:<native key>`, where the native key is a Claude record UUID or a Codex line ordinal, plus a block index. `parse::plan` extends an import only when the new items start with exactly the imported ones, checked by a digest of key, role, kind, text and tool identity. Tool results are left out of the digest, so a result written after its call counts as an update. Anything else is refused and the earlier import stays unchanged: a rewind, a rewritten file, a different workspace, a missing conversation, or a conversation that is no longer `imported`. A repeat with nothing new writes nothing and reports `unchanged`.
- Fail closed. The session ID must be a UUID and must name exactly one file. The file's records must name the same session. Files over 256 MiB and files that are not UTF-8 are refused. A last line without its newline is not read and is reported as `incomplete_tail`. Unparseable lines are counted in `skipped_records`.
- Resume (D04). Every import reports `resumable: false` with `resume_unavailable_reason`. `provider_thread_id` stays null. `agent.send`, `agent.send_review`, `agent.resume` and `queue.enqueue` refuse a conversation with status `imported`, and the queue dispatcher already selects only `idle` or `ready` conversations. An imported conversation therefore cannot silently start a new native session that looks like a continuation.
- Imported messages reach the search index through the existing `messages` triggers. `history_imports` is created idempotently in the profile database, both by `History::open` and on each import. No migration or backup pin changed.

## Operation tiers

| Operation | Tier | Request | Response |
|---|---|---|---|
| `history.import.scan` | query | `HistoryImportScanRequest` | `HistoryImportScan` |
| `history.import.session` | idempotent command (keyed by provider + native session ID) | `HistoryImportRequest` | `HistoryImported` |

Changed without breaking the wire: `HistoryProvenance` gains an optional `import` field, which is omitted for ordinary conversations. `native_session_id` now falls back to the import record.

CLI: `apps/cli/src/commands/imports.ts` adds `import scan claude|codex` and `import session claude|codex NATIVE_SESSION_ID --workspace ID`.

## Checks

- `pnpm check:static`: pass
- In-process tests added:
  - `crates/ade-daemon/src/history/import/parse.rs`: timestamps, incomplete tail, truncation, tool pairing, and the re-import decider covering prefix, rewind, workspace and late tool results.
  - `crates/ade-daemon/src/history/import/claude.rs`: transcript mapping, rewound branch, compaction chain, broken chain and bad lines.
  - `crates/ade-daemon/src/history/import/codex.rs`: rollout mapping with a fork, injected context and compaction; the pre-envelope shape; thread names.
  - `crates/ade-daemon/src/history/import.rs`: file-name session IDs and workspace path matching.
  - `crates/ade-core/src/contract/history.rs`: schema round-trips for the new operations.
- Two throwaway in-process smoke tests ran and were then deleted. Neither is part of the gate.
  1. It ran the store scan and full parse against this Mac's real stores: 8 Claude Code and 8 Codex sessions, up to 9,467 items each. Every session parsed with zero skipped records and no unrecognized items.
  2. It ran `commit` against a real profile database. It covered: imported, then unchanged, then appended with one tool result filled in; rewind refused; wrong workspace refused; sequences 1 to 3; search finding the imported text with `native_session_id` and `resumable: false`; and listing showing status `imported`.

Verified only statically (types, Clippy, contract check), with no committed runtime coverage:
- the `sessions.rs` dispatch, `sessions/imports.rs` and the catalog publish after an import
- the send, resume and enqueue refusals for imported conversations
- the CLI module

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 95 | 5 | 10 | 0 |

## References

- t3code @ ade-evaluation-2026-09-24, `apps/server/src/project/AgentSessionImporter.ts`, pattern. It keys imports by provider session ID and refuses a thread that changed. ADE refuses rather than skips, and does not install a resume cursor.
- ghostex @ ade-evaluation-2026-09-24, `apps/history-cli/src/scan.rs`, studied for store locations and record types. No code was copied.
- Claude Code docs, "Explore the .claude directory" and "Manage sessions" (code.claude.com): the transcript path, `CLAUDE_CONFIG_DIR`, and the statement that the format is internal.
- The Codex rollout layout (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl`, first line `session_meta`) was checked against the Codex CLI session docs and local rollouts from Codex CLI in September 2026.

## Open

- E2E (when UI work begins): F042 "import a supported native session twice without duplicates; retain provenance; distinguish read-only import from resumable sessions".
- UI: an import picker built on `history.import.scan`, and a read-only marker plus the resume reason on imported conversations. The client SDK's conversation decoder accepts any status string. The renderer has no `imported` handling yet.
- Resuming an imported session is not supported (`resumable: false`). That needs the adapter to adopt the native session with the right account home and working directory.
- An appended import publishes only the catalog. An open conversation view must fetch again to see new messages.
- A scan reads the first 256 KiB of each of up to 2,000 newest files. A `--workspace` filter over a large store can therefore be slow. The scan does not page.
- A forked Codex sub-agent rollout also contains the history it inherited from its parent. That history is imported as part of the sub-agent session.
- Claude sessions whose records name a different `sessionId` than the file name are refused. It is unverified whether current Claude Code ever writes such files.
- Other providers (Oh My Pi, OpenCode) have no importer. The contract's provider enum lists only `claude` and `codex`.
- Shared files touched:
  - `crates/ade-daemon/src/sessions.rs`: `mod imports;` and a 3-line `history.import.*` dispatch.
  - `crates/ade-daemon/src/sessions/agents.rs`: 2 guard lines.
  - `crates/ade-daemon/src/sessions/conversations.rs`: 1 guard line.
  - `crates/ade-daemon/src/history.rs`: module, table creation, joins and provenance.
  - `apps/cli/src/index.ts`: 3 lines.
  - Generated contract files, regenerated.
- `THIRD-PARTY-NOTICES.md`: no entry is needed, because no code was copied.
