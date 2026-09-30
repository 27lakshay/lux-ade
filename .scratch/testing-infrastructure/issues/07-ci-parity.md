# 07 — Make CI run the same acceptance gates as local development

**Type:** implementation ticket

**Status:** ready-for-agent

**What to build:** Required CI jobs enforce the same application and retained legacy coverage as local acceptance and retain useful evidence when they fail.

**Blocked by:** [06 — Provide one complete local acceptance command](06-local-acceptance.md)

## Acceptance criteria

- [x] Map local suite definitions into JavaScript/static, Rust/native, protocol and desktop jobs; retain doctests and dependency/license checks.
- [ ] Start with supported macOS execution; move checks to Linux only after proving their portability. A fresh runner provisions its tools, browsers and native dependencies without live-provider credentials.
- [x] Transfer immutable builds only across compatible jobs for the same source revision and material build inputs. Do not reuse profiles or test data.
- [x] Add bounded timeouts, cancellation of superseded PR runs and failure artifact uploads. Missing reports or skipped required jobs cannot yield aggregate success.
- [x] Validate workflow configuration and demonstrate that representative provider, browser, protocol and desktop failures fail their corresponding jobs.
- [ ] Record a hosted complete run after separately authorized push or dispatch. Until then, mark hosted proof pending and continue independent local work.
- [x] Document required branch-protection check names without changing remote settings.

## Validation and handoff

- Verify the current code before relying on the audit’s observations. Preserve existing acceptance scope and document any evidence that changes the proposed approach.
- Run `pnpm check:static` and the checks affected by this change. Validate edited tracked configuration with its own tool. Record commands, outcomes and any unexecuted proof.
- Report the result and evidence. Ticket publication does not authorize implementation, commits, pushes, workflow dispatches, remote settings or releases.

## Comments


### 2026-09-29 — Local CI implementation and validation in progress

Added shared static-stage grouping, compatible build archives, dependency reporting,
downloaded-evidence validation and the `Checks` workflow. Actionlint 1.7.12 validates
the workflow. Seven archive tests pass; the CI Node checks include actual symlink CLI
execution and downloaded native reports that are empty, missing or contain retries.
The symlink regression reproduced exit zero without validation before the entry guard fix.
Native E2E reports must now agree with their summaries before aggregate success.

Provisioned pinned cargo-deny 0.20.2. The dependency wrapper initially reported the
missing tool, then the missing Cargo search path; it now uses the static gate's Rust
search paths. The real check passed advisories, bans and sources. Existing policy does
not enable license enforcement; no allowlist or remote policy was changed.

Migrated unique `test_diagnostic_correlation.py` assertions into the current protocol
fixtures in `ops/diagnostic-correlation.spec.ts`, including the CLI export. Retained the
historical source and updated its explicit exclusion reason. Initial use of `hold` as a
redaction sentinel collided with ordinary diagnostic prose; the test now sends a unique
private prompt and waits for completion, matching the original behavior.

Still pending: final static gate, actual static-group executions and compatible build
round-trip, representative CI runner failure probes, and hosted provisioning/execution.
Hosted proof requires separately authorized push or dispatch. The documented protection
check is `Acceptance` in `Checks`; confirm its hosted identity before changing settings.

`pnpm check:static` passed all 25 stages in `static-dcfb59df-5143-46b0-af0b-836e3853e26d`. CLI diagnostic correlation passed in `protocol-5be2aea0-8947-4eb1-90e9-95755f5608b5`. Workflow actionlint and all eight CI Node regressions passed.

### 2026-09-29 — Local execution and artifact proof

Both actual static job groups passed: JavaScript 19 stages in 31.87 seconds and native
six stages in 27.58 seconds. These are single local validation runs, not hosted timings
or a performance comparison. Reports: `test-results/ci-local/{javascript,native}`.

The real artifact CLI packed the builds, then restored them after every declared output
was moved aside. All 125 JavaScript files and three native binaries matched their hashes
and executable modes. Changing RUSTFLAGS made restore fail before replacement. The
identity also records compiler/SDK, backend build command and selected native build
variables. Evidence and retained original outputs:
`test-results/ci-build-roundtrip-4d23b320-59b1-4af9-a6da-c365f4dba0dd/evidence.json`.
Using the restored outputs, 20 protocol cases passed in
`protocol-d12defd8-b6c8-4e23-b73d-0fde3c4a0468` and all seven desktop cases passed in
`desktop-5141d862-afe8-4d3e-9ba4-07d9c4b4a8c8`.

Temporary behavioral failures were injected and removed from each runner. The complete
JavaScript group failed specifically at provider tests, then in a separate run at browser
tests. Focused protocol and Electron executions failed their intentional assertions using
real scratch fixtures. Every command exited nonzero and retained a failed native summary.
Evidence: `test-results/ci-failure-probes/evidence.json`. No failing probe remains.

The real aggregate CLI accepted copies of actual successful reports in
`test-results/ci-download-simulation`; only local static report-root strings were normalized
to the workflow path convention. This checks download-layout handling, not hosted execution
or a new complete run on identical source. Empty/missing/retried native evidence is rejected
by regression tests. Fresh hosted provisioning, GitHub artifact transport, timeout/cancellation
behavior and the hosted complete run remain unverified until separately authorized execution.

Final local gate after removing every failure probe and extending build identity: `pnpm check:static` passed all 25 stages in `static-1e1f0eb7-dfe1-4633-b83b-d9dd4127a81a` (60.53 seconds). `git diff --check` and Actionlint also passed. Local implementation and checks are complete; ticket completion remains pending hosted evidence.

User decision: keep working locally and leave hosted proof pending. No commit, push or workflow dispatch is authorized. Continue independent tickets; ticket 07 remains incomplete until hosted proof is available.

### Local criteria reconciliation — 2026-09-30

The current workflow defines separate JavaScript/static, native/Rust, protocol, desktop and dependency jobs, followed by an always-run Acceptance job. It retains doctests and the existing dependency policy. Each worker job has a 45-minute timeout, Acceptance has ten minutes, superseded PR runs cancel, and evidence uploads run with always(). Existing native-evidence regressions reject skipped jobs and missing reports. The implementation criteria are checked against this configuration and the recorded local probes; actual hosted timeout, cancellation, provisioning and transport behavior remain unverified. The user authorized a local commit and merge; the earlier no-commit instruction is superseded for that merge. Push and workflow dispatch remain unauthorized.
