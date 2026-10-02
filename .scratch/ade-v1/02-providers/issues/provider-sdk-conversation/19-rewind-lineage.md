# 19 — Preview and execute rewind with lineage

Status: complete
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Review supported rewind scope, execute it explicitly and retain any new native session lineage without confusing history with file restoration.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md), [12 — Load bounded history with correct tool attribution](12-bounded-history.md)

**Spec coverage:** PC02, PC19, PC34. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Preview the selected boundary and native-supported conversation/file effects, including unavailable restoration limits.
- [x] Execute through effect admission and reconcile uncertain outcome without a duplicate rewind.
- [x] If the provider forks or replaces its native session, record old/new identity and lineage explicitly rather than silently changing the conversation handle.
- [x] Fence old events, stale pages and outstanding requests from the new lineage. Retained history remains readable with accurate provenance.
- [x] CLI/SDK and desktop expose the same scope, preview, native result and recovery actions.
- [x] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Use native peers that rewind in place and fork sessions; race old pages/events and lose acknowledgement, then inspect lineage in built desktop.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.

2026-10-02: Implementation and acceptance (decisions taken under the user's standing instruction to decide unattended).

Decisions (option B, recorded on ticket 06):
- A provider that reports no turn IDs (Claude) is rewound at the prompt's own native message. The daemon's boundary is the user message's turn ID when present, else its `native_message` locator; removed turns count each prompt as a turn. The locator travels daemon → runtime → worker (`Provider::rewind` gained the locator), addressed to the conversation's current native session.
- After a fork, Claude copies messages under new UUIDs while ADE keeps the first IDs. The worker now finds the boundary through its durable alias map, and checks the single-turn range with the copied UUID.
- The Claude worker descriptor now declares `history`, `rewind` and `child_transcript`, which the worker already implemented; `steer` and `compact` stay unsupported.
- Desktop: each user message offers "Rewind to before this prompt". A provisional panel shows the daemon's preview (messages and turns removed and kept, the native mechanism, and that files are not restored), runs `conversation.rewind` with the preview's state token and a fixed operation ID (a retry after an unconfirmed reply reads the recorded result instead of rewinding again), and reports the new and kept native sessions. An unavailable rewind shows the daemon's reason. The CLI already offered preview and rewind.

Evidence:
- `pnpm check:static`: passed (`test-results/runs/static-19683f2b-6c55-4765-b761-3f6afcabb8b3`).
- Real processes: `accounts-rewind/rewind.spec.ts` (all Claude cases: fork before the turn, second rewind across an Agent resume by the stored ID, the single-turn check, refusals while running or before the first turn, lost reply read back after a daemon crash, crash during fork, native refusal at the fork-time check) and `restarts/stale-rewind.spec.ts` pass, 14/14. The stale-rewind page requests used a page limit above the 32-message maximum; corrected to 32. `ops3/operation-coverage.spec.ts` child transcript now passes.
- Built Electron: `e2e/desktop/rewind.spec.ts` (`test-results/runs/desktop-27f6439f-b11d-4f83-ac32-532f2d369fc9`): a Claude rewind previewed, confirmed and reported with the same lineage the CLI reads; a rewind while a Codex turn runs shows the reason and reaches no provider. Screenshots `rewind-preview.png`, `rewind-done.png`.

Not run: installed or live Claude rewind through the daemon (the installed SDK/CLI loopback on ticket 06 remains the installed fork evidence). File restoration stays with ADE checkpoints and is not part of this panel.
