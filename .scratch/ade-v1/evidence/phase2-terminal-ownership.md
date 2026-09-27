# Phase 2: terminal ownership

Status: returned
Type: slice evidence
Branch: claude/wf_8cf324d1-7c0-5
Worker: Phase 2 parallel build, slice terminal-ownership
Requirements: F083 (input and viewport ownership, target incarnation). Advanced, not fully accepted.

## Outcome

Terminal attachments now carry their stream incarnation (the terminal host's `run_id`).
Input, resize, detach and subscribe that name another incarnation are refused with
`stale_incarnation`; input and resize on an exited incarnation are refused with
`incarnation_exited`. Viewport ownership is explicit: one attachment owns and resizes, others
observe, and owners learn of transfers through a `viewport` frame. The ownership and fencing
decisions live in the pure module `crates/ade-runtime/src/terminal_ownership.rs`.

Wire changes, all additive:

- Requests may carry `run_id`. Absent or `null` is accepted, so older single-client callers
  behave as before. A non-matching or non-string `run_id` is stale.
- The `subscribe` snapshot carries top-level `run_id` and `attachment`.
- `terminal` and `terminal_resize` frames carry `run_id`.
- New `viewport` frame `{owner, attachment, run_id}` goes to the previous and next owner on a
  transfer only.
- New stream op `detach`: releases viewport ownership, replies `detached`, closes the attachment.
- Refusals are `error` frames with `code` and the current `run_id`.

Client SDK (`packages/client/src/terminal.ts`): binds to the snapshot's `run_id`, stamps it on
every later request, closes with `stale_incarnation` if a frame names another incarnation,
accepts an optional expected `runId`, and adds `incarnation()` and `detach()`. The desktop
detach IPC and the CLI Ctrl-] detach now send `detach`.

Behaviour change to note: input or resize sent to a terminal whose process has exited used to
be written to the dead PTY silently; it is now refused. The live single-client path is
unchanged: an `update` resize with no owner still claims, and input still moves ownership to a
registered attachment.

## Operation tiers

- Terminal stream ops `input`, `resize` and `detach` (not on the command socket; they have no
  contract, like the existing stream ops, see `contract/terminals.rs` `frames()`): fenced
  idempotent commands. Repeating a detach or an unchanged resize converges.
- `subscribe`: query, now fenced by incarnation.

## Checks

- `pnpm check:static`: pass
- In-process tests added: `crates/ade-runtime/src/terminal_ownership.rs` (8 tests: single owner,
  observer update, claim transfer, input transfer, hand-off on detach, tie-break, stale and
  malformed incarnation, exited incarnation).

Verified only statically: the terminal host wiring in
`crates/ade-runtime/src/bin/supervisor/terminal_host.rs`, the SDK stamping and stale-frame
close, the desktop and CLI detach calls.

Needs E2E later:

- Two real attachments: the observer's resize does not change the PTY; typing in the observer
  moves ownership; closing the owner hands the size to the survivor (Herdr `multi_client.rs` shape).
- Restart a terminal, then send input with the earlier `run_id`: refused, nothing reaches the new shell.
- Input after the process exits: `incarnation_exited`, and `terminal send` fails instead of reporting success.
- CLI Ctrl-] detach leaves the shell running and releases ownership.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 35 | 5 | 5 | 0 |

## References

- Paseo @ c356394, `packages/server/src/terminal/terminal-size-ownership.ts`, pattern → claim/update intents in `crates/ade-runtime/src/terminal_ownership.rs` (ported to Rust with a `Portions adapted from` header, Apache-2.0).
- Orca and Herdr entries in the reference map were read from the map only, not studied.

## Open

- Coordinator: add a Paseo (Apache-2.0) entry to `THIRD-PARTY-NOTICES.md` for
  `crates/ade-runtime/src/terminal_ownership.rs`, source path above, "Ported to Rust; added
  input transfer, ranked hand-off and incarnation fencing".
- The terminal stream ops have no typed contract. If the stream gets one, add `run_id`,
  `attachment`, the `viewport` and `detached` frames and the refusal codes.
- The renderer (`packages/terminal`) does not yet show whether its view owns the viewport.
- No new state.sqlite migration.
