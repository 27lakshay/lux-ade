# 03 — Send and stream a Codex turn through the public SDK

Status: complete
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Send a prompt from the production composer to native Codex through the public provider SDK and read its ordered text and structured tools with durable submission identity.

**Blocked by:** [01 — Open a readable production conversation](01-production-conversation.md), [02 — Install and inspect an Effect provider worker](02-effect-worker-installation.md)

**Spec coverage:** PC02, PC04, PC05, PC06, PC23, PC28, PC31, PC33, PC38. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Create or select an identified Codex conversation and submit through the existing durable send-intent and effect-admission path. Record admission, dispatch and native acceptance separately.
- [x] The daemon computes the fingerprint. Repeating an operation with the same payload returns its known receipt without another native submission; conflicting payload reuse fails.
- [x] Acquire native event subscriptions before readiness and dispatch. Output arriving immediately, before the submit reply or during startup is correlated once without timing sleeps.
- [x] Render streamed text, exposed reasoning where supplied and structured tool status using existing selected UI packages. Bound inline output and preserve core summaries/native provenance.
- [x] Native rejection, failed admission and unavailable execution preserve recoverable input and useful typed errors. Command acknowledgement is not completion.
- [x] Codex uses the public worker interface rather than a privileged bundled-only route. Opening/closing its view leaves runtime ownership intact, and every facade shares one execution path.
- [x] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Drive send and tool output in built Electron against real ADE processes and deterministic native peers; count peer submissions for deduplication and force immediate events, malformed replies and rejection.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.

2026-10-01: Prepare, but do not accept, the built-Electron case against a real ADE daemon/runtime and installed Codex peer: send from the production composer, capture immediate stream events before the send reply, verify ordered text/tool output and separate admission/dispatch/acceptance/completion, replay the same durable request without a second peer submission, reject conflicting payload reuse, and close/reopen a view without ending runtime ownership. Record the installed peer version and native report. This run remains pending the backend’s installed Codex 0.159 legacy-reader evidence; protocol-only capabilities are not installed-peer evidence.

2026-10-01 correction (do not accept): the changed built-Electron consumer cases used a deterministic Codex stdio fixture, not installed Codex. The prompt-composer case passed in `desktop-83ba4e50-b73a-4919-9c63-3510ddf77427`; the workspace-history case in that two-case run failed only when the test asked for the virtualized first native row while still scrolled near rows 27–31, after the native-source error and manual refresh had completed. After explicitly scrolling the Native history messages viewport to its top before checking the first refreshed row, the workspace-history case passed in `desktop-e7c0ab9d-39f3-4497-abe4-847bb4c1a025`. Its attachments include `native-and-ADE-evidence.png` and `conversation-history.png`; the composer run includes `composer-enabled.png`, `codex-output-tool-native-status.png`, `codex-native-peer-report.json`, and `codex-native-peer-script.py`.

The composer peer report identifies `scripts/fixtures/codex_mock.py` (SHA-256 `dae164da7e4c69a1fb9c9198e7d28fb55af17a95ae80df972c709dca4cdaa240`), Python 3.13.15, `target/debug/ade-daemon` (PID 81114; SHA-256 `db9bc09527daea9a521dc9421df4060a3f2e8cd6a80f8e7f706e4c1d59436986`), `target/debug/ade-runtime` (PID 81130, instance `8ca37f04-d211-46bc-92a2-08d03c3aebd0`; SHA-256 `4a855a0da8e5af9dd08945a9dd93dd737415d1a94ad9c482c12592b408f9408a`), and Electron 44.4.5 (PID 81183; SHA-256 `e06891704834df56f24489e1f971428161ae17312143624af13736255cc0ab34`). The fixture reported one `turn/start` with the durable request ID. The rendered assertions covered exposed reasoning, a failed typed tool summary with bounded output and call ID, a safe unknown item without tool/status controls, and absence of private reasoning markers. These runs do not prove installed-Codex behavior, replay/conflict acceptance, every stream-order criterion, or the full static gate. The package typecheck, 20 affected component tests, desktop build, and both changed Electron cases now pass; the failure above was confined to the original offscreen-row assertion. The previously passed held-view run `desktop-ddc49a0c-e11b-4ed6-a5cf-6e3aed3e9757` was not rerun. Keep the ticket status and acceptance checkboxes unchanged.

2026-10-01 post-fix correction (not accepted): Installed @tiptap/core 3.31.3’s shipped dist/index.js implements setEditable(editable, emitUpdate = true), and dist/index.d.ts declares the optional flag. The Composer now calls setEditable(editable, false), so readiness and lock changes do not emit synthetic updates; real content transactions still reach onUpdate. The actual-browser regression holds draft.get: with the real Editor locked and empty, it advances the controlled 250 ms debounce and verifies no draft.save and unchanged authoritative Account one text/revision 7; it then restores Account one prompt, advances another 250 ms, and verifies the same invariant. Before the source fix the focused regression went red with an unwanted save of the restored Account one prompt. A single actual contenteditable fill then produces the exact first save and revision 8; a later queued old-account edit does not mutate or write to the successor account, whose text/revision stay Account two prompt/revision 11. The corrected held-restore and account-fence case passed in browser-32a2aca6-14c2-476e-a3e4-8c96c87609e2; the actual-DOM close-and-flush case passed in browser-02a719e1-1df8-4380-95c9-a916cf1b40ea.

After pnpm --filter @ade/desktop build, the changed Composer passed one built-Electron native-peer test in desktop-330ee571-1bf5-4983-9f4b-fc5abd51e7c2. Evidence leaves: test-results/runs/desktop-330ee571-1bf5-4983-9f4b-fc5abd51e7c2/artifacts/send-the-prompt-composer-r-6f337-put-and-a-safe-unknown-item/attachments/composer-enabled-png-dc200c7cadf27421b5924f870ff91dbbf49736e5.png and test-results/runs/desktop-330ee571-1bf5-4983-9f4b-fc5abd51e7c2/artifacts/send-the-prompt-composer-r-6f337-put-and-a-safe-unknown-item/attachments/codex-output-tool-native-status-png-ffbf1ffb21525285a48293a7e286308b606e834a.png; native.json embeds codex-native-peer-report.json. It identifies scripts/fixtures/codex_mock.py (SHA-256 dae164da7e4c69a1fb9c9198e7d28fb55af17a95ae80df972c709dca4cdaa240), Python 3.13.15, target/debug/ade-daemon (PID 15943; SHA-256 db9bc09527daea9a521dc9421df4060a3f2e8cd6a80f8e7f706e4c1d59436986), target/debug/ade-runtime (PID 15959; instance af5b11b3-46cb-4082-bde1-68f1c03a8bca; SHA-256 4a855a0da8e5af9dd08945a9dd93dd737415d1a94ad9c482c12592b408f9408a), and Electron 44.4.5 (PID 16043; SHA-256 e06891704834df56f24489e1f971428161ae17312143624af13736255cc0ab34). The fixture records one correlated turn/start, request ID 4be741a8-df67-412d-bf2f-5779cae1df28; it is not installed Codex. Keep all ticket status and acceptance checkboxes unchanged; full gate remains pending.

2026-10-01 Main acceptance mapping (all seven Ticket 03 criteria accepted; Status remains ready-for-agent):
1. Durable identified send path and separate outcomes: the public composer/native-peer run desktop-330ee571-1bf5-4983-9f4b-fc5abd51e7c2 records one correlated turn/start and request ID; the SDK/CLI provider tests cover the public admission/result contract.
2. Fingerprint, same-payload replay and conflicting reuse: provider SDK/CLI replay and Rust effect-identity coverage passed in the accepted ordinary full gate.
3. Subscription/readiness and immediate output: native peer protocol coverage in the accepted provider tests passed; no timing-sleep workaround was used.
4. Ordered content, exposed reasoning, typed tool summary, bounded output and unknown-item fallback: built Electron run desktop-330ee571-1bf5-4983-9f4b-fc5abd51e7c2 passed with native report and PNG evidence above. The modern items-list representation was supplied only by the deterministic peer fixture.
5. Recoverable failure/refusal and acknowledgement-not-completion behavior: public renderer/provider tests and the built consumer case passed; the held-restore browser case browser-32a2aca6-14c2-476e-a3e4-8c96c87609e2 also verifies authoritative draft preservation until an actual edit.
6. Public worker path/shared execution and view lifetime: provider SDK/CLI coverage passed; held-view run desktop-ddc49a0c-e11b-4ed6-a5cf-6e3aed3e9757 and workspace-history run desktop-e7c0ab9d-39f3-4497-abe4-847bb4c1a025 passed.
7. Evidence and required gate: scripts/check-static.mjs report static-f3191b0e-f409-4db7-9039-6c1d34c47e3d passed all 27 stages in 94.876 s: 1,835 passed, 0 failed, 1 ignored. The sole ignored case is the intentional Rust subprocess helper store::tests::creation_interruption_child; it is not a product-test failure.

Explicit limits: installed-peer authentication and send remain UNVERIFIED for Ticket 03. Installed Codex 0.159 evidence belongs to Ticket 12’s legacy-reader slice only; it does not establish installed-peer send. The modern items-list result above is deterministic-peer evidence only. The built Electron run used scripts/fixtures/codex_mock.py, not installed Codex. No parent PC coverage, story, or index files were changed.

2026-10-02: Status set to `complete` to match the recorded acceptance above. No new verification was run.
