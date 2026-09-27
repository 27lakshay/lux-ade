# e2e-catalogs

Status: returned
Type: slice evidence
Branch: claude/wf_8e5e7c6f-164-8
Worker: ADE parallel build, E2E round 1, slice catalogs
Requirements: F131, F132, F041, F042, F043, F049, F030

## Outcome

Headless protocol E2E now covers the MCP catalog, the skill catalog, history
search, session import and usage analytics. The specs drive real daemons and
runtimes through the SDK, the CLI and the raw protocol. 23 tests pass and 4 are
`test.fixme`, each for a real product gap. No spec exposed a product bug, so
no product code changed. The provider mocks gained a `usage` prompt, because
no scripted prompt reported usage before.

Full register acceptance now passes as protocol E2E for **F041**, **F042** and
**F049**. For F049 this holds against the provider mocks' events; no real
provider was run. F131, F132, F043 and F030 remain partial.

## Acceptance criteria

Specs are in `e2e/protocol/catalogs/`.

### F131 Central MCP catalog

| Criterion | Spec | Result |
|---|---|---|
| Register a server once per profile: add, update and remove under the revision guard; a duplicate add converges; a conflicting add or a stale update or remove is refused; the entry survives a daemon kill | `mcp.spec.ts` "adds, updates and removes an entry…" | pass |
| Duplicate and racing writers: six parallel identical adds give revision 1; of two racing updates at one revision, exactly one applies | `mcp.spec.ts` "concurrent writers…" | pass |
| CLI parity and JSON errors | `mcp.spec.ts` "the CLI drives the same catalog…" | pass |
| Fail closed: literal credentials, credential arguments, `${`, remote plain HTTP, unknown workspace or provider, raw secret field (refused by the SDK contract and by the daemon) | `mcp.spec.ts` "fails closed…" | pass |
| Scope resolution: profile, workspace and repository scopes; provider selection; disabled entries; unsupported projections named with a reason; Claude `${VAR}` and Codex `env_vars` documents; `delivery: direct`; `wired: false` | `mcp.spec.ts` "resolves scope and provider selection…", "a repository-scoped entry…" | pass |
| Expose the server through compatible adapters, with both-leg capability and authorization handling | `mcp.spec.ts` "a provider launched in a workspace receives the resolved MCP servers" | fixme: no adapter reads `mcp.resolve` (`WIRED_PROVIDERS` is empty) and there is no ADE gateway |
| Show the direct-provider fallback explicitly | covered by `delivery: "direct"` and `wired: false` in the resolution specs | pass (reporting only) |

### F132 Central skill catalog

| Criterion | Spec | Result |
|---|---|---|
| Install a complete bundle with provenance and a pinned hash; operation-ID replay after a daemon kill; operation-ID conflict; a pin mismatch is refused; replacement needs the installed hash; the bundle stays inspectable after its source is deleted; remove needs the current hash | `skills.spec.ts` "installs a pinned bundle once…" | pass |
| Six parallel requests with one operation ID apply once; racing adoptions own a path once | `skills.spec.ts` "concurrent duplicate requests…" | pass |
| Incomplete, misnamed and relative-path bundles are refused | `skills.spec.ts` "refuses bundles…" | pass |
| Discover global and workspace skills for Claude and Codex (valid, invalid and symlinked entries; present and missing roots). Adopt with the discovered hash; refuse a stale hash, a symlink and a path outside a provider root. Release on remove. The HOME and repository trees are byte-identical before and after | `skills.spec.ts` "discovers, adopts and releases…" | pass |
| An adopted skill edited outside ADE shows as `adopted_drifted` and is not rewritten | `skills.spec.ts` "an adopted skill edited outside ADE…" | pass |
| Invoke through adapter rules | `skills.spec.ts` "an installed bundle is placed for a provider and invoked through its adapter" | fixme: placement and adapter invocation are not built |
| Remote installation is explicit | not covered: remote installation is not built |

### F041 Combined history

| Criterion | Spec | Result |
|---|---|---|
| Search and read history across Codex and Claude in one profile; provider and conversation filters; `history.list` across providers | `history.spec.ts` "searches Codex and Claude history together…" | pass |
| Native session references kept; no implied cross-provider continuation (distinct native IDs, no `import` provenance on live conversations) | same | pass |
| Imported sessions carry `provenance.import` with `resumable: false` | `imports.spec.ts` first test | pass |

### F042 External session import

| Criterion | Spec | Result |
|---|---|---|
| Import a fixture Claude Code transcript twice, and again after a daemon kill, with one conversation and no duplicate messages; the scan reports the imported conversation | `imports.spec.ts` "imports a Claude Code session twice…" | pass |
| Retain source provenance (source path, native cwd, native session ID) and distinguish the read-only import: status `imported`, `resumable: false` with a reason, `agent.send` refused with no provider call, native file untouched | same | pass |
| Codex rollout: a late tool result updates its call; appended records extend the import; an incomplete tail waits; rewritten history is refused and leaves the import unchanged; a different workspace is refused; private reasoning is never imported | `imports.spec.ts` "extends a Codex import…" | pass |
| Six parallel duplicate imports create one conversation | `imports.spec.ts` "concurrent duplicate imports…" | pass |
| A missing store reports `available: false` with a reason; unknown and malformed session IDs are refused; CLI scan | `imports.spec.ts` "reports a missing native store…" | pass |

### F043 Work search

| Criterion | Spec | Result |
|---|---|---|
| Search retained indexed content (user and assistant text, prefix terms, literal operators) and open the correct resource: each hit's `message_id` opens that text through `conversation.get` | `history.spec.ts` first test | pass |
| Show indexing lag explicitly: every reply carries index status, and `caught_up` never appears with pending changes or a rebuild | all `history.spec.ts` searches | pass |
| Pagination; a rebuild moves the epoch, a repeated rebuild converges, and an old cursor expires | `history.spec.ts` "pages results…" | pass |
| Catch up after a daemon kill, including a turn in flight at the kill, with no lost or duplicated hits | `history.spec.ts` "catches up after a daemon kill…" | pass |
| Remove deleted records from results | `history.spec.ts` "a deleted conversation disappears from search results" | fixme: no operation deletes a message or a conversation, so the deletion path cannot be driven |

### F049 Usage analytics

| Criterion | Spec | Result |
|---|---|---|
| Codex per-turn tokens with provenance and source event; cost always unavailable; a turn with no report is unreported, never zero | `usage.spec.ts` "records Codex turns…" | pass |
| Claude cost as `agent_estimate` from query-cumulative differences; an unpriced model gives no cost, with a note | `usage.spec.ts` "records Claude costs…" | pass |
| Aggregate by provider, workspace, account and day, with reported and unreported counts and mixed scopes; CLI parity | `usage.spec.ts` "aggregates across providers…" | pass |
| A daemon kill neither loses nor double-counts usage, including a turn in flight at the kill | `usage.spec.ts` "a daemon crash and restart…" | pass |
| Malformed queries are refused | `usage.spec.ts` "refuses malformed usage queries…" | pass |

### F030 Quota and limit visibility

| Criterion | Spec | Result |
|---|---|---|
| Reported quota and reset data with source and freshness (`observed_at`, `reset_since_observed`) for Codex and Claude | `usage.spec.ts` Codex and Claude tests | pass (backend) |
| Show unavailable when unknown: the sparse Codex `secondary: null` stores no window | `usage.spec.ts` Codex test | pass |
| Do not silently switch account or model on exhaustion | `usage.spec.ts` "an exhausted limit is shown and does not switch account or model" | fixme: the mocks cannot report an exhausted limit that blocks a turn, and no ADE behaviour reacts to a `rejected` status yet |
| Display | not covered: UI |

## Product fixes

None. No spec found a product bug in this area.

## Fixture changes

- New generic fixtures: `e2e/protocol/fixtures/tree.ts` (`treeSnapshot`, proof that files were left alone) and `e2e/protocol/fixtures/native-sessions.ts` (Claude Code transcripts and Codex rollouts in a scratch HOME).
- `scripts/fixtures/codex_mock.py`: the prompt `usage` emits `thread/tokenUsage/updated` with a growing thread total and a sparse `account/rateLimits/updated`.
- `providers/claude/fake-sdk.mjs`: the prompts `usage` and `usage-unpriced` emit `rate_limit_event` and a `result` with `usage`, cumulative `modelUsage` and `total_cost_usd`; `usage-unpriced` sets `costBasis: "unknown"`. The legacy `bridge.test.mjs` still passes (9 of 9).
- `e2e/protocol/README.md` does not list the new prompts or fixture files yet. The coordinator may add them.

## Checks

- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/catalogs`: 23 passed, 4 fixme. The concurrency and crash specs also passed with `--repeat-each` 3 and 4.
- `pnpm test:e2e:protocol:only e2e/protocol/boot`: 7 passed with the changed mocks.
- `pnpm check:static`: pass.
- In-process tests added: none.
- `pgrep`: no `ade-daemon` or `ade-runtime` from this worktree was left running.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 70 | 5 | 15 | 0 |

## References

None.

## Open

- F131: adapter wiring (Claude `--mcp-config`, Codex `config.toml`, Oh My Pi `mcp.json`) and a gateway with both-leg negotiation.
- F132: placement into provider paths, adapter invocation and explicit remote installation. Catalog blobs across backup and restore are not covered here.
- F043: a deletion operation (conversation or message) so the "remove deleted records" path can be proven.
- F030: an exhaustion signal the mocks can script, and the behaviour that refuses to switch account or model; the display is UI work.
- F049 by account covers only turns on the provider's own login (a null account). No managed-account turn was run.
