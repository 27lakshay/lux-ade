# 01 — Include every deterministic provider suite in the static gate

**Type:** implementation ticket

**Status:** ready-for-agent

**Completion:** complete (verified 2026-09-29)

**What to build:** Contributors can run all deterministic provider adapter tests through one command, and the complete static gate enforces that same coverage.

**Blocked by:** None — can start immediately

## Acceptance criteria

- [x] Provide `pnpm test:providers` and include it in `pnpm check:static`; preserve each provider’s required Node or Bun runner and pnpm package management.
- [x] Verify current discovery and include Claude task and subagent cases as well as bridge cases; inventory the provider files previously omitted by the gate without freezing their count.
- [x] Clear inherited live-provider opt-in flags for deterministic execution. Installed-binary and credential-dependent cases remain explicitly separate.
- [x] Verify filter/argument forwarding, nonzero failure propagation and cancellation with cleanup; a provider failure must fail the aggregate gate.
- [x] Document the deterministic command and verify it with provider fixtures without live credentials.

## Validation and handoff

- Verify the current code before relying on the audit’s observations. Preserve existing acceptance scope and document any evidence that changes the proposed approach.
- Run `pnpm check:static` and the checks affected by this change. Validate edited tracked configuration with its own tool. Record commands, outcomes and any unexecuted proof.
- Report the result and evidence. Ticket publication does not authorize implementation, commits, pushes, workflow dispatches, remote settings or releases.

## Comments

### 2026-09-29 — Implemented and verified

- Added the shared deterministic provider command to the static gate and routed Claude/OMP package test commands through it. Current discovery selects 17 files: three Claude, five opencode and nine OMP. Four live/installed-provider files remain excluded. Counts record this run; selection is dynamic.
- Verified 20 Claude, 50 opencode and 37 OMP tests passed. The provider stage took 2.6 seconds in the full gate; this is a single observation, not a repeated benchmark or speedup claim.
- Five runner tests passed, covering external-file exclusions, exact name-filter arguments, invalid requests, inherited opt-ins, failed/missing runners, cancellation of descendants and listener cleanup.
- Package-level Claude and OMP filtered invocations passed. Discovery with all four external opt-ins set still selected deterministic files only.
- `pnpm check:static` passed: 251 JavaScript harness/core tests, all 107 provider tests, 310 browser tests and 862 Rust tests, with one intentional Rust helper skip. `node --check` and `git diff --check` passed.
- Contributor guidance documents runtime requirements, selection, filtering and cancellation. No dependencies were added, and no changes were committed.
- Status remains the configured triage label; Completion records execution separately because the standard triage vocabulary has no completed label.
