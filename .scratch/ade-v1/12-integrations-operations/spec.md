# MCP, skills, diagnostics and release reliability

Status: ready-for-agent
Type: specification
Scope: ADE v1
Implementation status: not verified against this specification; prototype capabilities require E2E acceptance.

## Problem Statement

Users need shared integration configuration, bounded resource usage and recoverable upgrades while developing ADE inside itself.

## Solution

Provide profile catalogs and operational controls with explicit compatibility, storage and full-stack verification.

## User Stories

1. As a user, I want support for Central MCP catalog, so that I can configure integrations once per profile. **F131**
2. As a user, I want support for Central skill catalog, so that I can manage reusable instructions once. **F132**
3. As a user, I want support for Resource visibility, so that I can understand host load and active work. **F136**
4. As a user, I want support for Diagnostics, so that I can understand and report failures. **F137**
5. As a user, I want support for Retention and cleanup, so that I can control storage and resource growth. **F138**
6. As a developer, I want support for HMR and plugin development, so that I can iterate quickly while using ADE. **F139**
7. As a developer, I want support for Conformance and fault coverage, so that I can trust recovery and compatibility. **F140**
8. **12-S08.** As a user, I want to recover my managed data after a failed update, so that I can keep using ADE without data loss.
9. **12-S09.** As a developer, I want to get complete E2E evidence without using personal accounts, so that I can iterate reproducibly.

## Implementation Decisions

1. Central MCP configuration is not a universal shared protocol session. Negotiate protocol versions, capabilities and authorization on both gateway legs; expose explicit direct-provider setup if fidelity cannot be preserved.
2. Skill bundles include referenced resources, provenance and source/version pins. Adapter-specific paths/frontmatter/invocation remain explicit; external files are not modified without adoption.
3. Use short single-writer SQLite transactions for core state plus durable change feed. Never await plugins/network/filesystem effects inside a core transaction.
4. Finalize managed blobs before committing references and exclude in-flight/referenced artifacts from GC. Back up a consistent database plus required blobs/manifests; disclose unregistered private files/native state exclusions.
5. Host/profile admission budgets coexist. Observability records bounded redacted host/profile/operation/attempt/activation metadata and avoids double-counting shared memory.
6. Version client/daemon/runtime/worker/registry/storage interfaces. Keep compatible old owners and artifacts while work is live. Reject unsupported migrations and preserve recoverable backups.
7. All new behavioral coverage is E2E through real application processes. External deterministic provider fixtures complement, not replace, real-provider runs. Static checks are separate and Fallow does not authorize automatic deletion.
8. Use provisional load of ten active agents, twenty terminals and five representative browser tabs with large history. Measure whole-process-tree resources and idle plateau. Provisional p95 local echo target is 50 ms and local command admission 250 ms excluding provider delay; these are unproven targets.
9. Frontend HMR must not restart backend execution. Plugin hot reload cannot silently terminate leased provider workers. Renderer recovery remains available from Electron main.

## Testing Decisions

All new tests are end-to-end. Exercise the running Electron application, CLI or public protocol with actual ADE processes, as approved by the user. Assert observable behavior, not internal classes, reducers, database layouts or implementation call counts. Use isolated host/profile/repository fixtures. External protocol fixtures are permitted; report real-provider evidence separately.

Modules exercised through these public interfaces: MCP/skill adapters, storage, retention, diagnostics, packaging, dev launcher and all full-stack release flows.

Prior art: Prototype future-schema refusal and transactional migrations; OpenCode MCP/auth coordination; reference bounded stream and client recovery tests. Reuse the scenarios at the E2E level; do not copy isolated tests into a new unit suite.

### Feature acceptance

| Requirement | Required end-to-end evidence |
|---|---|
| F131 | Register a server and expose it through compatible adapters, with both-leg capability/auth handling; show explicit direct-provider fallback when a gateway cannot preserve semantics. |
| F132 | Install/discover complete bundles with provenance, invoke through adapter rules and keep externally owned files intact; remote installation is explicit. |
| F136 | Display measured process/host resource status with provenance and stale/unknown markers; avoid double-counting shared memory in totals. |
| F137 | Export bounded inspectable redacted diagnostics with operation/host/profile/attempt identities and reasons for degraded or unknown states. |
| F138 | Apply configured retention without deleting referenced/in-flight artifacts, active resources or unresolved claims; expose reclaim estimates and failures. |
| F139 | Reload React UI without stopping work, restart Electron main safely, preview component states and inspect plugin errors; do not kill active provider workers on reload. |
| F140 | Run E2E fault, load, migration and real-provider matrices through public interfaces; no new unit/component/isolated integration tests. |
| 12-S08 | Fail an upgrade/migration at controlled points; preserve a compatible owner or restore path and managed blob references. |
| 12-S09 | Run isolated full-stack fixtures and capture bounded failure artifacts; run live-provider coverage separately with explicit credentials. |

A feature is complete only when its selected behavior and failure path are demonstrated, the relevant other-domain dependencies work, and its evidence/status is recorded in the register. A package installation, UI mock or fixture provider alone does not establish product completion.

## Out of Scope

ADE MCP server, skill sharing and artifact publishing are excluded. Unit/component/isolated integration tests are prohibited; existing legacy tests are not deleted by this spec.

| Feature | Disposition |
|---|---|
| F133 — ADE MCP server | Not now |
| F134 — Skill sharing | Not now |
| F135 — Artifact publishing | Not now |

## Further Notes

This specification records required behavior, not implemented completeness. The shared v1 register contains all 140 original catalogue dispositions, scope corrections, delivery dependencies and remaining decisions. No source file layout or package candidate overrides the agreed product behavior.
