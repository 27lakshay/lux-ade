# Trusted plugins and UI extensibility

Status: ready-for-agent
Type: specification
Scope: ADE v1
Implementation status: not verified against this specification; prototype capabilities require E2E acceptance.

## Problem Statement

Users need to add providers and reshape the interface without changes to core application code or losing access when an extension fails.

## Solution

Expose supported command, UI and backend extension interfaces with versioned lifecycle, persistent namespaces and recovery.

## User Stories

1. As a plugin author, I want support for Plugin installation and lifecycle, so that I can install and manage trusted extensions. **F051**
2. As a plugin author, I want support for Plugin panels, navigation and settings, so that I can extend the workbench. **F052**
3. As a plugin author, I want support for Timeline renderers and transforms, so that I can understand specialized agent output. **F053**
4. As a plugin author, I want support for Composer extensions, so that I can add context and input behavior. **F054**
5. As a plugin author, I want support for Plugin commands and keybindings, so that I can invoke extension actions like built-in actions. **F055**
6. As a plugin author, I want support for Theme extension support, so that I can customize built-in and extension appearance. **F056**
7. As a plugin author, I want support for Backend extensions, so that I can add services without modifying the core. **F057**
8. As a plugin author, I want support for Lifecycle hooks, so that I can react to application lifecycle events. **F058**
9. As a plugin author, I want support for Plugin state, credentials and settings, so that I can persist extension data safely. **F059**
10. As a plugin author, I want support for Plugin development and recovery, so that I can iterate on extensions and diagnose failures. **F060**
11. **04-S11.** As a plugin author, I want to keep old provider sessions alive while updating my plugin, so that I can ship improvements without disrupting work.
12. **04-S12.** As a user, I want to recover from a plugin that freezes the UI, so that I can regain control without deleting my data.

## Implementation Decisions

1. Installed code is trusted. Separate UI entries in the renderer, backend service hosts and runtime-supervised provider workers. Isolation improves failure handling but is not hostile-code containment.
2. Publish framework-neutral commands and data contracts with separate React bindings. UI plugins may depend on React; the headless SDK must not.
3. Install explicit local/package/Git artifacts with source/version pins. Artifact version, activation generation and data/resume schema are separate identities.
4. Registration handles belong to one activation. Dispose only those handles; bound cleanup and avoid plugin callbacks while holding activation locks.
5. Keep old workers/artifacts while active sessions lease them. A schema migration must remain compatible, use a separate namespace or drain old users; code rollback is not automatic data rollback.
6. Before-admission transforms have a side-effect-free contract, not an enforceable sandbox guarantee. Effectful hooks run after durable commit and represent unknown outcomes explicitly.
7. Namespaced managed records/blobs participate in documented backup/retention. Private plugin files do not gain those guarantees automatically.
8. A thrown component error can use fallback rendering; a frozen renderer requires Electron main to open a fresh plugin-disabled renderer. Retain a core path to pending approvals and recovery.

## Testing Decisions

Feature acceptance uses end-to-end tests; pure-core and renderer browser tests remain allowed under the current project test policy. Exercise the running Electron application, CLI or public protocol with actual ADE processes, as approved by the user. Assert observable behavior, not internal classes, reducers, database layouts or implementation call counts. Use isolated host/profile/repository fixtures. External protocol fixtures are permitted; report real-provider evidence separately.

Modules exercised through these public interfaces: Plugin registry, backend hosts, provider workers, UI composition and managed extension storage.

Prior art: OpenCode activation-scoped cleanup and namespaced state; Paseo plugin process-lifetime cases. Reuse the scenarios at the E2E level; do not copy isolated tests into a new unit suite.

### Feature acceptance

| Requirement | Required end-to-end evidence |
|---|---|
| F051 | Install pinned local/package/Git artifacts; enable, disable and remove them with visible status; reject incompatible manifests before activation. |
| F052 | Register a panel and settings contribution; restore its layout; show a fallback when the plugin is unavailable. |
| F053 | Render custom content and apply declared transformations without corrupting canonical history; missing renderer retains core-readable summary and unresolved actions. |
| F054 | Install a composer extension, save its draft, disable it, and recover readable input with explicit unsupported-node handling. |
| F055 | Register and invoke an action through supported surfaces; resolve conflicts and remove only that activation's registrations on cleanup. |
| F056 | Apply a plugin theme using stable tokens; restore defaults after removal; localization remains excluded under F017. Apply TH07 and TH27 in the [theming detail](../01-foundation/theming.md#acceptance-matrix). |
| F057 | Run an extension in a headless host; crash it; retain core availability and expose affected operations for recovery. |
| F058 | Deliver committed lifecycle effects with stable effect identities; retry only where safe and expose unknown external outcomes. |
| F059 | Persist namespaced records/settings and credential references; prevent accidental namespace collisions and document private-data backup exclusions. |
| F060 | Reload a UI/backend extension, inspect bounded logs, keep active provider leases valid and recover from a frozen UI plugin through a fresh renderer. |
| 04-S11 | Update a leased provider version; keep old execution alive and route new work to the compatible new activation. |
| 04-S12 | Freeze an installed UI plugin; use Electron recovery to open a clean renderer with work intact. |

A feature is complete only when its selected behavior and failure path are demonstrated, the relevant other-domain dependencies work, and its evidence/status is recorded in the register. A package installation, UI mock or fixture provider alone does not establish product completion.

## Out of Scope

Marketplace distribution, hostile plugin sandboxing, localization and mandatory multi-framework component composition are out of scope.


## Further Notes

The [detailed theming specification](../01-foundation/theming.md) defines shared appearance behavior and TH01–TH32 acceptance under D20. The owning feature IDs remain unchanged; appearance acceptance is unverified until the relevant detailed criteria pass.

The [TypeScript provider SDK and conversation UI specification](../02-providers/provider-sdk-conversation-ui.md)
refines the conversation-facing extension contract: full provider worker parity,
namespaced typed operations, separate backend/UI contributions, readable fallbacks
and independent installed-provider proof. Its production UI loader and safe-mode
acceptance remain work to verify, not guarantees supplied by manifest declarations.

This specification records required behavior, not implemented completeness. The shared v1 register contains all 140 original catalogue dispositions, scope corrections, delivery dependencies and remaining decisions. No source file layout or package candidate overrides the agreed product behavior.
