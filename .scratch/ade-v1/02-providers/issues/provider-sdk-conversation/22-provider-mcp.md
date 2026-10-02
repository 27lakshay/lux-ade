# 22 — Configure native provider MCP access through the public contract

Status: ready-for-agent
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Configure supported native provider MCP access through installed worker operations and the existing Rust-owned gateway.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md)

**Spec coverage:** PC02, PC03, PC20, PC28. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [ ] Extend public worker parity for supported MCP setup, inspection and declared lifecycle effects without a bundled-only native shortcut.
- [ ] Preserve gateway ownership and native/direct configuration semantics on both legs. Choose optional TypeScript MCP libraries only where a component actually needs them.
- [ ] Declare tier, schema, limits, authentication/account context and availability; validate stale or incompatible configuration before use.
- [ ] Unsupported setup, failed native propagation and unknown effect outcomes are explicit. Tool traffic and credentials retain bounded sanitized treatment.
- [ ] Demonstrate configuration and a supported native tool call via public operations and desktop controls without introducing a parallel gateway or documentation-server dependency.
- [ ] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Use deterministic native/MCP peers through the real gateway for successful and failed setup/tool calls; verify visible configuration and exact account/protocol evidence.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.
