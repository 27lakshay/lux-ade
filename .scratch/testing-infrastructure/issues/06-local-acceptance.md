# 06 — Provide one complete local acceptance command

**Type:** implementation ticket

**Status:** ready-for-agent

**Completion:** complete (verified 2026-09-29)

**What to build:** Contributors run the complete required checks locally with one command and shared immutable build prerequisites executed once.

**Blocked by:** [01 — Include every deterministic provider suite in the static gate](01-provider-gate.md); [02 — Separate correctness, load, package and environment-dependent suites](02-suite-selection.md); [03 — Detect tests that belong to no gate](03-discovery-validation.md); [04 — Produce trustworthy test reports and fixture timings](04-reports-and-fixture-timings.md)

## Acceptance criteria

- [x] Provide `pnpm test:acceptance` covering the complete static gate, protocol correctness and built desktop E2E through the established suite definitions.
- [x] Preserve formatting, contracts, parity, boundaries, types, lint, dead-code checks, providers, browser tests, Rust checks, doctests and retained Python/native checks wherever the existing gates require them.
- [x] Resolve SDK, CLI, backend and desktop prerequisites once per dependency path, removing duplicate SDK builds while keeping standalone commands usable.
- [x] Do not rerun a fault subset already covered by the full protocol run. Reuse immutable outputs only; preserve test-scoped mutable state.
- [x] Propagate failures, arguments, signals and cleanup. A failed build or missing required report prevents a success summary.
- [x] Run and document the complete aggregate, including prerequisite and intentional-failure verification where wrapper behavior changes.

## Validation and handoff

- Verify the current code before relying on the audit’s observations. Preserve existing acceptance scope and document any evidence that changes the proposed approach.
- Run `pnpm check:static` and the checks affected by this change. Validate edited tracked configuration with its own tool. Record commands, outcomes and any unexecuted proof.
- Report the result and evidence. Ticket publication does not authorize implementation, commits, pushes, workflow dispatches, remote settings or releases.

## Comments

### 2026-09-29 — Aggregate implemented; full execution pending

- Added `pnpm test:acceptance`: static gate, backend binaries, full protocol correctness, then built desktop. The fault subset is not repeated. `--list` shows the actual stage commands; worker controls are accepted and coverage-narrowing filters are rejected.
- The static gate builds SDK declarations once before typecheck, then directly builds CLI and desktop consumers. Standalone build/E2E commands remain usable. Rust doctests from the older shell gate are retained explicitly; the current crates contain zero executable doctests.
- Child summaries are required and validated after successful exits. Missing/incomplete static stages, failed/unexecuted cases and absent reports fail the aggregate. Existing stage runner behavior propagates cancellation and leaves later work pending. Two regression tests cover filter rejection and invalid child evidence after a zero command exit.
- `pnpm check:static` passed after the changes with Hyperfine temporarily unavailable; the optional binary was restored afterward. Formatting, lint, types, ownership discovery, providers, browser, Python/native, Rust and doctest commands passed. Full aggregate execution and prerequisite evidence remain pending.

### 2026-09-29 — Complete aggregate verified

- `pnpm test:acceptance --workers 5 --desktop-workers 2` passed in 584.7 s: static 59.3 s, backend build 0.1 s, protocol 517.6 s, desktop 7.7 s. This is one observed run, not a speedup claim.
- Native evidence: 272 JavaScript, 107 provider, 310 browser, 37 Python and 862 Rust cases passed, plus native accessibility and all static tools. One intentional Rust helper was skipped. Rust doctests executed successfully with zero current examples. Protocol passed 977 cases with five existing skips and no unexecuted cases; desktop passed all seven cases.
- Inspected the aggregate and all child summaries in `test-results/runs/acceptance-640fee55-67fd-4eef-8a96-fa03db3f87cf`. All 24 static stages passed. The manifest confirms exactly one SDK build, then CLI and desktop builds, with backend binaries built before E2E. The full protocol selection covers the fault subset without a second invocation.
- Invalid child evidence after a successful command is rejected by the aggregate regression test. Filter/worker validation, the existing stage interruption and missing-report tests, and full native discovery all pass. No commits or remote actions.
