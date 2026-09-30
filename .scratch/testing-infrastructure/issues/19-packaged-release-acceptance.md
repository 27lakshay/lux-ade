# 19 — Verify a packaged release candidate end to end

**Type:** implementation ticket

**Status:** ready-for-agent

**Completion:** local infrastructure verified; full packaged acceptance pending eight unbuilt UI cases

**What to build:** An explicit release-candidate command verifies both protocol and desktop behavior against the same packaged application artifact.

**Blocked by:** [02 — Separate correctness, load, package and environment-dependent suites](02-suite-selection.md); [07 — Make CI run the same acceptance gates as local development](07-ci-parity.md)

## Acceptance criteria

- [x] Combine artifact-dependent protocol cases and packaged desktop acceptance behind one explicit candidate-artifact interface.
- [x] Require an existing compatible artifact and record its identity, revision/build metadata and target; missing or incompatible artifacts fail before acceptance is claimed.
- [x] Run against clean scratch state using deterministic provider fixtures and the actual candidate executables, without silently falling back to development builds.
- [ ] Verify representative protocol and desktop behavior, failure diagnostics and cleanup, including negative prerequisite cases.
- [x] Record actual candidate-run evidence and unexecuted platform requirements. Building or testing a candidate does not authorize publishing a release.
- [x] Document candidate provisioning and execution while keeping ordinary protocol discovery free of package-only cases.

## Validation and handoff

- Verify the current code before relying on the audit’s observations. Preserve existing acceptance scope and document any evidence that changes the proposed approach.
- Run `pnpm check:static` and the checks affected by this change. Validate edited tracked configuration with its own tool. Record commands, outcomes and any unexecuted proof.
- Report the result and evidence. Ticket publication does not authorize implementation, commits, pushes, workflow dispatches, remote settings or releases.

## Comments

### 2026-09-30 — Actual candidate execution

`pnpm package:mac` built a darwin-arm64 Electron 44.4.5 candidate with the actual
release daemon, runtime, control, CLI, bundled Bun and provider resources. The
builder writes a sidecar outside the app: revision, dirty source digest, build
time, target and complete content/mode/internal-link digest. It refuses changed
source during packaging. The prerequisite verifies metadata, native architecture,
required executables, internal links and content identity; the aggregate verifies
the same identity after successful acceptance. No build or development fallback
occurs in `pnpm test:candidate --app ...`.

Candidate SHA-256: `59c0853e3a9f918e44cc30adf028046a143c17ec65ab0ddb8ea5c9ac1defe6bf`,
62,461 entries. Revision `efc8ad3cc44c46632fa63e59bdd6a7cd8df94896`, dirty source
SHA-256 `befbd0417ffc148cf59701b5c1722f9a5b8ef816bb7ae80d766c060d67af6977`.
Later changes to test setup/documentation do not rewrite that build identity.
The sidecar is an identity record, not a signed provenance attestation.

The explicit partial command selecting `package-protocol` and
`package-desktop-current` passed all eleven cases with no skips or retries:
`candidate-99c0cdc1-08aa-461a-8ba3-19a63b781d59`, native tests 17.4 seconds;
aggregate stage including identity verification 20.5 seconds. It proves bundled
CLI/control cold starts, deterministic Codex/Claude execution under bundled
Bun/Node, login-shell environment, relocation, incompatible-owner preservation,
real workspace UI selection, palette interaction, retained window relaunch,
and bridge send/replay. Bridge sends do not prove an unbuilt composer UI.

The first run preserved eight passes and three failures. Two new fixtures assumed
an initial managed workspace and an incorrect palette shortcut; the retained
terminal case assumed `workspace.open` still creates a terminal. Fixtures now
open a workspace and create a terminal explicitly, click the real Search control,
and save the draft before sending. The intermediate affected run passed the shell
and terminal cases and identified the missing draft setup. No product deadline,
retry, assertion or artifact changed to make these pass. Failed reports remain.

The nine retained `package-desktop` cases in `macos.spec.ts` require profile/composer
controls the current renderer does not build. They remain discoverable and required
by the default full candidate command, and are **unexecuted** here. Their inherited
caller environment was replaced by scratch HOME and the packaged allowlist. They
are not counted as passed or silently removed. Full package/release acceptance
and this ticket remain incomplete until those product surfaces and proofs exist.

Eight focused runner/prerequisite checks passed, including missing artifacts,
missing/invalid metadata, incorrect targets/architecture, mutated contents,
changed identity, permissions, escaping links and rejected retry overrides.
Native Playwright discovery still includes all nine legacy cases plus the two
current cases and nine protocol cases. Typecheck, type-aware lint, formatting
and diff checks passed. The final static/ordinary acceptance gate remains pending.

No dependency was added. Metadata validation reuses the existing root build-tool
Ajv; hashing uses Node's standard library. Official guidance checked:
[Playwright Electron launch](https://playwright.dev/docs/api/class-electron),
[electron-builder v26 macOS](https://www.electron.build/v26/docs/mac/),
[Node 24 crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html) and
[Ajv strict mode](https://ajv.js.org/strict-mode). No additional official agent
skill or MCP was found for these integrations; repository Electron notes apply.
Signing for distribution, notarization, other targets, authenticated providers
and release publishing remain unexecuted. Nothing was published.

### Final static and ordinary acceptance

The final `pnpm test:acceptance --workers 5 --desktop-workers 2` passed all 27
static stages, 985 protocol cases (five unchanged skips) and eight desktop cases:
`acceptance-d739f308-a6e3-444e-92c2-6bcb37caa058`. Evidence is linked from
`test-results/ticket19-verification/verified.json`. The runtime audit found no
axe, Vitest/UI, Hyperfine or Bacon entries across 38,154 app.asar inventory
entries and the external candidate files. See `runtime-tool-audit.json` beside
the verification record.

The relocation case clones executables and Resources/bin while linking other
resources to the original candidate; it proves launcher/path relocation, not
an independent complete copy. Nine legacy UI cases remain unexecuted and the
full candidate command remains unproven. Ticket 19 is not marked complete.

### Legacy classification correction — 2026-09-30

Eight retained cases require the New profile/Create controls absent from the
current `provisional/OnboardingScreen.tsx`. The ninth launch-refusal case does
not require those controls, so it was executed separately instead of classified
as an unbuilt-profile case. Native evidence: `package-80ef7d54-c0ba-4c11-884c-fdc15833a475`.
It failed waiting for a window after 90 seconds and also exceeded its 90-second
worker teardown deadline. No retry, deadline increase or expected-outcome change
was applied. The run is terminal with exit 1, and a process scan found no executable
remaining at the candidate's exact main-executable path. An attempted cancellation
found the owned runner had already exited; no signal was sent to another process.

The current main startup waits for daemon-owned windows; failed managed-profile
selection publishes error state while that window startup remains pending. The
legacy test's expected rendered recovery alert is not verified by this run.
The headless incompatible-owner cases already pass, but they do not prove this
GUI refusal. The full legacy scope is now eight unexecuted cases plus one failed
case, not nine unexecuted cases. Full packaged acceptance remains incomplete.
The initial anchored name filter selected no cases and is retained as failed
selection evidence (`package-d44cbde6-e3b2-4e53-bcad-4e22df0679f1`).

### Failure cleanup regression

The legacy fixture now places launch inside its cleanup scope. On a failed
assertion/window wait it waits for termination of only its owned Electron child
instead of waiting for a graceful quit that can never finish. Successful behavior
keeps the existing graceful-close path. The incompatible owner is not signalled.

Original default execution recorded both a 90-second test timeout and a 90-second
worker teardown timeout. A five-second diagnostic invocation after the fix kept
the expected case failure but produced no worker teardown error:
`package-1f28f4e5-63bf-4129-8f79-a52c5b2afbd8`. Removing only the cleanup change
reproduced the extra worker timeout with the same diagnostic options:
`package-69b73fd5-7467-4e4d-ad48-8aeaaba8bf2e`. The fixed source was restored.
No production deadline or default package timeout changed. The short diagnostic
run tests failure cleanup; it does not accept startup behavior. Scanning the exact
candidate executable/helper paths found no surviving candidate processes.
Final static verification and restored diagnostic verification are pending below.

### Final cleanup verification

The restored cleanup diagnostic (`package-8a3ec175-7b01-4eff-affb-e4bd6fb9a195`) retained the expected failed recovery-window case and exited 1 without a worker teardown error. No candidate executable or helper survived. This verifies cleanup only; packaged recovery behavior remains failed. The final static gate (`static-1c426dee-d7c6-4aa4-9397-d2972cfbcb71`) passed all 27 stages in 60.181 seconds. The earlier complete ordinary acceptance remains valid; its suites were not rerun for this legacy fixture-only cleanup change.


### 2026-09-30 — Recovery behavior verified on the rebuilt candidate

The renderer now projects main’s existing profile error through a Zustand store.
The recovery screen hides the mounted workspace while showing the original error
and guidance. A pushed state wins over a delayed initial read. Successful recovery
restores the workspace. This adds no package or process ownership change.

The original incompatible-owner assertions pass in
`package-cb3f19ea-0059-4800-a612-5d6f3bdcffea`: recovery alert, a live owner,
unchanged registry and a subsequent incompatible hello. The fixture uses the shared
hidden-window environment and stops only its owned Electron child. Graceful quit
hung even after every assertion passed; no assertion, retry or product deadline
was relaxed. Earlier failed evidence remains in the run directories.

The same candidate passes all eleven current cases in
`candidate-d5cb60a4-ff53-4cbb-b80f-fc2fee63ffed`, with no skips or retries.
Candidate SHA-256: `ed9e6d860829e4b93f9505a6fb9b977c319c6bd8e260d8695ea6e096f0aa39d5`;
revision `d08d46461903b814e30ab57de1e173f28ed9e456`, dirty source SHA-256
`f9bb0be6b4b03c54d85806bb45410c5fea973ed76962b8e2473a4af7f7b4210b`.
The four focused browser checks pass in
`browser-7cef146e-4b55-432e-bf93-9def1fb2c6eb`, including workspace visibility.
Earlier removal of recovery rendering made both recovery tests fail; restoring
it passed. These are correctness checks, not performance benchmarks.

This supersedes the earlier failed launch-refusal classification. Twelve packaged
cases are verified across two selections against the same artifact. Eight legacy
profile/composer UI cases remain required and unexecuted. Ticket 19 stays incomplete.

The native `capturePage` image confirms the recovery screen is fully visible with
no workspace sidebars painted over it. The image is retained at
`test-results/ticket19-recovery.png`.

Keyboard activation of Back to workspace leaves the recovery alert visible while
the profile error persists. The ordinary desktop suite passes all eight cases in
`desktop-ec21c68e-b773-49ed-aa46-01c70c30baef`. After packaging, the static gate
required replacing two raw paragraphs with ADE’s `Body` component. The packaged
evidence above describes the artifact before that typography-only correction;
final-source browser checks are included in the static gate.

Final source passes all 27 static stages in `static-40b11402-72a1-4e6b-87ce-0db92f69973b`, including all
315 browser tests. The first static attempt rejected raw paragraphs; the corrected
run passes without suppressions. No full protocol benchmark was repeated.
