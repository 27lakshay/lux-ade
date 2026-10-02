# 11 — Show yielded, background and autonomous activity

Status: complete
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** See whether a prompt yielded, background work remains or autonomous output arrived, with attention and unread derived from authoritative evidence.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md)

**Spec coverage:** PC10, PC11, PC28. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Represent delivery, execution, session activity, synchronization and user action independently, including their evidence source and unknown values.
- [x] A yielded prompt can remain active through native background evidence; silence or transport connection state cannot prove settlement.
- [x] Retain autonomous output without inventing a new user prompt and correlate it to its native session/attempt or disclose weaker attribution.
- [x] Pending requests, errors and ordinary running indication produce consistent attention; unread uses separate seen marks. Existing selected snooze changes attention without scheduling execution.
- [x] Fence stale settlement and interruption output from later activity, and keep CLI/SDK observations and desktop status in agreement.
- [x] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Feed yielded/background/settled and autonomous transitions through real processes, including late stale observations; verify visible attention and unread independently.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.

2026-10-02: Implementation and acceptance (decisions taken under the user's standing instruction to decide unattended).

Decisions:
- Session activity is its own record beside delivery (message `delivery`), execution (`status`, `stop`), synchronization (feed revisions) and user action (requests, `unread`). `conversation.background` holds `active` (true, false or null for unknown), `running`, the native `source`, the source attempt and when it was observed. `conversation.autonomous_output_at_ms` records output that no submission owns.
- Providers report background work with a new `background` event, fenced to the current native session and to the owning run. A new session clears the record. When the provider process exits, the record becomes `active: null` with source `provider_exited`: an exit or silence never reads as settled.
- Attention: a yielded prompt (`idle`/`ready`) whose session reports background work as active stays `running`. Errors still win; open requests still need the person. Unread and snooze are unchanged and stay separate.
- Claude reports every native task in its lifecycle (`task_started` / `task_notification`, any `task_type`, including Bash, MCP and agents), not only child agents. Codex and OMP report no background evidence, so their record stays null and nothing is claimed.
- Output with no submission while no turn is in flight is stored as session-attributed assistant output and timestamps `autonomous_output_at_ms`. No user prompt is invented. Attribution is to the native session and attempt only; no turn is claimed.
- Desktop shows one provisional "Session activity" line beside the session binding: running count, unknown (with the provider-exited reason), none running, and when the session spoke without a prompt.

Evidence:
- `pnpm check:static`: passed (`test-results/runs/static-f2cde041-9767-47ba-b591-10eb8a4eb706`). New unit tests: `workspaces::tests::attention_follows_status_and_open_requests` (background keeps a yielded prompt running, errors win), `providers/claude/subagents.test.mjs` (every task type counted, only changes reported).
- Real processes: `e2e/protocol/conversations/background.spec.ts` (yielded prompt with a running native task stays `running` in `conversation.get` and the catalog; release produces session-attributed output with one user message and settles from the native notification; CLI `conversation inspect` agrees; terminating the provider leaves the work unknown). Conversation, provider and orchestration protocol suites rerun: only `conversations2/lost-turn.spec.ts` fails, as it does on HEAD.
- Built Electron: `e2e/desktop/background.spec.ts` in `test-results/runs/desktop-5022a3c8-1db0-4321-bc3e-fad5ff39dcd3`, screenshots `background-running.png` and `background-settled.png`.

Not run: installed Claude with real background Bash tasks (fake SDK only). OMP background evidence is not mapped; I did not check whether its RPC stream carries a task lifecycle.
