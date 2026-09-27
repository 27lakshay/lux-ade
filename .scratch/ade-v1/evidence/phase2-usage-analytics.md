# usage-analytics

Status: returned
Type: slice evidence
Branch: claude/wf_146e803f-a25-5
Worker: Phase 2 round C, usage-analytics slice
Requirements: F049 (usage analytics, backend), F030 (quota and limit visibility, backend capture only)

## Outcome

The daemon now records the token, cost and rate-limit figures that Codex, Claude Code and Oh My Pi report in their protocol events. It keeps one durable record per turn, with provenance: conversation, workspace, provider, account, source event, scope and models. Typed `usage.*` queries aggregate the records by conversation, workspace, provider, account or day, list per-turn records, and show the latest reported limit windows. A figure a provider did not report stays `null`, and every aggregate counts the turns that could not be included. Neither requirement is fully accepted; both need E2E and UI evidence.

What each provider reports, and how ADE records it:

| Provider | Native event | Per-turn tokens | Cost | Limits |
|---|---|---|---|---|
| Codex | `thread/tokenUsage/updated` (thread running `total`, newest response `last`) | Growth of `total` within one runtime run; `last` when there is no baseline from the run, or when the total went down. Main agent only. | Not reported; always unavailable | `account/rateLimits/updated`: `primary`/`secondary` windows, percent, window length, reset, plan. The update is sparse, so a null window leaves the stored one alone. |
| Claude Code | SDK `result` (cumulative `modelUsage` and `total_cost_usd` per `query()` call; per-turn main-loop `usage`) | Difference from the previous result of the same query, covering all agents. The first result of a fresh query is the turn itself. For a resumed query, or totals that went down after `/clear`: main-loop `usage` only, with a note. | The agent's own estimate, differenced the same way. Unavailable when it cannot be attributed, or when any model's `costBasis` is `unknown`. | `rate_limit_event`: one window per event. `utilization` is a 0–1 fraction and `resetsAt` is in epoch seconds. |
| Oh My Pi | `message_end` of each assistant message (`usage`, catalogue-priced `cost`) | Sum of the turn's model calls. A field missing from any call makes the turn's figure unavailable, rather than an undercount. | The catalogue estimate. A zero cost on a call that used tokens counts as unpriced, and so unavailable. | None reported in the protocol |
| OpenCode | None captured | Turns are recorded as unreported | Unavailable | None |

Token normalization: `input` counts every prompt token, including cache reads and writes. `cached_input` and `cache_write` are parts of `input`, and `reasoning` is part of `output`. This matches Codex's `inputTokens`. For Claude and Oh My Pi, `input` is computed as input plus cache read plus cache write.

Durability and replay:

- The Sessions event loop collects each batch's usage reports and turn completions. It records them in one usage transaction before it commits the conversation. The transaction advances a per-conversation cursor of `(run, event sequence)`. A batch replayed after a crash between the two commits is therefore skipped, not counted twice.
- Running-total baselines (Codex per run, Claude per `query()` ID) are stored in the same transaction. A total from another stream is never subtracted.
- A completed turn with no report gets a row with no figures, so aggregates show it as unreported.
- Recording never fails a conversation. A batch that cannot be saved is logged and counted in `recording.dropped_batches`, which every reply carries. The counter is in memory and resets when the daemon restarts, because a failing database cannot store it.
- A report ADE cannot parse (a missing required field, a negative count or an unknown source) is logged and leaves its turn unreported. It is never zeroed.
- Tables (`usage_turns`, `usage_baselines`, `usage_cursor`, `usage_limits`) live in `sessions.sqlite` and are created idempotently by `Usage::open`. No migration or backup version pin changed.

## Operation tiers

| Operation | Tier | Request | Response |
|---|---|---|---|
| `usage.summary` | query | `UsageSummaryRequest` | `UsageSummary` |
| `usage.turns` | query | `UsageTurnsRequest` | `UsageTurns` |
| `usage.limits` | query | `UsageLimitsRequest` | `UsageLimits` |

Internal (not a wire operation): `Event::Usage { session, turn, source, report }` in `ade_core::provider`, which is emitted by the Codex decoder and by the Claude and Oh My Pi bridges.

CLI: `apps/cli/src/commands/usage.ts` adds `usage summary --by …`, `usage turns` and `usage limits`. For `--by day` it defaults to this machine's current UTC offset.

## Checks

- `pnpm check:static`: pass
- In-process tests added:
  - `crates/ade-daemon/src/usage/core.rs`: Codex deltas, reset and new-run fallback, and rejecting malformed input. Claude differencing, the fresh and resumed cases, a reset after `/clear`, unpriced models and missing totals. Oh My Pi summing, the rule that one missing field makes the whole figure unavailable, and unpriced calls. Limit units. Aggregation with unreported turns. Day keys with offsets. Cursors.
  - `crates/ade-core/src/contract/usage.rs`: schema round-trips.
- Provider bridge legacy tests still pass (`providers/claude` `node --test bridge.test.mjs`: 9 pass; `providers/omp` `bun test bridge.test.mjs`: 5 pass). No tests were added to them.
- A throwaway in-process smoke test ran the SQL path once and was then deleted, as the test policy requires. It covered idempotent schema open, Codex accumulation across two updates, replaying the same batch with no double count, a completed turn with no report, a sparse limit update, an unknown source, summary by provider and by day, turn paging with a cursor, limits with `reset_since_observed`, and rejected parameters.

Verified only statically (types, Clippy, contract check), with no committed runtime coverage:

- the SQL statements in `crates/ade-daemon/src/usage.rs`
- the `agents.rs` event-loop capture and its ordering relative to the conversation commit
- the Codex decoder arms, the Claude and Oh My Pi bridge emissions against real providers, and the CLI module

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 75 | 5 | 10 | 0 |

## References

- t3code @ ade-evaluation-2026-09-24, `apps/server/src/provider/Layers/CodexAdapter.ts` (`codexTurnTokenUsageDelta`, `completeCodexTurnTokenUsage`), pattern adapted → `crates/ade-daemon/src/usage/core.rs` (MIT, header added).
- t3code @ ade-evaluation-2026-09-24, `apps/server/src/provider/Layers/claudeUsageLimits.ts` and `codexUsageLimits.ts`, studied for the units of `rate_limit_event` and `RateLimitSnapshot`. Unlike t3code, ADE does not infer window lengths that Codex omits.
- t3code @ ade-evaluation-2026-09-24, `packages/effect-codex-app-server/src/_generated/schema.gen.ts`, studied for `ThreadTokenUsageUpdatedNotification`, `TokenUsageBreakdown` and `AccountRateLimitsUpdatedNotification`.
- `@anthropic-ai/claude-agent-sdk` 0.3.281 `sdk.d.ts` (pinned in `providers/claude/package.json`), consulted for `SDKResultMessage.modelUsage` and `total_cost_usd` (cumulative per `query()`), per-turn `usage`, `ModelUsage.costBasis` and `SDKRateLimitEvent`.
- `@oh-my-pi/pi-catalog` 18.3.0 `src/types.ts` (`Usage`), consulted for Oh My Pi's per-message usage and cost fields.

## Open

- E2E, when UI work begins: F049 "aggregate available usage by time/provider/account with units, source and missing-data indicators; do not invent billing values", against real providers. F030 limit visibility.
- UI: the usage and limits surfaces.
- Limits are only as fresh as the last turn. No probe runs between turns: Codex `account/rateLimits/read` and Claude's `get_usage` control request are not called. Oh My Pi's auth usage reports are not read.
- Subagent usage: Codex child threads and Oh My Pi subagents are excluded (scope `main_agent`). Claude's all-agents figures include them.
- OpenCode usage is not captured; its turns count as unreported.
- `recording.dropped_batches` resets with the daemon. Usage rows outlive a deleted conversation; retention for them is not defined.
- `usage.summary` aggregates in memory and refuses more than 200,000 matching turns rather than return a partial answer.
- Shared files touched: `crates/ade-core/src/provider.rs` (one `Event::Usage` variant); `crates/ade-daemon/src/lib.rs` (+1 line); `crates/ade-daemon/src/sessions.rs` (a `usage` field, its open call and a `usage.*` dispatch branch); `crates/ade-daemon/src/sessions/agents.rs` (capture in `events()`); `crates/ade-runtime/src/codex.rs` (two decoder arms); `providers/claude/bridge.mjs` and `providers/omp/bridge.mjs` (usage emission); `apps/cli/src/index.ts` (3 lines).
- Coordinator: add a t3code (MIT, © 2026 T3 Tools Inc.) entry for `crates/ade-daemon/src/usage/core.rs` to `THIRD-PARTY-NOTICES.md`.
