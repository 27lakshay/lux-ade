# 30 — Keep conversations and control responsive under load

Status: complete
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Keep conversations, reconnect and Stop responsive under concurrent output while reporting bounded overload honestly.

**Blocked by:** [05 — Stop an identified execution truthfully](05-identified-stop.md), [13 — Reconnect and merge history with live output](13-reconnect-live-merge.md), [24 — Render namespaced timeline content with a core fallback](24-timeline-contributions.md)

**Spec coverage:** PC16, PC27, PC31, PC33, PC34, PC36. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Record a reference machine, ADE artifact, workload and sampling method, then establish numeric budgets for opening, first response, input/Stop latency, history prepend, catch-up and retained memory.
- [x] Bound SDK frames/RPCs/queues, replay capture, retained native payloads, decoded history and cleanup by bytes and applicable counts. Slow consumers cannot block unrelated conversations or critical control.
- [x] Send leading visible output promptly and coalesce only compatible presentation updates. Flush preceding output before requests, terminal tool states, errors or turn boundaries; durable events retain order.
- [x] Use the utility-process stream bridge and frame projection publication; avoid synchronous filesystem/network work in Electron main/renderer and avoid unnecessary work in suspended views.
- [x] Overload or storage failure exposes degraded recovery/resource limits rather than silent drops or a false complete view. Stop stays reachable under declared emergency control limits.
- [x] Repeated open/close and plugin disposal return resources within the measured policy; sanitized correlated diagnostics explain gaps without tracing every token or leaking prompts.
- [x] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Use isolated application performance workloads and real-process flood/storage-failure fixtures; operate Stop and reconnect in built Electron. Keep diagnostics separate from timing samples and publish exact measured budgets.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.

2026-10-02: Implementation and acceptance (decisions taken under the user's standing instruction to decide unattended).

Reference machine (recorded in each run's `performance.json`): darwin 25.6.0, arm64, 10 logical CPUs, 24 GiB; debug daemon and runtime built from this tree (binary SHA-256 and revision in the file); real daemon and runtime with the Codex mock behind the flood proxy; no model latency and no Electron rendering. Sampling: raw samples for each step are kept; budgets are checked against the 95th percentile.

New workload `e2e/protocol/load/conversation.spec.ts` (`pnpm test:performance --grep 'conversation:'`, documented in docs/testing.md), with budgets at about five to ten times the reference percentiles:

| Measure | Budget | Reference runs (p95) |
| --- | --- | --- |
| Open (bounded first page) | 100 ms | 6, 7, 5 ms |
| First output (send → first reply frame) | 500 ms | 105, 104, 104 ms |
| Stop while another conversation floods 40 MiB | 500 ms | 33, 19, 295 ms |
| History prepend | 150 ms | 24, 6, 4 ms |
| Catch-up after a daemon kill | 3 s | 142, 99, 103 ms |
| Footprint growth over 20 feed open/close cycles | 32 MiB | 0.2, 0.4, 0.3 MiB |

Runs: `test-results/runs/performance-command-8a50fd42-ea18-49e9-9255-6abd650c1331` (before tightening the budgets), then `performance-command-53550480-…` and `performance-command-3108ad5b-…` (passing at the final budgets).

Bounds and honesty already covered by earlier slices and existing suites: SDK input and output frame limits (ticket 16), worker event backpressure (ticket 05), feed eviction with a named `feed_overflow` frame (ticket 13; its delivery to a client that is still reading has no deterministic test, as ticket 13 records), slow subscribers not blocking others (`reliability-b/slow-subscriber.spec.ts`), output limits (`reliability-b/output-limit.spec.ts`), full-disk refusal with Stop still working (`reliability-a/overload.spec.ts`), stream bridge in a utility process and once-per-frame projection publication in the desktop.

- `pnpm check:static`: passed (`test-results/runs/static-9e370d31-fd45-455f-bc99-d88dc49a0a47`).

Not covered: Electron rendering cost (the workload is headless; the performance suite records it as deferred), plugin disposal resource return, and a second reference machine. Stop latency varied from 19 to 295 ms across runs; the budget leaves room for that, but the spread is worth watching.

2026-10-02 (ticket 32 reconciliation):
- Found and fixed a burst defect: the Codex worker paused the native stream when its event queue filled but kept parsing the rest of the chunk already read, so 400 small text deltas overflowed the 32-entry queue and failed the session with `resource_limit`. It now stops parsing at the pause and keeps the rest of the chunk for its resume (`providers/codex/worker.mjs`). Real-process `e2e/protocol/conversations/burst.spec.ts` (failed before the fix with "Provider data exceeds the supported byte, node, or nesting budget").
- Built-desktop measurements, `e2e/desktop/conversation-performance.spec.ts`: 20 open/close cycles of a 12-turn conversation view, median 152 ms, worst 331 ms, heap +2.9 MB after collection, DOM node count back to baseline (budgets 400 ms, 1.5 s, 16 MiB, 500 nodes); typing while two other conversations stream, median 26 ms key-to-frame, worst 139 ms, no long tasks (budget 50 ms median, 250 ms longest task). One machine only.
- Visible ordering, `e2e/desktop/burst-ordering.spec.ts`: a page-side mutation observer records when burst text, the approval request, text after it, the failed tool and the failed turn first draw; text is never drawn after what follows it.
Full runs: final static `static-d1f7cb5d-435a-4360-9aae-5d44902a5d16`; protocol `protocol-96876d9c-01d2-48b0-a527-f039a873f725` (1109 passed, 6 failed, none in this change); desktop `desktop-a193103e-fab0-45c6-af5d-0d5cd4b6de11` (130 passed, 2 failed, both passing alone).
