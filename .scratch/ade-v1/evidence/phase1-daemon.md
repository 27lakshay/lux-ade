# Phase 1 daemon contracts

Status: returned
Type: slice evidence
Branch: claude/wf_e0896549-359-10
Worker: Phase 1 typed domains, daemon worker
Requirements: none (typed wire contracts, D02)

## Outcome

`crates/ade-core/src/contract/daemon.rs` now types the handshake, `runtime.*`,
`session.subscribe`, every `browser.*` operation and the `service_changed` feed
frame. The daemon handlers in `bin/daemon/server.rs` decode typed requests and
build typed replies. Browser mutation receipts moved from an in-memory
`HashMap` onto `receipts.rs`, backed by an in-memory SQLite `operations` table.
The CLI browser commands, the desktop browser owner registration and the SDK
hello check use the generated types.

## Operation tiers

| Operation | Tier | Response type |
|---|---|---|
| `hello` | query | `DaemonHello` |
| `runtime.status` | query | `RuntimeStatus` |
| `runtime.prepare_restart` | effect command | `RestartPrepared` |
| `session.subscribe` | query | `CatalogFrame` (first feed line) |
| `browser.owner.get` | query | `BrowserOwnerReply` |
| `browser.owner.register` | idempotent command | `BrowserOwnerReply` |
| `browser.owner.unregister` | idempotent command | `BrowserOwnerReleased` |
| `browser.list` | query | `BrowserTabs` |
| `browser.inspect` | query | `BrowserTabReply` |
| `browser.open` | effect command | `BrowserMutation` |
| `browser.navigate` | effect command | `BrowserMutation` |
| `browser.close` | effect command | `BrowserMutation` |
| `browser.operation` | query | `BrowserOperation` |

Feed frame: `service_changed` (`ServiceChanged`).

## Wire notes

- Browser mutations and `browser.operation` take `operation_id`; `request_id`
  stays accepted as a serde alias. Schemars does not emit the alias, so the
  generated request schema names only `operation_id`. Replies and the
  daemon-to-owner protocol still carry `request_id`.
- The receipt fingerprint is `receipts::fingerprint` of
  `[op, profile_id, owner_id, tab_id, url]`. It equals the old
  `sha256(json)` value byte for byte, which the desktop owner recomputes; a
  test in `server.rs` pins this.
- A dispatched or unknown browser receipt stores `{"owner_id"}` as its result
  so `browser.operation` can name the owner; settlement replaces it with the
  owner's reply.
- `BrowserOperation.result` keeps `null` (daemon receipt before completion)
  apart from absent (owner receipt without a tab).
- Owner replies to `browser.list`, `browser.inspect`, `browser.operation` and
  mutations are now decoded into their typed shape. A non-error owner reply that
  fails its contract now returns `protocol` ("Browser owner reply failed its
  contract") for reads, `unavailable` for `browser.operation`, and
  `outcome_unknown` for mutations. Before, the daemon relayed it unchanged.
- Existing error messages are kept: the legacy field checks run before the
  typed decode. A field with the wrong JSON type after those checks now reports
  `Invalid request: <serde message>`.

Shapes not confirmed by a running process (no E2E tonight):

- `BrowserTabRecord` follows the desktop `Tab` type in
  `apps/desktop/src/main/browser.ts`; nothing checked it on a live owner.
- `RuntimeStatus.terminals` and `.agents` are relayed runtime values, typed as
  `Value`. `ServiceChanged.service` and `.metrics` are typed as `Value`.
- `proxy.*` calls go from the daemon to the runtime supervisor socket, not the
  client protocol, so they stay untyped. The client-facing `service.proxy.*`
  operations are not in this slice.

## Checks

- `pnpm check:static`: pass
- In-process tests added: `crates/ade-core/src/contract/daemon.rs` (schema
  round trips, tiers, alias, null versus absent);
  `crates/ade-daemon/src/bin/daemon/server.rs` (fingerprint compatibility,
  replay codes, receipt owner and rollback).

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 75 | 0 | 10 | 0 |

## References

None.

## Open

- `crates/ade-core/src/contract/tests.rs`: `every_operation_declares_a_tier_and_named_types`
  asserted the whole operation list, so any new domain broke it. This slice
  filtered it to the `workspaces` and `conversations` domains. Other workers
  may make the same edit.
- `service_changed` is registered here as a `session.subscribe` frame. If the
  services worker also registers it, keep one.
- `conversation_reload` is a conversation frame and is left to that domain.
- `receipts.rs` has no read-by-ID function. `server.rs` queries the
  `operations` table directly (`browser_receipt`). A shared `receipts::lookup`
  would remove that.
- Browser receipts stay in memory for one daemon process, as before. The old
  `HashMap` table is gone, not left in place, because it lived only in
  `server.rs`.
- `runtime.prepare_restart` is an effect command without an operation ID or
  receipt; adding one changes the wire.
- Not switched to generated types: `apps/cli/src/index.ts` (`status` sends
  `hello`), the transport handshake inside `packages/client/src/request.ts`,
  and the Rust `ade-control` callers of `hello` and `runtime.prepare_restart`.
