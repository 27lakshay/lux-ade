# 22 — Configure native provider MCP access through the public contract

Status: complete
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Configure supported native provider MCP access through installed worker operations and the existing Rust-owned gateway.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md)

**Spec coverage:** PC02, PC03, PC20, PC28. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Extend public worker parity for supported MCP setup, inspection and declared lifecycle effects without a bundled-only native shortcut.
- [x] Preserve gateway ownership and native/direct configuration semantics on both legs. Choose optional TypeScript MCP libraries only where a component actually needs them.
- [x] Declare tier, schema, limits, authentication/account context and availability; validate stale or incompatible configuration before use.
- [x] Unsupported setup, failed native propagation and unknown effect outcomes are explicit. Tool traffic and credentials retain bounded sanitized treatment.
- [x] Demonstrate configuration and a supported native tool call via public operations and desktop controls without introducing a parallel gateway or documentation-server dependency.
- [x] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Use deterministic native/MCP peers through the real gateway for successful and failed setup/tool calls; verify visible configuration and exact account/protocol evidence.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.

2026-10-02: Implementation and acceptance (decisions taken under the user's standing instruction to decide unattended).

Document and code disagree: this ticket says MCP access goes "through the existing Rust-owned gateway", but ADE has no MCP gateway. The F131 code and its specs deliver each resolved server directly: Codex receives `mcp_servers.<name>` overrides on `thread/start` and `thread/resume`, Claude the Agent SDK `mcpServers` option through the worker's `configure_mcp` operation, and Oh My Pi a `.mcp.json` in ADE's own `--extension` package. Each provider negotiates protocol version, capabilities and authorization with the server itself, and `mcp.resolve` reports `delivery: direct`. This ticket keeps direct delivery and adds no gateway; the parent specification should be corrected or a gateway scoped as new work.

What existed: the profile MCP catalog (`mcp.server.list/inspect/add/update/remove` with revision guards, `mcp.resolve` per workspace and provider with exclusion reasons), fail-closed handling of stored secrets, placeholders and insecure URLs (environment references only), and propagation to all three providers on launch and resume.

Desktop (provisional): Settings gains "MCP servers": the catalog list with transport, command and revision; adding a stdio server; removing one at its revision; and "What <provider> receives" showing delivery, native format, the servers included and each exclusion with its reason. Main forwards the four catalog operations as profile-scoped requests.

Evidence:
- `pnpm check:static`: passed (`test-results/runs/static-4639b304-601e-4e1a-8f3b-87acc7fc707b`).
- Real processes (existing, passing in the full runs): `catalogs/mcp.spec.ts` 7/7, `ops3/mcp-launch.spec.ts` 3/3, `ops3/omp-mcp.spec.ts` 2/2.
- Built Electron: `e2e/desktop/mcp.spec.ts` (`test-results/runs/desktop-55f175d3-cd32-4e45-bc39-4e60169cc743`): a server added in Settings is listed, previewed for Codex as direct `codex_config_toml`, read by the SDK, delivered to the next Codex `thread/start`, and removed. Screenshot `mcp-settings.png`.

Prerequisite-blocked: a native tool call to a real MCP server. The provider fixtures record the configuration they receive but run no MCP server, and no installed provider with a test MCP server is available here. Editing secrets, HTTP servers and scopes in the desktop form is not offered; the CLI and SDK cover them.
