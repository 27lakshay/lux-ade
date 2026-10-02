# 04 — Answer native approvals and structured questions

Status: complete
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Answer native permission requests and structured questions with their original choices, validation, scope and duration, while seeing unresolved or withdrawn delivery honestly.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md)

**Spec coverage:** PC12, PC13, PC23, PC26. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Core request forms preserve native choice IDs, labels, once/persistent grant scope, source attempt and revision. Structured answers satisfy the declared schema before admission.
- [x] Answers use durable effect admission and native responder identity. Two conflicting answers cannot authorize the same outstanding request.
- [x] Lost acknowledgement leaves response delivery pending or unknown until evidence resolves it; rendering again does not send another permission effect.
- [x] Withdrawal, expiry, cancellation and stale revisions remove or refuse actionable controls. Unknown request schemas have a readable summary and safe unsupported handling, never guessed approval.
- [x] CLI/SDK and desktop expose the same outstanding requests and outcomes. Keyboard focus and labelled validation errors work while output streams.
- [x] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Delay answer replies, race conflicting clients and withdraw requests in real-process peers; verify the same forms and transitions in built Electron.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Acceptance evidence

- `pnpm test:e2e:protocol:only -- e2e/protocol/conversations/requests.spec.ts e2e/protocol/adapters/acp.spec.ts e2e/protocol/reliability-a/overload.spec.ts` — 22/22 real-process protocol cases passed; report `test-results/runs/protocol-25ad5d4c-f414-4296-86a7-08f2b74475a5`. Covers native choices/questions, provenance fences, conflicting answers, lost/uncertain delivery, withdrawals and unsupported schemas.
- `pnpm test:e2e:desktop:only e2e/desktop/native-requests.spec.ts` — 3/3 built Electron cases passed; report `test-results/runs/desktop-c3a9a609-c980-4d6b-8a3a-de22025891f2`. Covers question validation/offline behavior, native choice selection/once-only dispatch, unsupported requests and visible outcomes.
- `pnpm check:static` — passed; report `test-results/runs/static-dd3c5016-0234-4e1d-a35f-94dab1164702` (894 Rust tests passed, 1 skipped; 446 renderer tests passed; typecheck, builds, discovery and all remaining static stages passed).
- `pnpm test:discovery` — passed after assigning the provider loopback suite to `provider-installed`.
- Not run: authenticated installed-provider/live-account acceptance. These checks require provider credentials and do not replace mock-provider real-process and built-desktop coverage.

2026-10-02: Implemented and verified native request answering and delivery lifecycle. During acceptance, fixed ACP completion cleanup: finished events now use the retained native turn identity when provider-specific turn params are unavailable.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remained unverified at publication.
