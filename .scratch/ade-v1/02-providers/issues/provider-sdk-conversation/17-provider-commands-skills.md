# 17 — Run provider commands and skills with explicit semantics

Status: complete
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Discover and invoke supported provider commands and skills while understanding whether an action executes locally, natively or as model input.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md)

**Spec coverage:** PC02, PC06, PC28. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Expose native command/skill metadata with source, current availability, validated input and declared operation tier through public workers.
- [x] Composer discovery and invocation preserve the provider’s actual behavior; slash syntax cannot silently change an effect into an untracked local action.
- [x] Local commands and native command completion have distinct outcome evidence from a streamed model turn. Unsupported commands fail without consuming the draft.
- [x] Preserve complete skill resources/provenance and external ownership according to existing selected skill scope; do not implement a new marketplace.
- [x] CLI/SDK and desktop show corresponding results and native limits without provider-name branches in shared widgets.
- [x] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Use native peers for local/native/model-command distinctions and stale metadata, then invoke those actions in built Electron and inspect their operation evidence.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.

2026-10-02: Implementation and acceptance (decisions taken under the user's standing instruction to decide unattended).

The backend for this slice existed (F037): `command.list` (query) reports each command and skill with provenance (provider file, provider skill, or ADE catalog bundle; scope; path; content hash), whether it is invocable, its native text and mechanism, or why not; `command.invoke` (effect command with a receipt) queues the native text under `<operation_id>:command`, never twice, and reports `queued`, `unavailable`, `unknown` or `cancelled`. Codex lists its prompts and skills as unavailable. Skill catalog adoption, drift and placement keep external ownership (`catalogs/skills.spec.ts`). ADE does not query a live session's built-in or plugin commands; the list says so (`native_catalog.queried: false`).

Decision (desktop, provisional): a "Commands and skills" panel beside the provider settings lists every entry with its kind, native text, description and source path, with an arguments field and "Run <name>" for invocable entries, or "Unavailable: <reason>". Run calls `command.invoke` and reports its outcome; "queued" is described as ADE's queue holding the native text, not a provider acknowledgement. The panel says that typing `/name` in the prompt sends it as text instead, so slash syntax never silently becomes an untracked local action. The widget has no provider-name branches; it renders what the daemon reports.

Evidence:
- `pnpm check:static`: passed (`test-results/runs/static-957f251c-fa7d-48f9-9ed4-3efc28473491`).
- Real processes (existing, passing in the full runs): `context/commands.spec.ts` 4/4 (Claude listing with provenance and a single native invocation, refusals without queueing, Codex unavailable, a lost reply queued once across a daemon crash), `catalogs/skills.spec.ts`, `ops3/skill-*.spec.ts`.
- Built Electron: `e2e/desktop/commands.spec.ts` (`test-results/runs/desktop-26a2cb95-2c98-4c6b-9f24-fb7d3612f76b`): a project command listed with its file; Run delivers `/review src/app.ts` to Claude exactly once. Screenshot `commands.png`.

Not covered: commands the provider builds in or loads from plugins (no native listing is queried); slash completion inside the editor itself.
