# 09 — Bind executions to explicit account contexts

Status: ready-for-agent
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Run conversations under explicit managed or ambient account contexts without accidental credential/session sharing or identity changes during refresh.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md)

**Spec coverage:** PC20, PC28, PC34. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Inspect and reuse the existing account-context foundation rather than re-create account registration. Extend the public worker context to carry controlled credential references or required transient launch material.
- [ ] Bind host, profile, workspace, provider installation, account generation and native session provenance through dispatch. Native ambient login remains labelled ambient rather than claimed profile isolation.
- [ ] Two accounts using the same native session text ID cannot share native homes, transcript cache entries or event ownership accidentally.
- [ ] Serialized refresh/readback preserves the pinned identity; delayed refresh cannot undo logout. Supported account switching is explicit and discloses continuity limits.
- [ ] Revalidate externally managed executable location and compatibility at launch/resume. Authentication, account mismatch and installation failures appear as readiness problems without credential leakage.
- [ ] Desktop context and CLI/SDK inspection match; secrets do not enter history, receipts or diagnostic reports.
- [ ] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Extend existing real-process account fixtures with cross-account isolation, delayed refresh/logout and replaced executables; verify context and recovery controls in built desktop.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.
