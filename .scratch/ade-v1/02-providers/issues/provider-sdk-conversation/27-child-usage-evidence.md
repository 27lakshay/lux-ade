# 27 — Inspect child activity, usage and quota evidence

Status: complete
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Inspect supported child activity/transcripts and reported usage/quota while retaining their provenance, units and uncertainty.

**Blocked by:** [11 — Show yielded, background and autonomous activity](11-background-activity.md), [12 — Load bounded history with correct tool attribution](12-bounded-history.md)

**Spec coverage:** PC02, PC10, PC11, PC29, PC35. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Child observations identify source parent/session/attempt and use explicit correlation. Child output cannot be attached to a parent turn by reused tool name or similar text.
- [x] Supported child transcripts load within history bounds; unavailable access remains explicit, and tool context outside a page remains readable/incomplete.
- [x] Display usage and quota with native source, units, observation time and freshness. Missing values do not become zero usage or invented billing estimates.
- [x] Provider-native notices, exposed reasoning and file/command changes retain core content and links to existing ADE resources where supported.
- [x] CLI/SDK and desktop agree on native evidence and supported limits; optional renderers cannot become the sole readable representation.
- [x] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Emit child events with reused IDs, autonomous updates and partial usage through real-process peers; inspect provenance and missing-value presentation in built desktop.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.

2026-10-02: Implementation and acceptance (decisions taken under the user's standing instruction to decide unattended).

Decisions (option B, recorded on ticket 06):
- A provider that reports no turn IDs (Claude) has its usage keyed by the submission the turn ran. `Event::Usage` gained an optional `submission`; the daemon records a report under the turn ID when present, else the submission, and the turn's end under the finished submission. Limit reports never attach to a turn.
- Child observations keep the correlation the workers already enforce: a Claude child is a native task identified by its task ID and Agent tool call, fenced against stale tool IDs; nothing attaches by tool name or text. The Claude descriptor now declares `child_transcript` (ticket 19), so child pages load through the daemon within the existing page bounds; an unavailable child says why.
- Desktop (provisional): "Usage and limits" lists each turn's tokens, cost with its basis ("the agent's estimate") or "cost not reported", the native source and when ADE observed it; a turn with no report says so rather than showing zero. Limits show used percent, window, reset, provider status, source and "as of" time, and flag a window that has reset since its report. Main forwards `usage.limits` as a provider-scoped read. A subagent message lists its child agents with "Show transcript" and paged loading; the parent's summary stays readable without it.
- Notices, exposed reasoning and file or command changes keep the existing tool and reasoning renderers with their readable text fallback.

Evidence:
- `pnpm check:static`: passed (`test-results/runs/static-253c866b-346e-4099-9d2d-a80b2d03d112`).
- Real processes: `catalogs/usage.spec.ts` 6/6, including the two Claude cases (per-turn cost as agent estimates, an unpriced turn, a silent turn, and aggregation across providers by workspace, account and day); `ops3/operation-coverage.spec.ts` child transcript through the SDK and CLI.
- Built Electron: `e2e/desktop/usage-children.spec.ts` (`test-results/runs/desktop-7388dbf8-1d0b-4659-a353-eab43f2609f8`): turn usage and limits match `usage.turns`; a child transcript opens from the parent message. Screenshot `usage-children.png`.

Not covered: Claude native history in the desktop with the SDK double. The daemon reads Claude history from Claude's own session files, which the double does not write there, so the view shows an explicit "transport failure" for native history in those tests. Installed-Claude history has the loopback evidence on ticket 06. No live quota run.
