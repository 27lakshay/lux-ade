# phase1-terminals

Status: returned
Type: slice evidence
Branch: claude/wf_e0896549-359-5
Worker: Phase 1 typed domains, terminals worker
Requirements: none (foundation work, D02 wire typing)

## Outcome

The daemon's five public `terminal.*` operations now decode typed requests and
build typed replies from `crates/ade-core/src/contract/terminals.rs`.
`terminal.create` keeps its receipts in the shared `operations` table through
`receipts.rs`; `operation_id` is the canonical field and `request_id` still works.
The daemon's own calls to the runtime's terminal commands use typed Rust structs,
and the CLI's terminal commands use the generated contracts.

## Operation tiers

Registered in the client bundle (daemon command socket):

| Operation | Tier | Receipt |
|---|---|---|
| `terminal.create` | effect command | `operations` table via `receipts.rs` (was `terminal_creations`) |
| `terminal.operation` | query | Reads the `terminal.create` receipt |
| `terminal.restart` | effect command | None; none existed before |
| `terminal.stop` | effect command | None; none existed before |
| `terminal.retire` | effect command | None; none existed before |

Typed as Rust-only runtime commands in `contract::terminals::runtime`, not in
the client bundle, because the daemon command socket rejects them
(`Unknown session operation`). They travel only from the daemon to the runtime
supervisor:

| Runtime command | Tier if later exposed |
|---|---|
| `terminal.ensure` | effect command (may launch a shell) |
| `terminal.launch` | effect command |
| `terminal.list` | query |
| `terminal.tail` | query |

Terminal stream frames (`subscribe`, `input`, `resize`, `ping`; replies
`snapshot`, `terminal`, `metrics`, `error`) are not typed. The daemon copies
them between the client and the runtime without parsing, so they do not pass
through the daemon protocol and are not `session.subscribe` feed frames.

## Wire notes

- `terminal.create`: `operation_id` (alias `request_id`) may be absent, but not
  `null`; the daemon rejects `null` and non-strings with `Invalid terminal
  request ID`, so the schema types it as a string.
- `terminal.operation`: a request with neither `operation_id` nor `request_id`
  keeps the `Missing request_id` message. The reply keeps the `request_id` field.
- `terminal.stop` and `terminal.retire` used to forward the client's whole
  request to the runtime and return the runtime's reply. They now send only
  `op`, `workspace_id` and `terminal_id` and reply `{"type":"ack"}`, which is
  what the runtime returned.
- `terminal.restart`: a non-string `workspace_id` or `terminal_id` used to be
  ignored (falling back to the default workspace or primary terminal); it is
  now an `Invalid request` error. `null` still falls back.
- Receipt conflicts: `operation_id` values now share one namespace with every
  other effect command in `state.sqlite`. Reusing another operation's ID for
  `terminal.create` is a conflict, reported with the existing message
  `Terminal request ID conflicts with another workspace`. A reused ID older
  than 30 days returns `Terminal request ID has expired; use a new ID` (new).

## Checks

- `pnpm check:static`: pass
- In-process tests added: `crates/ade-core/src/contract/terminals.rs` (schema
  round trips and runtime command shapes). `contract/tests.rs` tier list gained
  the five terminal operations.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 45 | 0 | 5 | 0 |

## References

None.

## Open

- `terminal_creations` is no longer written. `store::terminals` still reads it
  as a fallback so IDs recorded before this change replay. The coordinator can
  drop it after a migration copies its rows into `operations`.
- `receipts.rs` has no read-only lookup; `Store::terminal_creation` queries the
  `operations` table directly. A shared `receipts::lookup(connection, id)` would
  serve every `*.operation` query.
- `services.rs`, `scripts.rs`, `sessions.rs` and the runtime supervisor still
  build and read terminal runtime commands as untyped JSON; they can switch to
  `contract::terminals::runtime` in their own slices.
