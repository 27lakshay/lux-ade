# e2e-providers

Status: returned
Type: slice evidence
Branch: claude/wf_40412ab1-96e-4
Worker: ADE parallel build, E2E round 2, slice provider-features
Requirements: F026, F027, F028, F029, F030 (02-providers); D04

## Outcome

Headless protocol E2E now covers provider capability records, readiness,
presets, quota visibility and explicit account switching. The specs drive real
daemons and runtimes through the SDK, the CLI and the raw protocol. 19 tests
pass and 1 is `test.fixme`. The suite passed three times in a row with
`--repeat-each 3` at 2 workers on a host with a load average above 40.

Three product gaps were fixed:

- `conversation.create` can apply a preset.
- Readiness no longer requires Bun for a launch that never runs it.
- A probe that times out now reports `unavailable`, not `incompatible`.

Full register acceptance now passes as protocol E2E for **F027**, **F028**,
**F029** and **F030**. This holds against scripted provider CLIs; no real
provider CLI or account was used. **F026** is partial: switching works and is
refused as the spec requires. No bundled adapter declares native continuation,
so that path has no provider to run against.

## New generic fixture

`e2e/protocol/fixtures/provider-cli.ts` (`FakeProviderClis`), with
`fake_codex.py`. It installs scripted `codex` and `claude` executables under
the test's temp root and returns the daemon environment that selects them
(`ADE_CODEX_BIN`, `ADE_CLAUDE_BIN`). A spec can do the following:

- `install(provider, version, { hangs })` replaces a CLI in place, the way an
  external update does. `hangs` makes `--version` never answer.
- `uninstall(provider)` removes a CLI.
- `signIn` and `invalidateCredentials` write fixture credentials into an
  account's native home.
- `codexCalls()` and `codexLaunches()` read what Codex saw. Each launch records
  the `CODEX_HOME` it ran under.
- `exhaustCodexLimits()` makes later rate-limit reports say 100 %.

The shell wrapper answers `--version`, and Claude's `auth status`, by itself.
This keeps the runtime's two-second probe budget on a loaded host. Codex
turns still run on `scripts/fixtures/codex_mock.py`. Nothing reads a real
account.

## Acceptance criteria

Specs are in `e2e/protocol/providers/`.

### F026 Explicit in-conversation account switching

| Criterion | Spec | Result |
|---|---|---|
| Switch using an adapter-declared operation: a Codex conversation moves between two verified managed accounts; the next turn launches in the new account's `CODEX_HOME` with a new native thread, and no resume | `account-switch.spec.ts` "a Codex conversation moves to another account…" | pass |
| Retain provenance: `from` and `to` accounts and generations, `previous_native_session`, the operation ID and `agent_stopped`; `account.switch.list` and CLI parity; later switches are kept in order | same, plus "a retried switch converges…" | pass |
| Disclose continuity limits: the preview and the switch record state that native tool state, hidden context and history stay behind, and how many messages move; the excerpt reaches the provider once, framed as a record, and is marked delivered; the stored user message is unchanged | "a Codex conversation moves…" | pass |
| Reject unsupported switching without silently creating a different session: `native_continuation` is refused for Codex and Claude, whose records declare `unknown`, and the refusal names `new_native_session`; nothing changes | "a Codex conversation moves…", "a legacy conversation… Claude switching follows its declared capability" | pass |
| Refused during an active turn and with an open approval; nothing recorded; allowed once the turn ends | "a switch is refused during an active turn…" | pass |
| Fences: stale target generation, wrong expected current account, same account, unverified, disabled and other-provider targets | "stale fences, unverified, disabled and foreign targets…" | pass |
| Effect command faults: a lost reply is reconciled by retrying the operation ID; a repeat returns the stored reply; a reuse with another payload is a conflict; the receipt survives a daemon SIGKILL | "a retried switch converges on its receipt…" | pass |
| Legacy ambient conversation moves to a managed account | "a legacy conversation on the provider login…" | pass |
| A provider that declares native continuation keeps its native session | "a provider that declares native continuation…" | fixme: no bundled adapter declares `conversation.account_switch: supported` |

### F027 Provider setup, authentication and readiness

| Criterion | Spec | Result |
|---|---|---|
| Missing executable, with an actionable reason naming the override variable (Codex and Claude, with and without an account) | `readiness.spec.ts` Codex and Claude tests | pass |
| Invalid credentials and signed-out homes report `needs_authentication` with a sign-in instruction | same | pass |
| Incompatible version (Codex 0.158.0, Claude 2.0.9) with the version read | same | pass |
| Ready only after verification; `needs_verification` before; `identity_changed` after a different sign-in; `account_disabled` | same | pass |
| Revalidate after an external CLI update: uninstall, an incompatible update, then reinstall; a launch checks again and fails with the same reason | Codex test | pass |
| A stuck CLI is reported as a failed check (`unavailable`, "retry"), not as incompatible | Claude test | pass |
| Without an account ADE never claims ready (`installed_unchecked`); a bundled executable is skipped; unknown provider, a foreign account and a missing account are refused; CLI parity; the verdict holds after a daemon SIGKILL | Codex test, "providers without a managed-account probe…" | pass |
| Bun is required only when the shared Codex transport would run | "Bun is required only by the shared Codex transport…" | pass |

### F028 Model, reasoning and permission capabilities

| Criterion | Spec | Result |
|---|---|---|
| Every bundled adapter serves a record with a revision and a SHA-256 fingerprint; support values are explicit; supported permission modes equal what launches accept; no record claims reasoning selection; records are identical after a daemon restart; CLI parity | `capabilities.spec.ts` "every bundled adapter serves a sealed, revisioned record…" | pass |
| Select supported settings: a model and `read-only` reach Codex `thread/start` | "a supported model and permission mode reach the provider…" | pass |
| Reject unsupported choices: native-only and unknown permission modes for Codex and Claude are refused before launch | same | pass |
| Refresh capabilities and reject stale choices: a preset saved against an earlier record is reported `revised` with its conflict and refused at application | `presets.spec.ts` "after a capability revision a stale preset…" | pass |
| Preserve once-only versus persistent meanings: session-wide and persistent Codex grants are refused before dispatch; `accept` is sent once; a permission grant is scoped to the turn | "an approval keeps its once-only meaning…" | pass |

The capability revision cannot change inside one build. The stale-preset spec
therefore rewrites a stored preset row, as an earlier build would have saved
it, and lets the daemon read it back.

### F029 Agent presets

| Criterion | Spec | Result |
|---|---|---|
| Create, converge on repeat, replace at the expected revision, refuse a stale writer, delete at the revision seen, converge on repeat delete, survive a daemon SIGKILL | `presets.spec.ts` "a preset is created, converges on repeat…" | pass |
| Settings the current record does not support are refused with the reason and nothing is stored (reasoning, native-only and unknown modes, OpenCode model format, unknown provider); CLI parity | "saving a setting the current record does not support…" | pass |
| Apply a preset and show the resolved settings: `conversation.create` with `preset` returns the resolved provider, model and permission mode, and the launch uses them; CLI `--preset` | "applying a preset shows the resolved settings…" | pass |
| Without changing account identity implicitly: the account stays null, or stays the chosen managed account, and its generation is unchanged | same | pass |
| Capability conflicts: `revised` and `drifted` changes are reported; a conflicting preset is refused, not adapted; resaving clears it | "after a capability revision a stale preset…" | pass |

### F030 Quota and limit visibility

| Criterion | Spec | Result |
|---|---|---|
| Show unavailable when unknown: every provider and account has an entry; Oh My Pi and OpenCode are `unavailable` with a reason; Codex and Claude are `not_reported` before any report, never zero | `quota.spec.ts` "before any report…" | pass |
| Reported quota and reset data with source and freshness: a managed account's window has `source`, `resets_at`, `plan`, `observed_at` and `age_ms`, and its age grows; other accounts stay `not_reported`; the data survives a daemon SIGKILL; CLI parity | "a managed account shows the limits its turns reported…" | pass |
| Do not silently switch account or model on exhaustion: `exhausted` is set, and the next turn runs on the same account home and model with no switch recorded | "an exhausted limit is shown…" | pass |

Displaying quota in the UI is outside this backend slice.

## Product fixes

- **Presets could not be applied (F029).** `conversation.create` gained an
  optional `preset`:
  - The daemon rechecks the preset against the current record.
  - It refuses any conflict, and names each one.
  - It refuses a different explicit provider, and `provider_config` alongside a preset.
  - It never touches `account_id`.
  - The pure decision is `capabilities::core::apply`, with an in-process test.
  - The CLI gained `conversation create … --preset NAME`.
  - Files: `crates/ade-core/src/contract/conversations.rs`,
    `crates/ade-daemon/src/sessions/conversations.rs`,
    `crates/ade-daemon/src/capabilities/core.rs`,
    `apps/cli/src/commands/conversations.ts`, and the regenerated contracts.
- **Readiness required Bun for launches that never run it (F027).** Only the
  shared Codex app-server transport runs Bun. Managed-account launches and the
  stdio transport run the Codex CLI directly.
  - `capabilities::Executable` gained `used_by`.
  - `codex::shared_transport` is now the single rule, and the launch uses it too.
  - `capabilities::installation` skips an executable the launch will not run, and says so.
  - An in-process test covers the rule.
- **A probe timeout was reported as an incompatible CLI (F027).** The Claude,
  Codex and Oh My Pi probes returned `incompatible` when the version or status
  check failed to start or timed out.
  - They now return `unavailable` with "retry".
  - Readiness maps that to `unavailable`, which means the check itself failed.
  - The readiness decider test covers the new state.
  - On a heavily loaded host this was also the source of false `incompatible` verdicts.

## Checks

- `ADE_E2E_WORKERS=2 pnpm test:e2e:protocol:only e2e/protocol/providers`: 19
  passed and 1 fixme. The same run with `--repeat-each 3` gave 57 passed.
- `pnpm check:static`: pass.

## Open

- F026 native continuation needs an adapter that declares and implements it.
- The launch path's account probe has the same two-second budget. On an
  extremely loaded host a managed-account turn can still fail with
  "timed out; retry". The specs retry only setup verification and poll
  readiness, never the behaviour under test.
- The excerpt delivery mark follows Codex's `turn/start` response, which can
  arrive just after the turn's own completion events. The spec polls for
  `delivered` rather than expecting it at idle.
- Claude managed-account turns were not run. A managed Claude launch clears the
  environment, so the bridge mock cannot find its fixture directory. Claude is
  covered for readiness, verification and the switch decision.
- No bugs were found outside this area.
