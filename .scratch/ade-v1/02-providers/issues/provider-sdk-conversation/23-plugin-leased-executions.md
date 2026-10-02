# 23 — Preserve active work across plugin lifecycle changes

Status: complete
Type: implementation ticket

**Parent:** [TypeScript provider SDK and conversation UI](../../provider-sdk-conversation-ui.md)

**What to build:** Update, disable or clean up provider plugins without replacing active leased execution code or removing a successor’s registrations.

**Blocked by:** [03 — Send and stream a Codex turn through the public SDK](03-codex-public-send.md)

**Spec coverage:** PC02, PC21, PC28, PC36. This ticket contributes the behavior described below; shared rows require the other contributors in the [acceptance coverage](README.md#acceptance-coverage).

## Acceptance criteria

- [x] Pin artifact, activation, wire, extension and native data/resume versions separately and expose relevant identity through public inspection.
- [x] A compatible update leaves active executions leased to the old artifact and starts new work with the new artifact; lease cleanup cannot unregister the successor.
- [x] Bound shutdown and registration cleanup and fence late callbacks. Author callbacks do not run inside registry locks or storage transactions.
- [x] Reject incompatible active data/contract combinations before use or require an explicit truthful drain. D19 allows no legacy aliases, dual protocol or development-schema migration shim.
- [x] Disable and view detach disclose consequences separately; retained core history stays readable and native work is preserved or stopped only under declared lifecycle policy.
- [x] Record commands, native reports, observable outcomes and explicit failed, skipped or prerequisite-blocked coverage. Pass the required static gate and this slice’s real-process/built-desktop acceptance before claiming completion.

## Testing decisions

Update/disable real installed workers during active turns and pending callbacks; compare artifacts and outcomes in public APIs and built desktop, including rejected breaking changes.

Read the [shared delivery rules](README.md#delivery-rules) before implementation. Extend reusable fixtures and conformance support as this slice lands; later evidence tickets do not replace its acceptance.

## Comments

2026-09-30: Published as part of the user-approved 32-ticket breakdown. Implementation and acceptance remain unverified.

2026-10-02: Implementation and acceptance (decisions taken under the user's standing instruction to decide unattended).

What existed: activation generations pinned to artifact version and digest, data schema checks, provider sessions leasing the generation they started on through updates and dev reloads, bounded drain with `outcome_unknown` for calls cut off, and late-cleanup fencing (`reliability-c/plugin-update.spec.ts`, `plugin-dev/*`, `plugins/*`, `adapters/plugin-providers.spec.ts`).

Fix (found by a delegated investigation, reviewed and applied here):
- Every `plugin.*` operation held the global `plugin_lifecycle` lock for its whole duration, including command invocations (up to 60 s), host restarts and host status (lock introduced with the theming commit d49f46af). One slow or frozen host blocked every other plugin operation and the theme sync, so a frozen host's status call hung, drains and reloads could not observe generations, and the daemon missed `runtime.prepare_restart`. Only operations that change the installed or enabled set now hold the lock, through their own theme sync; a host restart takes it only around its theme sync; invocations and status take none. This fixed seven specs that also fail on HEAD: `devplug/plugin-recovery.spec.ts` :119 and :162, `plugin-dev/drain.spec.ts` :19, :94, :139, `plugins/dev-reload.spec.ts` :44, `reliability-c/plugin-update.spec.ts` :180.
- `reliability-c/plugin-update.spec.ts:69` edited the fixture worker by text that no longer matched (the fixture now names the submission on its events); the edit was updated.
- `adapters/plugin-provider-registry.spec.ts:151` still expected the pre-ticket-02 readiness shape; ticket 02 routes plugin readiness through the installed worker (`worker.initialize` passed, native work skipped, pinned version). The expectations were updated to that full shape; a disabled plugin reports `missing_executable`.

Desktop (provisional): Settings → "Plugins" lists each plugin with its status, current generation and data schema, and each generation's version, artifact digest prefix, state and leasing provider sessions. "Disable…" first discloses what disabling does: the host, commands and registrations stop; leased provider sessions keep running on their version until they end; retained history stays readable. The section separately states that closing a conversation view only detaches the view and stops nothing.

Evidence:
- `pnpm check:static`: passed (`test-results/runs/static-a136d052-7ba7-4ed9-b25a-12843c801c1b`).
- Real processes: plugins, plugin-dev, devplug, reliability-c and adapters directories 272/272 (`test-results/runs/protocol-35ebabb7-d713-4b18-b9fb-a593e752598c`); the seven fixed specs 27/27 over three runs in the investigation.
- Built Electron: `e2e/desktop/plugins.spec.ts` (`test-results/runs/desktop-68585b48-d39e-4a37-9ddb-703ebd04880b`), screenshot `plugin-disable.png`.

Known and left: `uninstall_plugin` holds the session-state lock while a host stops (bounded by the deactivate limit, 5 s in production). No test fails on it.
