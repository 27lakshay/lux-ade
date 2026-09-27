# Audit minor fixes: services-ops

Checks: `pnpm check:static` passed (710 legacy Rust tests, rustfmt, Clippy, architecture, typecheck, Fallow, builds). `pnpm contract:generate` rerun after a doc-comment change.

## 1. Health sampling blocked the 250 ms tick thread

- Confirmed: `Sessions::open` ran `sample_due_service_health` (lsof, HTTP probe, runtime List/Tail) on the same thread as `release_exited_script_leases`, `reconcile_unresolved`, `recovery_tick` and `flush_activity`. A slow sample delayed every activity frame and reconciliation pass.
- Fix: `crates/ade-daemon/src/sessions.rs` gives the health monitor its own 250 ms thread, holding only a `Weak<Sessions>` as the tick and retention threads do. The tick thread no longer calls it. The sampler keeps its own fences: it skips while draining, caps concurrent samples at 4, and re-checks service identity under the lock after the probe. No lock is held across the probe.
- Test: none. The change is thread placement with no decision to extract; the selection and fencing logic is unchanged.

## 2. diagnostics.status ignored the plugins store's receipts

- Confirmed: `Plugins` settles lost effects as `Status::Unknown` in `sessions.plugins.sqlite3`. `observability::Stores` listed only sessions, lifecycle and review, so the unknown plugin operation and a plugins tally were missing. Retention already listed plugins.
- Fix: one shared list, `receipts::side_stores`, in `crates/ade-daemon/src/receipts.rs`. Retention (`sessions/retention.rs`) and `observability::Stores::receipts` both use it, and `server/diagnostics.rs` loops over it. The `DiagnosticReceipts.store` doc now names `plugins`; the wire shape is unchanged.
- Tests (in `crates/ade-daemon/src/observability.rs`):
  - `stores_report_every_receipt_store_including_plugins` fails on the old `Stores` because it had no plugins path.
  - `plugin_store_unknown_receipt_is_reported` shows that an unknown receipt in a plugins store appears in the tally and in the `unknown` list.

References: `crates/ade-daemon/src/plugins.rs` (`settle_unknown`), `docs/proposed-architecture.md` section 4.
