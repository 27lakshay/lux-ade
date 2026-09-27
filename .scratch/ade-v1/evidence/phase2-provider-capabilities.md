# provider-capabilities

Status: returned
Type: slice evidence
Branch: claude/wf_a7262165-955-5
Worker: Phase 2 round D, provider-capabilities slice
Requirements: F027 (setup, authentication and readiness, backend); F028 (model, reasoning and permission capabilities, backend); F029 (agent presets, backend); F030 (quota and limit visibility, backend); D04 (record actual capability; unavailable is explicit)

## Outcome

Each adapter now declares a revisioned capability record, and the daemon serves it with readiness, quota and profile presets through seven typed operations and a CLI area. No requirement is fully accepted: all four still need E2E and UI evidence.

Design points:

- **Records (D04).** `claude.rs`, `codex.rs`, `omp.rs` and `opencode.rs` in `ade-runtime` each have a `capabilities()` function. It declares models, reasoning, permission modes, grant scopes (once, session, persistent), steering, rewind, compaction, resume, import, fork, account switching, quota reporting and managed accounts. Each item is `supported`, `native_only`, `unsupported` or `unknown`, with a note that names the native mechanism.
  - `supported` means ADE can use the item today.
  - `native_only` means the provider has it but the adapter does not expose it.
  - The records were checked against these sources:
    - Claude: the pinned `@anthropic-ai/claude-agent-sdk` 0.3.281 `sdk.d.ts`.
    - Codex: `codex app-server generate-json-schema` from the validated codex-cli 0.157.0.
    - Oh My Pi: `oh-my-pi/docs/rpc.md` and `packages/agent/src/thinking.ts` at 18.3.0.
    - OpenCode: `opencode-v2/packages/protocol` and `packages/schema`, the snapshot `PROVENANCE.md` names.
- **Revisions.** The daemon seals each record with a SHA-256 fingerprint of its JSON. `core::compare` classifies a change as unchanged, revised, drifted (the content changed but the revision did not) or downgraded.
- **Consistency.** A runtime test asserts that each record's supported permission modes equal the `Descriptor.permission_modes` that `Config::validate` enforces at launch. A second test asserts that no record claims reasoning selection. `provider::Config` has no reasoning field, so any such claim would be fabricated.
- **Readiness (F027).** `provider.readiness` resolves each executable the adapter needs. It uses the same override variable or `PATH` lookup as the launch, reads metadata only and runs nothing.
  - Without an account, the best verdict is `installed_unchecked`, never `ready`.
  - With an account, it runs the existing `account.inspect` probe, which is runtime-owned and checks version and sign-in. It then compares the result with the pinned identity.
  - The verdicts are `ready`, `missing_executable`, `incompatible`, `needs_authentication`, `needs_verification`, `identity_changed`, `account_disabled` and `unavailable`. Each comes with an actionable reason and a per-check list. An unknown probe state fails closed as `unavailable`.
- **Presets (F029).** Presets hold a name, provider, model, reasoning level and permission mode. They never hold an account, so applying one cannot change account identity.
  - They are stored in the new `provider_presets` table in `sessions.sqlite`, created idempotently.
  - `preset.save` refuses any setting the current record does not mark `supported`. Saving the settings a preset already has converges without a new revision.
  - Replacing a preset needs the expected revision, and so does deleting one. Deleting an absent preset converges.
  - `preset.list` and `preset.get` recheck every preset against the current record. They report the capability change and any conflicts; they never adapt a preset silently.
- **Quota (F030).** `provider.quota` reads `usage.limits` and returns one entry per provider and account, including the provider's own login and every active managed account.
  - `reported` entries carry the windows, `observed_at` and `age_ms`.
  - `not_reported` means the provider reports limits but none has arrived yet.
  - `unavailable` means the provider does not report limits, or nobody has confirmed that it does (currently Oh My Pi and OpenCode).
  - `exhausted` is set only for windows that have not reset. Nothing switches account or model.

## Operation tiers

| Operation | Tier | Request | Response |
|---|---|---|---|
| `provider.capabilities` | query | `ProviderCapabilitiesRequest` | `ProviderCapabilities` |
| `provider.readiness` | query (reads files; with an account, runs the read-only account probe) | `ProviderReadinessRequest` | `ProviderReadiness` |
| `provider.quota` | query | `ProviderQuotaRequest` | `ProviderQuota` |
| `preset.list` | query | `PresetListRequest` | `PresetList` |
| `preset.get` | query | `PresetGetRequest` | `PresetView` |
| `preset.save` | idempotent command (expected-revision guard; identical settings converge) | `PresetSaveRequest` | `PresetSaved` |
| `preset.delete` | idempotent command (expected-revision guard; absent converges) | `PresetDeleteRequest` | `PresetDeleted` |

Existing operations are unchanged. `provider.list` keeps its `Descriptor` wire shape.

CLI: `apps/cli/src/commands/providers.ts` adds `provider capabilities|readiness|quota` and `preset list|show|save|delete`.

## Checks

- `pnpm check:static`: pass
- In-process tests added:
  - `crates/ade-daemon/src/capabilities/core.rs`: preset validation, revision comparison, fingerprints, name rules, readiness verdicts, quota grouping and exhaustion.
  - `crates/ade-runtime/src/capabilities.rs`: records match the launch descriptors, and no record claims reasoning selection.
  - `crates/ade-core/src/contract/providers.rs`: schema round trips.
- A throwaway in-process smoke test ran once and was then deleted, as the test policy requires. It is not part of the gate. It covered preset create, converge, the conflicting create, a guarded update, the stale-revision refusal, the reasoning refusal, a guarded delete, delete convergence and idempotent table creation. It also ran installation checks against this host, where codex and bun resolved and the bundled omp CLI was skipped.
- Verified only statically:
  - the session dispatch;
  - the `account.inspect` hand-off inside readiness;
  - the `usage.limits` read inside quota;
  - the CLI wiring.

## Time

| Implementation | Review | Checks | Integration |
|---|---|---|---|
| 75 | 5 | 10 | 0 |

## References

- Claude Agent SDK 0.3.281 (`providers/claude/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`), studied: `PermissionMode`, `EffortLevel`, `ModelInfo.supportedEffortLevels`, `rewindFiles`, `forkSession`, `supportedModels`.
- codex-cli 0.157.0, `codex app-server generate-json-schema`, studied: `model/list`, `turn/steer`, `thread/compact/start`, `thread/revert`, `thread/fork`, `AskForApproval`, `SandboxMode`, `ReasoningEffort`.
- Oh My Pi @ ade-evaluation-2026-09-24, `docs/rpc.md` and `packages/agent/src/thinking.ts`, studied: steering, compaction, branching, thinking levels and model listing.
- OpenCode-v2 @ ade-evaluation-2026-09-24, `packages/protocol/src/groups/session.ts`, `packages/schema/src/{model,permission,session-inbox}.ts`, studied: fork, compact, revert, import, steer delivery, model variants and `once`/`always` replies.
- No code copied.

## Open

- **Reasoning selection end to end.** Add a `reasoning` field to `provider::Config` (in `ade-core/src/provider.rs`, which other slices share) and pass it through each bridge: Claude `effort`, Codex `turn/start.effort`, OMP `set_thinking_level` and OpenCode `#variant`. Then raise each record's revision to `supported`. Until then, presets with a reasoning level are refused.
- **Applying a preset.** `conversation.create` does not accept a preset name yet; that belongs to the conversations domain. A caller can read `preset.get` and pass `model` and `permission_mode` itself.
- **Model discovery.** No adapter lists models; `discovery` is `native_only` everywhere. Each provider has a listing call: `supportedModels`, `model/list`, `get_available_models` and `GET /api/model`.
- **Native-login readiness.** Without a managed account, version and sign-in are not checked (`installed_unchecked`). A runtime-owned probe for the provider's own login is needed.
- **Unconfirmed support.** Oh My Pi and OpenCode quota reporting is `unknown`, and so is in-conversation account switching on every provider. Real-provider E2E should settle these, and D04 should record the outcome.
- **Presets and instructions.** User story 9 mentions instruction settings; presets carry none yet.
- **E2E (F027-F030 acceptance rows).** The rows need missing-executable, invalid-credential, incompatible-version and ready states, and revalidation after a CLI update. They need a stale preset rejected after a capability revision, and quota display with source and freshness. UI surfaces are needed for all four.
- **Coordinator.** No shared file needed changes beyond the one-line registrations in `sessions.rs`, `lib.rs` (daemon and runtime) and `apps/cli/src/index.ts`. `sessions.rs` also gained the `presets` field and its open line, following the usage precedent. `provider_presets` in `sessions.sqlite` needs backup coverage confirmed if backups list tables.
