# 21 — Install a real fourth provider without core changes

Status: complete
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Install an independently packaged real additional provider and use it for a native turn, retained history and honest failure/recovery without patching ADE core.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md), [12 — Load bounded history with correct tool attribution](12-bounded-history.md)

**Spec coverage:** PC01, PC02, PC15, PC17, PC20, PC30, PC38. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Use a genuine additional integration, with OpenCode recommended; renaming a fixture or wrapping an existing primary provider does not satisfy this ticket.
- [x] Package native dependencies and the compatible Effect runtime through normal plugin installation. No privileged bundled-only operation or source edit in ADE core is needed.
- [x] Complete send/text/tools and supported history through the public contract, with declared unsupported requests, cancellation and optional operations rather than fabricated parity.
- [x] Exercise unavailable native installation, accepted-input worker failure and restart/recovery with explicit outcomes and no implicit prompt resubmission.
- [x] Demonstrate one authoring path across offered Effect/Promise/AsyncIterable interfaces, including typed errors, disposal and cancellation evidence; pass scoped diagnostics and conformance.
- [x] Record real installed-provider and authenticated live evidence separately from fixtures, with artifact digest, native version, account context and capability matrix.
- [x] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Install the real packaged artifact into a scratch profile, exercise public operations and the built desktop, and run its native evidence with explicit credentials/prerequisites.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.

2026-10-02: Implementation and evidence (unattended; checkboxes and status left for review).

Built: OpenCode as an independently packaged provider plugin, `plugins/opencode` (`@ade/opencode-provider`, manifest id `ade.opencode`, provider `plugin:ade.opencode`). It uses only `runProviderWorker` from `@ade/provider-sdk/node`, pins `@ade/provider-sdk` 0.2.0 and `effect` 4.0.0-rc.118, and is installed with the ordinary `plugin.install` from `plugins/opencode/artifact`, assembled by the new shared `scripts/package-provider-plugin.mjs` (also used by the SDK diagnostic; it prunes maps, declarations and unreferenced sources, 97 MB → 34 MB). The OpenCode protocol modules moved from `providers/opencode` with provenance (`plugins/opencode/PROVENANCE.md`, `LICENSE-opencode`). Capability matrix: `plugins/opencode/README.md`. A fallow boundary zone allows the plugin no ADE source imports (contract types only).

Deleted (D19): the bundled adapter `crates/ade-runtime/src/opencode.rs`, its registry entry and launch, the `opencode` built-in descriptor, `providers/opencode/{bridge.mjs, bridge.test.mjs, live.test.mjs, loopback.test.mjs, project.json}`, the `opencode` arms in prompt attachment plans, command catalog and control availability, the macOS packaging copy, and `ModelFormat::ProviderQualified` (its only user; contracts regenerated). Skill placement into OpenCode's own skill directories is kept: it targets OpenCode's files, not the conversation adapter.

Decisions: (1) The native prompt ID is `msg_<ADE message ID>`, and that prompt's item keeps the ADE message ID, so a retried dispatch names the same OpenCode prompt and the echo merges. (2) Generic readiness: a plugin whose handshake declares `open`/`send` `unavailable` is reported `unavailable` with that reason and a failed `provider.native_work` check (`provider_worker::native_readiness`, daemon readiness); a missing OpenCode becomes that declaration. (3) Stop reports scope `session` and `confirmed` only when OpenCode's own interrupted idle record exists; otherwise `requested` with active/queued counts. (4) A prompt OpenCode still holds after a worker death is disclosed as an unattributed request and re-delivered only on an explicit resume. (5) Steering, compaction, rewind and MCP are declared unsupported with reasons (OpenCode has routes; ADE does not admit those controls for plugin workers). (6) Text items are keyed by OpenCode's text-fragment ordinal; position keys duplicated replies when reasoning preceded text (found in the first live run). (7) Open waits up to 10 s for the chosen model in OpenCode's model snapshot.

Authoring path: `src/session.ts` (Effect service) is the one execution path; `src/worker.ts` serves it; `src/client.ts` exposes Promise methods and an AsyncIterable over the same ManagedRuntime. `test/client.test.mjs` shows identical typed failures, AbortSignal/fiber interruption abandoning the held native read, and confirmed server exit on dispose. `effect-tsgo diagnostics`: 0 errors, 0 warnings, 0 messages.

Evidence:
- Static: `pnpm check:static` passed (`test-results/runs/static-e3b02dda-1d65-422d-8100-69e946719f02`); plugin unit tests 57/57 (provider stage `opencode`).
- Fixture (mock OpenCode, real daemon/runtime, packaged plugin): `e2e/protocol/adapters/opencode-plugin.spec.ts` 5/5 — install/inspect, streamed turn with tool, paged history, approval, confirmed Stop, missing installation, accepted-then-worker-died (one prompt, no resend), parked prompt resumed only on explicit answer. Final directory run of `e2e/protocol/adapters`, `plugins`, `providers` and `native-history.spec.ts`: 74 passed, 1 skipped (live, opt-in), 1 failed: `plugins/dev-reload.spec.ts:106` ("Plugin host is retired"), a backend-plugin case that passed 3/3 when rerun alone (`protocol-fe188681-79ee-4818-b18f-7cb2acf477ae`, rerun `protocol-65d8c856-be74-43de-af3e-9cab55a6ff03`). Built desktop: `e2e/desktop/opencode-plugin.spec.ts` and `omp.spec.ts` 2/2 (`desktop-25c5f97f-20f0-4201-ae77-15f6d6090ea7`).
- Installed: OpenCode 2.0.22 (`~/.opencode/bin/opencode`, sha256 `af29b0b1…5a75`), scratch config/data, local loopback model, no account: `pnpm test:providers:installed --provider opencode` 1/1 (`providers-installed-89b73330-6fbc-4fad-b82b-25f0dbc76566`, `protocol-091ebce4-419d-4c4c-b662-e9f9746619c4`): two streamed turns, history pages, disconnect/resume with no new model call.
- Live: OpenCode 2.0.22 with the machine's own OpenCode sign-in (OpenCode Console API-key credential), model `opencode/fledge-alpha-free`, workspace under `/tmp/claude-501`, one prompt "Reply with the single word ok" → one reply "ok" (`protocol-b285ea97-095b-435d-96c4-9dc5fdee2bf6`). `auth.json` hash, config mtimes and the credential records were unchanged. An earlier live run (`protocol-44d181c9-6bed-49fe-b339-5e02b25360f0`) found the duplicated reply fixed by decision 6; two live prompts were sent in total.
- Artifact digest for installed and live: `sha256:4db5448d85bd5731ac70c00d62792e044af9aeeaf55615e6738d6c09c42e1d34`.

Not covered: OpenCode permission/form requests, child transcripts and attachments have fixture/unit evidence only; no installed or live run exercised them. Stop against installed OpenCode was not run. Managed OpenCode accounts, usage and quota are not provided.

2026-10-02: Accepted after review and integration (decisions taken under the user's standing instruction to decide unattended).

The implementation above was built in an isolated worktree, reviewed, and applied to agent-work-2 together with the parallel work on tickets 20, 21 and 24–26 (conflicts in the workspace list, provider test runner and provider README merged by hand; generated contracts and the lockfile regenerated here, not copied). On the merged tree: `pnpm check:static` passed (`test-results/runs/static-e687aa37-a5b5-4dd7-b805-3de4575087b5`); `e2e/protocol/adapters` 24 passed with 3 opt-in live cases skipped, and `plugins/ui-contributions.spec.ts` passed; built Electron `acp.spec.ts`, `plugin-ui.spec.ts` and `opencode-plugin.spec.ts` 7/7.
Full runs on the merged tree: protocol 1097 passed, 6 failed, 8 skipped; the six also fail on HEAD (conversation delete after a daemon kill, lost turn, theme validation and three escaped-descendant cases). Desktop 118 passed; the `plugin-ui.spec.ts` cases failing in that run were caused by a fixture change made mid-run and pass 6/6 on the rebuilt tree (`test-results/runs/desktop-ea7ff3c7-a195-4965-b213-b4e50094c7b9`), with `appearance.spec.ts` density passing on rerun.

Accepted as built. Not covered live: Stop, permissions and child transcripts against the real OpenCode (mock only); account management and usage are not reported by the plugin.
