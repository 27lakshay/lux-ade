# 08 — Apply provider settings with accurate effective state

Status: complete
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Choose supported model, reasoning and permission settings and see the settings actually in effect after dependent changes or partial failure.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md)

**Spec coverage:** PC20, PC32. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Settings metadata includes support, availability, source, limits and a revision bound to the current installation/account/session context.
- [x] Apply the model before model-dependent modes or reasoning, rediscover valid choices and serialize conflicting configuration transitions before dispatch.
- [x] Reject stale options and presets that conflict with current capabilities; validation does not implicitly change account or widen permission scope.
- [x] A partial native failure reports applied settings, unapplied changes and recovery evidence. Atomic rollback is claimed only when native guarantees support it.
- [x] CLI/SDK and desktop read the same effective values and actionable configuration errors, with no silent model or permissive-mode fallback.
- [x] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Use a peer whose modes change with its model, fail the second update and race revisions; verify native effects and effective settings through public APIs and desktop controls.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.

2026-10-02: Implementation and acceptance (decisions taken under the user's standing instruction to decide unattended).

Decisions:
- Settings are model, reasoning level and permission mode. `provider::Config` gains an optional `reasoning_effort`; `provider::reasoning_efforts` lists the levels ADE can request (Codex: minimal, low, medium, high, sent as `turn/start` `effort`); providers with no listed levels refuse a reasoning request rather than emulate it. Preset reasoning, previously dropped when a conversation was created, now reaches the launch.
- `conversation.settings` (query) returns, per setting, the requested value, the value in effect with its source (`native_reported`, `requested_only`, `provider_default`), the choices offered now, support and reason, plus a `revision`, whether an Agent is connected and whether a turn runs. Effective values come only from the provider: adapters report what the session opened with (`Connected.native_settings`; Codex names the model on `thread/start`/`thread/resume`), stored on the Conversation and cleared when settings change.
- `conversation.settings.update` (effect command with envelope receipt) applies at `expected_revision`, model first, then the settings that depend on it, then validates the whole result against the provider's current descriptor; a stale revision, an unoffered permission mode or reasoning level is refused and nothing is substituted or widened. It is refused while a turn runs. An idle connected Agent is relaunched under the new settings; a failed relaunch keeps the stored revision and returns `native_error` (no rollback is claimed). The account is never changed.
- The capability record for Codex now declares reasoning selection supported with its levels; the record invariant (Rust test and F028) is that a supported claim lists the levels a launch carries.
- CLI: `conversation settings ID`, `conversation configure ID --revision N [--model M] [--reasoning L] [--permission-mode P]` (`-` returns a value to the provider default; a stored-but-unapplied change exits non-zero). Desktop: provisional `ProviderSettingsPanel` (requested and in-effect values with source, change form at the current revision).

Evidence (deterministic Codex fixture; not installed or live evidence):
- `pnpm check:static`: passed (`test-results/runs/static-9f534d98-a8b0-4e97-922b-7b3123a24010`).
- `e2e/protocol/conversations/settings.spec.ts` (2): native-reported model, refused stale revision and unoffered values, model-first change relaunching the idle Agent, effective model reported by the new session, receipt replay without a second relaunch, `effort` on the next `turn/start`, CLI read and reset; refusal while a turn runs. `providers/capabilities.spec.ts` and `providers/presets.spec.ts` updated and passing (`test-results/runs/protocol-52cb1577-103b-4a51-8ccf-66d43e54e6da`).
- Built Electron `e2e/desktop/settings.spec.ts`: the panel shows the provider-reported model, saves a model and reasoning change, and then shows the new reported model; the SDK reads the same values (`test-results/runs/desktop-586e9f95-e4d9-44f3-9d13-88f1fe46db32`, screenshot `provider-settings.png`).

Not covered: native model discovery (`model/list`, Claude `supportedModels`) is not called, so model is free text validated by the provider at launch; Claude and OMP report no effective settings yet, so their values read `requested_only`/`provider_default`.

2026-10-02 (later): Native discovery and dependent validation (PC32 gap). Run in a worktree; deterministic fixtures, not installed or live evidence.

Built:
- Discovery at session open, carried on `Connected.native_choices` (`provider::NativeChoices`/`NativeModel`, bounded to 512 models) and held on the daemon's Agent for that run: Codex `model/list` (all pages, hidden models left out, each model's `supportedReasoningEfforts`); Claude `initializationResult().models` (the `supportedModels()` rows, `supportedEffortLevels`, `supportsEffort: false` = none, `resolvedModel` as alias); Oh My Pi `get_available_models` as `provider/id`, with `get_available_thinking_levels` for the live model only. A refused, slow (OMP, 10 s) or oversized listing reports none.
- `conversation.settings`: each setting carries `choices_source` (`native_reported`, `static`, `unavailable`); reasoning and permission choices are those listed for the requested model (else the one in effect, else the listed default), narrowed to what ADE can request; `discovery` reports availability, source call, run and reason (no Agent connected / provider listed nothing), and each listed model with what ADE would offer were it selected. No provider lists permission modes per model, so permission choices stay `static`.
- `conversation.settings.update`: an unlisted model is refused when a list exists; after the model, every dependent value, changed or kept, is checked against the new model's choices and one it does not offer refuses the whole change (nothing stored, no relaunch). With no list, the model stays free text.
- Effective settings: new provider `Event::Settings` merges into `Conversation.native_settings`. Claude reports `system/init` model and permission mode (effort only when the frame names it; the SDK subprocess frame does not, so it stays unknown); OMP reports `get_state` model and thinking level at open. Claude reasoning is now selectable (SDK `effort` option; levels low…max); capability records revision 2 (discovery supported for all three; Claude reasoning supported).
- Provisional desktop panel: model select from the listed models (free text when unavailable, with the reason), reasoning/permission options for the drafted model, each labelled by source; an unoffered drafted value stays visible and marked.

Evidence:
- `pnpm check:static`: passed (`test-results/runs/static-276c087e-fed5-4d90-bf2b-f8d3c166a31d`).
- Protocol `conversations/settings.spec.ts` (6), `providers/capabilities.spec.ts`, `providers/presets.spec.ts` (preset refusal now uses OMP): 13 passed (`test-results/runs/protocol-cb1d7c08-d8a1-49c8-a277-233d18054f08`). Includes PC32: after a model change to B, a second update to a model that does not offer the kept level, and one requesting it, are refused; settings, the Conversation record and the native open count are unchanged; a valid level then applies with the new model's choices. Also: discovery unavailable (static/unavailable labels, free-text model), Claude per-model effort refusal and `effort: max` reaching the SDK with init-reported model/mode, OMP reported model/thinking level and listed models.
- Regression: `providers/`, `native-history.spec.ts`, `ops3/omp-mcp.spec.ts` 28 passed (`protocol-55f2f67e-0d7c-432c-ade3-9023ea955720`); `conversations`, `conversations2`, `accounts*` 95 passed, 1 failed (`protocol-00e9756b-1771-4cd8-b7aa-deb623f0fcb7`): `lost-turn.spec.ts` daemon-survives, which also fails with discovery disabled and in the main checkout's run `protocol-fcdf9129-8e5a-4106-a56f-2672d446148a`; not caused by this change.
- Built Electron `e2e/desktop/settings.spec.ts` (+ `claude.spec.ts`, `omp.spec.ts`): listed models by display name, per-model levels shown for a drafted model before saving, source captions; 3 passed (`test-results/runs/desktop-fdf8486f-6d3e-4b4a-afad-7679f0adb533`).
- Worker tests: `providers/claude/settings.test.mjs` (new), Claude `worker.test.mjs`, OMP `worker-peer.test.mjs`; Rust unit tests for discovery bounds, `model/list` row mapping and dependent-choice narrowing.

Gaps: discovery lives with the connected run, so with no Agent connected choices are static/unavailable and a model is free text; a change applied by relaunch reads static choices until the new session opens. Codex levels outside ADE's table (`xhigh`) are listed but not offered. Claude `auto` mode stays unoffered (record decision), though `supportsAutoMode` is reported per model. OMP reasoning selection remains native-only. Live provider evidence not collected.
