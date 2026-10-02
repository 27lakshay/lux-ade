# 09 — Bind executions to explicit account contexts

Status: complete
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Run conversations under explicit managed or ambient account contexts without accidental credential/session sharing or identity changes during refresh.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md)

**Spec coverage:** PC20, PC28, PC34. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Inspect and reuse the existing account-context foundation rather than re-create account registration. Extend the public worker context to carry controlled credential references or required transient launch material.
- [x] Bind host, profile, workspace, provider installation, account generation and native session provenance through dispatch. Native ambient login remains labelled ambient rather than claimed profile isolation.
- [x] Two accounts using the same native session text ID cannot share native homes, transcript cache entries or event ownership accidentally.
- [x] Serialized refresh/readback preserves the pinned identity; delayed refresh cannot undo logout. Supported account switching is explicit and discloses continuity limits.
- [x] Revalidate externally managed executable location and compatibility at launch/resume. Authentication, account mismatch and installation failures appear as readiness problems without credential leakage.
- [x] Desktop context and CLI/SDK inspection match; secrets do not enter history, receipts or diagnostic reports.
- [x] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Extend existing real-process account fixtures with cross-account isolation, delayed refresh/logout and replaced executables; verify context and recovery controls in built desktop.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.

2026-10-02: Implementation and acceptance (decisions taken under the user's standing instruction to decide unattended).

Reused rather than re-created: the account-context foundation (`../01-account-context.md`) already pins the account ID, provider, native home, generation and identity in the runtime execution context, re-checks them in one lock before the provider session opens (`agents.rs` pre-open), refuses a delayed `account.verify` at a stale generation, and runs managed launches with a cleared environment (`account_probe`, `codex_probe`, `omp_probe::managed_environment`).

Added:
- `ConversationExecution` on the Conversation (`execution`), recorded when a provider session opens: source attempt, managed or ambient context, account ID and the generation verified before open, native session, settings revision and whether it reattached after a restart. The CLI (`conversation inspect`), SDK and desktop read the same record; the desktop context line (provisional `ExecutionBinding`) labels an ambient session "this machine's own login, not isolated by ADE".
- Codex launch readiness is verified in the runtime before the worker starts (as Claude's is), so an incompatible or changed installation reaches the Conversation as its own reason; behind the worker it was reduced to "Provider rejected the operation" (the F027 readiness case failed for this reason).
- Isolation by construction: each managed account has its own native home (registry spec), native history snapshots carry account and execution IDs and are fenced on mismatch (ticket 12), and events are owned per Conversation and run; a native session ID is never a lookup key across accounts.

Evidence (deterministic fixtures; not installed or live evidence):
- `pnpm check:static`: passed (`test-results/runs/static-bba34a82-4eea-4a37-b2eb-b5ec87ad6656`).
- `e2e/protocol/accounts/cli.spec.ts` managed Claude case extended: execution binding (generation, attempt, native session) matches between SDK and CLI; `account.disable` then a delayed verify at the old generation is refused and the account stays disabled; the next send is refused before launch and never reaches the native double; an ambient conversation records `ambient` with no account. `providers/readiness.spec.ts` F027 (missing credentials, verification, external uninstall, incompatible update) now passes. Run `test-results/runs/protocol-31c884d1-14db-4eb5-80e3-17bbea3c4498` (its only failures are Claude rewind, ticket 19).
- Built Electron `e2e/desktop/account-context.spec.ts`: the window shows no session, then the ambient binding the SDK and CLI report (`test-results/runs/desktop-69061e41-b97b-4474-b16a-59c21e1c2e05`, screenshot `session-binding.png`).

Prerequisite-blocked: authenticated managed-account runs against installed Claude, Codex and OMP.

2026-10-02 (ticket 32 reconciliation): real-process isolation evidence for a shared native ID. `e2e/protocol/providers/shared-native-id.spec.ts` gives two verified Codex accounts their own native stores (fake Codex `per-home` mode) holding a thread with the same ID (`fixed-thread-id`). Each conversation's transcript and native history hold only its own account's prompts, including after the other account's thread changes. Full runs: final static `static-d1f7cb5d-435a-4360-9aae-5d44902a5d16`; protocol `protocol-96876d9c-01d2-48b0-a527-f039a873f725` (1109 passed, 6 failed, none in this change); desktop `desktop-a193103e-fab0-45c6-af5d-0d5cd4b6de11` (130 passed, 2 failed, both passing alone).
