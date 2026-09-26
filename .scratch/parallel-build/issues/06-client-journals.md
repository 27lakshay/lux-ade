# Why do the Electron send and Git journals exist?

Status: closed
Type: wayfinder ticket (research, AFK)
Label: wayfinder:research
Map: [Parallel build](../README.md)
Assignee: claude (research subagent, 2026-09-27)
Blocked by: none

## Question

What failure does each of `apps/desktop/src/main/send-journal.ts` and `git-journal.ts` guard against that the daemon's durable `send_intents` and operation receipts do not? What does the CLI do for the same failures?

Trace the send and Git mutation paths from renderer to daemon receipt. List every crash window each journal covers, the E2E specs that prove it, and whether the same guarantee could live in `@ade/client` (shared by CLI and desktop) or in the daemon. Also locate the feed catch-up logic in `apps/desktop/src/renderer/src/main.tsx:605-665` and state what moving it into `@ade/client` would require.

## Comments

- 2026-09-27 (claude): findings in [research/06-client-journals.md](../research/06-client-journals.md).
  Only the send journal covers the pre-admission window (crash before `draft.save` or `prepare`; review notes). After admission, the daemon's `send_intents`, message-ID dedup and `jobs` receipts already make retry safe.
  The journals add what the daemon lacks: list by owner or workspace, an offline pending list, the quit gate, profile transfer and Git acknowledgement. The CLI leaves all of this to the caller's `--request-id`.
  Recommendation: move post-admission recovery into the daemon and keep a small pre-admission outbox in `@ade/client`. Feed projection can move to a transport-free SDK core, but cursors cannot persist until the daemon has a durable feed. Git pre-admission, lost-reply and acknowledgement windows have no E2E.
