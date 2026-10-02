# Provider SDK and conversation UI implementation tickets

Status: ready-for-agent
Type: implementation ticket index

The user approved this 32-ticket breakdown and its blocking edges on 2026-09-30. Each ticket is a separate verifiable slice of the [provider SDK and conversation UI specification](../../provider-sdk-conversation-ui.md). Publication prepares implementation work; it does not authorize starting that work, committing or spawning agents. Tickets 01–31 are complete; each ticket's Comments record its evidence. Ticket 32 reconciled all acceptance rows and stories and published the authoring contract, but did not freeze it: installed/live evidence (PC30) still needs managed accounts signed in by a person, so it is `ready-for-human`.

## Tickets and blocking edges

Ticket numbers below are scoped to this directory. The earlier [account-context foundation ticket](../01-account-context.md) remains unchanged; ticket 09 reuses its existing work rather than replacing it.

| Ticket | Blocked by |
|---|---|
| [01 — Open a readable production conversation](01-production-conversation.md) | None — can start immediately |
| [02 — Install and inspect an Effect provider worker](02-effect-worker-installation.md) | None — can start immediately |
| [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md) | [01](01-production-conversation.md), [02](02-effect-worker-installation.md) |
| [04 — Answer native approvals and structured questions](04-native-requests.md) | [03](03-codex-public-send.md) |
| [05 — Stop an identified execution truthfully](05-identified-stop.md) | [03](03-codex-public-send.md) |
| [06 — Run Claude Code through the public provider SDK](06-claude-native-adapter.md) | [03](03-codex-public-send.md) |
| [07 — Run Oh My Pi through the public provider SDK](07-omp-native-adapter.md) | [03](03-codex-public-send.md) |
| [08 — Apply provider settings with accurate effective state](08-effective-provider-settings.md) | [03](03-codex-public-send.md) |
| [09 — Bind executions to explicit account contexts](09-explicit-account-context.md) | [03](03-codex-public-send.md) |
| [10 — Queue, remove and steer input without changing its meaning](10-queue-remove-steer.md) | [03](03-codex-public-send.md), [05](05-identified-stop.md) |
| [11 — Show yielded, background and autonomous activity](11-background-activity.md) | [03](03-codex-public-send.md) |
| [12 — Load bounded history with correct tool attribution](12-bounded-history.md) | [01](01-production-conversation.md), [02](02-effect-worker-installation.md) |
| [13 — Reconnect and merge history with live output](13-reconnect-live-merge.md) | [03](03-codex-public-send.md), [12](12-bounded-history.md) |
| [14 — Recover uncertain sends and failed executions](14-uncertain-execution-recovery.md) | [03](03-codex-public-send.md), [05](05-identified-stop.md) |
| [15 — Preserve composer drafts, recall and stash](15-recoverable-drafts.md) | [03](03-codex-public-send.md) |
| [16 — Preview and validate attachments and captured context](16-prepared-context-attachments.md) | [15](15-recoverable-drafts.md) |
| [17 — Run provider commands and skills with explicit semantics](17-provider-commands-skills.md) | [03](03-codex-public-send.md) |
| [18 — Compact context with native evidence](18-native-compaction.md) | [03](03-codex-public-send.md), [12](12-bounded-history.md) |
| [19 — Preview and execute rewind with lineage](19-rewind-lineage.md) | [03](03-codex-public-send.md), [12](12-bounded-history.md) |
| [20 — Connect generic ACP agents with negotiated semantics](20-generic-acp.md) | [03](03-codex-public-send.md), [12](12-bounded-history.md) |
| [21 — Install a real fourth provider without core changes](21-independent-real-provider.md) | [03](03-codex-public-send.md), [12](12-bounded-history.md) |
| [22 — Configure native provider MCP access through the public contract](22-provider-mcp.md) | [03](03-codex-public-send.md) |
| [23 — Preserve active work across plugin lifecycle changes](23-plugin-leased-executions.md) | [03](03-codex-public-send.md) |
| [24 — Render namespaced timeline content with a core fallback](24-timeline-contributions.md) | [23](23-plugin-leased-executions.md) |
| [25 — Extend the composer without losing recoverable input](25-composer-contributions.md) | [15](15-recoverable-drafts.md), [23](23-plugin-leased-executions.md) |
| [26 — Recover from thrown and frozen UI extensions](26-extension-safe-mode.md) | [04](04-native-requests.md), [05](05-identified-stop.md), [24](24-timeline-contributions.md), [25](25-composer-contributions.md) |
| [27 — Inspect child activity, usage and quota evidence](27-child-usage-evidence.md) | [11](11-background-activity.md), [12](12-bounded-history.md) |
| [28 — Retain access to history after provider removal](28-retained-history-access.md) | [12](12-bounded-history.md) |
| [29 — Preserve reading position and accessible interaction](29-accessible-reading.md) | [03](03-codex-public-send.md), [12](12-bounded-history.md) |
| [30 — Keep conversations and control responsive under load](30-responsive-under-load.md) | [05](05-identified-stop.md), [13](13-reconnect-live-merge.md), [24](24-timeline-contributions.md) |
| [31 — Verify native fidelity and publish provider conformance evidence](31-native-conformance-evidence.md) | [04](04-native-requests.md), [05](05-identified-stop.md), [06](06-claude-native-adapter.md), [07](07-omp-native-adapter.md), [08](08-effective-provider-settings.md), [09](09-explicit-account-context.md), [10](10-queue-remove-steer.md), [11](11-background-activity.md), [13](13-reconnect-live-merge.md), [14](14-uncertain-execution-recovery.md), [16](16-prepared-context-attachments.md), [17](17-provider-commands-skills.md), [18](18-native-compaction.md), [19](19-rewind-lineage.md), [20](20-generic-acp.md), [21](21-independent-real-provider.md), [22](22-provider-mcp.md), [23](23-plugin-leased-executions.md), [27](27-child-usage-evidence.md), [28](28-retained-history-access.md) |
| [32 — Freeze the authoring contract with complete acceptance coverage](32-contract-freeze.md) | [26](26-extension-safe-mode.md), [29](29-accessible-reading.md), [30](30-responsive-under-load.md), [31](31-native-conformance-evidence.md) |

## Parallel work and frontier

Start with 01 and 02. A ticket becomes available only when its declared blockers are accepted, not merely started or marked ready-for-agent. Read the ticket Comments and acceptance evidence when assessing completion.

- 01 delivers readable existing conversations while 02 proves independently installed worker discovery. Their different seams allow both to start immediately.
- After 01 and 02, 03 and 12 can proceed together: one proves native submission; the other proves bounded readable history.
- After 03, 04–09, 11, 15, 17 and 22–23 branch independently. Tickets 10 and 14 follow accepted Stop, and 13, 18–21 also need accepted history behavior.
- UI contributions follow lifecycle/draft prerequisites; their failures do not delay unrelated native settings, accounts, history or protocol work.
- 31 consolidates native evidence for its explicitly approved blockers. 32 reconciles that evidence with extension recovery, accessible reading and measured performance before freeze.

The blocker lists preserve the approved schedule, including the gate checkpoints in 31. Some checkpoint prerequisites are also transitive; do not silently remove approved edges or treat them as additional implementation work. Independent inspection/preparation can happen before a blocker finishes, but production acceptance cannot skip the declared prerequisites.

Assign one owner to each shared boundary: Rust contracts/admission, runtime sequencing/supervision, provider SDK lifetime/transport, client projection and UI contribution lifecycle. Other slices consume those boundaries and propose changes through their owner. Parallel eligibility does not authorize spawning a swarm or creating new worktrees; both follow the user’s instructions and repository rules.

## Delivery rules

- Implement observable behavior through every applicable persistence, contract, runtime, public CLI/SDK and production desktop boundary. Headless authoring capabilities need no invented UI, but their user-facing state must be inspectable where specified.
- Keep Rust as wire authority, the daemon as durable application authority and the runtime as process owner. React owns local interaction only. Extend generated worker contracts rather than handwritten competing TypeScript schemas.
- Use the parent specification and D02/D18/D19/D21. D19 forbids prelaunch compatibility shims; no expand/contract aliases or dual worker protocols are introduced merely to preserve development artifacts. Live compatible artifact leases still require explicit lifecycle protection.
- Inspect current code, domain guidance, existing account work and accepted backend evidence before changing them. Existing acceptance proves only its recorded scope; it does not automatically satisfy new SDK/desktop requirements.
- Resolve and pin a compatible Effect v4 RC set when implementing. Read shipped agent guidance and version-matched declarations. Verify recommended diagnostics with the pinned compiler. Optional model AI, MCP and observability packages belong only in components that actually need them.
- Use small preparatory refactors within the owning slice when necessary; avoid disconnected foundation tickets that deliver no observable path. Do not port a second Rust execution coordinator/store into TypeScript.
- Build approved shell/conversation surfaces to Pen. Use stock provisional shadcn compositions for unapproved capability/recovery surfaces. Reuse TipTap, Streamdown, Shiki, TanStack Virtual, Pierre Diffs and existing commands/projections.
- Every ticket introduces its own deterministic failure tests and conformance cases. Use real daemon/runtime processes and shared protocol peers for backend acceptance, built Electron over those backends for interactions, and focused in-process/browser tests for pure/local mechanisms. No second simulated ADE backend.
- Keep correctness retries at zero. Installed-provider, authenticated live, packaged-candidate and performance evidence remain separate and record exact artifacts, native versions and prerequisites. Missing native prerequisites are not passing evidence.
- Run `pnpm check:static` after changes and the relevant owning acceptance. Complete integration evidence uses the ordinary full suites. Test discovery owns new tests; no blanket exclusions or weakened assertions.
- Measure each slice as it lands. Ticket 30 establishes and proves the reference-workload resource policy; it does not defer output bounds, cancellation responsiveness or teardown correctness from earlier slices.
- Append implementation findings under Comments. Preserve original feature IDs/dispositions and parent scope. Do not modify or close a parent issue; publication leaves the parent spec unchanged. Commit only when asked.

## Acceptance coverage

All PC01–PC38 rows remain unverified. The table identifies contributing tickets, not implementation completion. Each ticket’s criteria define its portion; a shared row passes only after all required contributions and native/desktop evidence satisfy the parent specification. Ticket 32 reconciles every row and all 78 stories, rather than supplying missing behavior by declaration.

| Spec acceptance | Contributing tickets |
|---|---|
| PC01 | [02](02-effect-worker-installation.md), [21](21-independent-real-provider.md), [31](31-native-conformance-evidence.md) |
| PC02 | [03](03-codex-public-send.md), [06](06-claude-native-adapter.md), [07](07-omp-native-adapter.md), [17](17-provider-commands-skills.md), [18](18-native-compaction.md), [19](19-rewind-lineage.md), [20](20-generic-acp.md), [21](21-independent-real-provider.md), [22](22-provider-mcp.md), [23](23-plugin-leased-executions.md), [24](24-timeline-contributions.md), [25](25-composer-contributions.md), [27](27-child-usage-evidence.md), [31](31-native-conformance-evidence.md) |
| PC03 | [02](02-effect-worker-installation.md), [22](22-provider-mcp.md), [24](24-timeline-contributions.md), [31](31-native-conformance-evidence.md) |
| PC04 | [03](03-codex-public-send.md), [10](10-queue-remove-steer.md), [14](14-uncertain-execution-recovery.md), [31](31-native-conformance-evidence.md) |
| PC05 | [03](03-codex-public-send.md), [06](06-claude-native-adapter.md), [07](07-omp-native-adapter.md), [13](13-reconnect-live-merge.md), [31](31-native-conformance-evidence.md) |
| PC06 | [03](03-codex-public-send.md), [06](06-claude-native-adapter.md), [07](07-omp-native-adapter.md), [10](10-queue-remove-steer.md), [15](15-recoverable-drafts.md), [16](16-prepared-context-attachments.md), [17](17-provider-commands-skills.md), [31](31-native-conformance-evidence.md) |
| PC07 | [10](10-queue-remove-steer.md), [31](31-native-conformance-evidence.md) |
| PC08 | [05](05-identified-stop.md), [06](06-claude-native-adapter.md), [07](07-omp-native-adapter.md), [10](10-queue-remove-steer.md), [20](20-generic-acp.md), [31](31-native-conformance-evidence.md) |
| PC09 | [05](05-identified-stop.md), [06](06-claude-native-adapter.md), [07](07-omp-native-adapter.md), [14](14-uncertain-execution-recovery.md), [20](20-generic-acp.md), [31](31-native-conformance-evidence.md) |
| PC10 | [07](07-omp-native-adapter.md), [11](11-background-activity.md), [27](27-child-usage-evidence.md), [31](31-native-conformance-evidence.md) |
| PC11 | [07](07-omp-native-adapter.md), [11](11-background-activity.md), [27](27-child-usage-evidence.md), [31](31-native-conformance-evidence.md) |
| PC12 | [04](04-native-requests.md), [06](06-claude-native-adapter.md), [07](07-omp-native-adapter.md), [20](20-generic-acp.md), [26](26-extension-safe-mode.md), [31](31-native-conformance-evidence.md) |
| PC13 | [04](04-native-requests.md), [26](26-extension-safe-mode.md), [31](31-native-conformance-evidence.md) |
| PC14 | [13](13-reconnect-live-merge.md), [31](31-native-conformance-evidence.md) |
| PC15 | [14](14-uncertain-execution-recovery.md), [21](21-independent-real-provider.md), [31](31-native-conformance-evidence.md) |
| PC16 | [05](05-identified-stop.md), [14](14-uncertain-execution-recovery.md), [30](30-responsive-under-load.md) |
| PC17 | [12](12-bounded-history.md), [13](13-reconnect-live-merge.md), [21](21-independent-real-provider.md), [28](28-retained-history-access.md), [31](31-native-conformance-evidence.md) |
| PC18 | [13](13-reconnect-live-merge.md), [20](20-generic-acp.md), [31](31-native-conformance-evidence.md) |
| PC19 | [18](18-native-compaction.md), [19](19-rewind-lineage.md), [31](31-native-conformance-evidence.md) |
| PC20 | [02](02-effect-worker-installation.md), [06](06-claude-native-adapter.md), [08](08-effective-provider-settings.md), [09](09-explicit-account-context.md), [21](21-independent-real-provider.md), [22](22-provider-mcp.md), [31](31-native-conformance-evidence.md) |
| PC21 | [23](23-plugin-leased-executions.md), [31](31-native-conformance-evidence.md) |
| PC22 | [24](24-timeline-contributions.md), [26](26-extension-safe-mode.md), [28](28-retained-history-access.md) |
| PC23 | [01](01-production-conversation.md), [03](03-codex-public-send.md), [04](04-native-requests.md), [05](05-identified-stop.md) |
| PC24 | [15](15-recoverable-drafts.md), [25](25-composer-contributions.md), [26](26-extension-safe-mode.md) |
| PC25 | [16](16-prepared-context-attachments.md), [25](25-composer-contributions.md) |
| PC26 | [04](04-native-requests.md), [29](29-accessible-reading.md) |
| PC27 | [29](29-accessible-reading.md), [30](30-responsive-under-load.md) |
| PC28 | [01](01-production-conversation.md), [03](03-codex-public-send.md), [05](05-identified-stop.md), [09](09-explicit-account-context.md), [11](11-background-activity.md), [13](13-reconnect-live-merge.md), [14](14-uncertain-execution-recovery.md), [15](15-recoverable-drafts.md), [17](17-provider-commands-skills.md), [22](22-provider-mcp.md), [23](23-plugin-leased-executions.md), [26](26-extension-safe-mode.md), [31](31-native-conformance-evidence.md) |
| PC29 | [01](01-production-conversation.md), [12](12-bounded-history.md), [24](24-timeline-contributions.md), [27](27-child-usage-evidence.md), [28](28-retained-history-access.md), [31](31-native-conformance-evidence.md) |
| PC30 | [06](06-claude-native-adapter.md), [07](07-omp-native-adapter.md), [20](20-generic-acp.md), [21](21-independent-real-provider.md), [31](31-native-conformance-evidence.md) |
| PC31 | [03](03-codex-public-send.md), [06](06-claude-native-adapter.md), [07](07-omp-native-adapter.md), [13](13-reconnect-live-merge.md), [20](20-generic-acp.md), [30](30-responsive-under-load.md), [31](31-native-conformance-evidence.md) |
| PC32 | [08](08-effective-provider-settings.md), [31](31-native-conformance-evidence.md) |
| PC33 | [03](03-codex-public-send.md), [20](20-generic-acp.md), [24](24-timeline-contributions.md), [30](30-responsive-under-load.md) |
| PC34 | [09](09-explicit-account-context.md), [12](12-bounded-history.md), [13](13-reconnect-live-merge.md), [19](19-rewind-lineage.md), [30](30-responsive-under-load.md), [31](31-native-conformance-evidence.md) |
| PC35 | [12](12-bounded-history.md), [18](18-native-compaction.md), [27](27-child-usage-evidence.md), [31](31-native-conformance-evidence.md) |
| PC36 | [01](01-production-conversation.md), [02](02-effect-worker-installation.md), [05](05-identified-stop.md), [13](13-reconnect-live-merge.md), [23](23-plugin-leased-executions.md), [29](29-accessible-reading.md), [30](30-responsive-under-load.md), [31](31-native-conformance-evidence.md) |
| PC37 | [05](05-identified-stop.md), [10](10-queue-remove-steer.md), [31](31-native-conformance-evidence.md) |
| PC38 | [02](02-effect-worker-installation.md), [03](03-codex-public-send.md), [21](21-independent-real-provider.md), [25](25-composer-contributions.md), [31](31-native-conformance-evidence.md) |

## Delivery checkpoints

| Parent checkpoint | Tickets supplying its behavior/evidence |
|---|---|
| A — Foundation and first slice | 01–05 and the Codex portions of 12–14; first bounded SDK lifecycle and production interaction evidence |
| B — Semantic stress | 06–11, 17 and provider-specific conformance accumulated with each slice |
| C — History and recovery | 12–16, 18–20, 27–29; identity, replay and draft correctness |
| D — Independent extension | 21–26; normal installation, declared native limits, leases and readable fallback |
| E — Contract freeze | 30–32 plus complete preceding slice evidence; measured policy, native matrices and author documentation |

These groupings describe delivery, not additional blocking edges. A native adapter ticket establishes its native path and maps behavior already available through the shared contract. Later capability tickets extend those adapters when they land; ticket 31 verifies the resulting complete matrices. The additional bundled-provider roster keeps its existing requirements and needs individual evidence where claimed.

## Comments

2026-10-02: Ticket 09 is complete: sessions record their account binding, and Codex readiness failures keep their reason.
2026-10-02: Ticket 08 is complete: requested and provider-reported settings, revisioned updates and Codex reasoning levels.
2026-10-02: Ticket 07 is complete: OMP runs through its public worker under Bun, with agent_start-anchored completion attribution.
2026-10-02: Ticket 31 (native conformance evidence) is complete: live evidence for Codex, Claude and Oh My Pi, two Oh My Pi defects fixed, and plugin providers now get the controls their workers declare.
2026-10-02: Tickets 20 (generic ACP on the official SDK), 21 (OpenCode as an independent plugin; bundled adapter deleted) and 24–26 (plugin timeline and composer contributions, safe mode) are complete; built in parallel worktrees and integrated here.
2026-10-02: Ticket 30 (responsive under load) is complete with numeric budgets in a new conversation performance workload.
2026-10-02: Ticket 29 (accessible reading) is complete; the pane tab's nested close button was an accessibility defect and is now pointer-only with Delete as its keyboard path.
2026-10-02: Ticket 23 (plugin leased executions) is complete; a plugin lifecycle lock held across plugin calls caused seven plugin failures that also failed on HEAD.
2026-10-02: Ticket 28 (retained history access) is complete; exports disclose provider continuity and attachment state.
2026-10-02: Ticket 22 (provider MCP) is complete with direct delivery; the ticket's gateway wording disagrees with the code and is recorded there.
2026-10-02: Ticket 17 (provider commands and skills) is complete; the desktop lists and runs them.
2026-10-02: Ticket 18 (native compaction) is complete; a compaction no longer overwrites the previous prompt's terminal.
2026-10-02: Ticket 14 (uncertain execution recovery) is complete; resuming after an unknown outcome needs an explicit choice.
2026-10-02: Ticket 27 (child, usage and quota evidence) is complete; Claude usage is keyed by submission.
2026-10-02: Ticket 19 (rewind and native lineage) is complete; Claude rewinds by native message.
2026-10-02: Ticket 32 reconciled every acceptance row and story, built the missing pieces (see its comment) and published the authoring contract. It is `ready-for-human` and not frozen. Installed/live evidence (PC30) still lacks several behaviours and any managed-account live run. Story 18 waits for ADE's file and diff surfaces. Story 70 cannot be made true retroactively.
2026-10-02: Tickets 13 (reconnect and live merge) and 16 (prepared context and attachments) are complete.
2026-10-02: Ticket 15 (recoverable drafts) is complete; the two desktop draft failures recorded on ticket 05 are fixed.
2026-10-02: Ticket 11 (yielded, background and autonomous activity) is complete; Claude reports task lifecycle evidence, Codex and OMP report none.
2026-10-02: Ticket 06 (Claude through the public SDK) is complete. Claude rewind and per-turn usage need ADE to key work by submission when a provider reports no turn ID; tickets 19 and 27 own that change.
2026-10-02: Tickets 05 (identified Stop) and 10 (queue, remove and steer) are complete; their tickets record decisions, evidence and the full-suite failures that belong to other tickets (Claude fake-SDK coverage to 06, draft-restart cases to 15, a pre-existing plugin/descendant set).
2026-10-02: Corrected stale status. Tickets 01, 02, 03 and 12 had recorded acceptance but still said `ready-for-agent`; they and the opening paragraph now say they are accepted. PC rows remain unverified as stated above.
2026-10-02: Ticket 04 is complete with real-process protocol and built Electron acceptance. Its ticket records the static gate report and coverage limits. Other tickets retain their own acceptance status.
2026-09-30: Published the user-approved breakdown on agent-work-2. No implementation, completion claims or commit were added. The parent specification and existing account-context ticket remain unchanged.
