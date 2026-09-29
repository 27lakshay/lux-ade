# 04 — Produce trustworthy test reports and fixture timings

**Type:** implementation ticket

**Status:** ready-for-agent

**Completion:** complete (verified 2026-09-29)

**What to build:** Every suite run yields inspectable native results and a concise summary that separates execution costs and makes missing evidence visible.

**Blocked by:** [02 — Separate correctness, load, package and environment-dependent suites](02-suite-selection.md)

## Acceptance criteria

- [x] Retain runner-supported JSON/JUnit and per-test durations in unique ignored run directories; add only a small adapter for a common summary.
- [x] Record revision, dirty state, OS/architecture, tool versions, command/selection, workers, cache condition and observable build/setup/test/cleanup durations. Distinguish wall time from summed test time and unavailable values from zero.
- [x] Instrument protocol repository creation, profile startup, test use and shutdown/process-ledger cleanup without weakening isolation or cleanup failures.
- [x] Summarize successful, failed, interrupted and prerequisite-missing runs truthfully. Distinguish known gaps, capability skips and intentional helper tests.
- [x] Retain bounded diagnostic logs and cleanup errors; prevent missing required reports from producing aggregate success.
- [x] Test adapter handling of missing reports, duplicate records, failures, interrupted runs and shard merges.

## Validation and handoff

- Verify the current code before relying on the audit’s observations. Preserve existing acceptance scope and document any evidence that changes the proposed approach.
- Run `pnpm check:static` and the checks affected by this change. Validate edited tracked configuration with its own tool. Record commands, outcomes and any unexecuted proof.
- Report the result and evidence. Ticket publication does not authorize implementation, commits, pushes, workflow dispatches, remote settings or releases.

## Comments

### 2026-09-29 — Playwright reporting and protocol timing; ticket remains incomplete

- Added per-run native Playwright JSON, metadata and normalized summaries to all seven Playwright configs. Workers inherit the run ID to keep their artifacts in the same directory. A regression test covers configuration reload across a child process.
- The pure adapter rejects missing/unexecuted evidence, failed runs, duplicate records and retries; merging validates expected shard presence, duplicates and failures. Six regression tests pass.
- Instrumented repository creation, profile startup, fixture use, shutdown, ledger cleanup and teardown. Timing records explicitly identify overlap and remain attached on failure. Diagnostic reads are bounded to the last 1 MiB per log rather than reading the entire file before truncation.
- Verified real-process success, deliberate assertion failure, handled SIGINT and missing-package prerequisites. Each produced native results and the expected summary status; failed diagnostics and timings were retained. Temporary probe specs were removed. Verified failed attachments share the summary’s directory after correcting worker run-ID propagation.
- Remaining work: native reports and common summaries for static stages, Node/provider, Vitest, Python and nextest execution; durable interrupted aggregate state and required-report validation across the full gate. This ticket is not complete from Playwright evidence alone.
- `pnpm check:static` passed after the reporting changes: 264 JavaScript tests, 107 provider tests, 310 browser tests, retained Python/native checks, discovery and 862 Rust tests (one intentional helper skip). `git diff --check` passed. No commits or remote actions.

### 2026-09-29 — Static and standalone reports integrated; verified complete

- Static execution now writes an atomic stage manifest before starting work, then records native results, commands, durations, cache description, machine and available tool versions. Failed/interrupted runs preserve finished stages and leave later stages pending. Missing required native reports fail even after a zero process exit.
- Node and providers retain native JUnit; Vitest retains native JSON; Python unittest lifecycle callbacks retain case results and durations. The standard-library XML/JSON adapter rejects absent, malformed, duplicate, failed and retry evidence. Native AppKit/static-tool outcomes retain command results and logs without invented test counts.
- Standalone provider and browser package commands retain their own reports. All stage logs are bounded to 1 MiB. A real 2 MiB output probe verified the retained bound. Shared signal/process cleanup behavior remains covered by runner tests.
- nextest writes JUnit directly into each run directory using a generated copy of the checked-in configuration, with ignored-test reporting enabled. Native execution validated that configuration. Discovery evidence labels the intentional subprocess helper separately. No shared JUnit output is copied as proof of a run.
- Adapter and stage tests cover native failure/skip outcomes, missing reports, duplicate records, empty reports, setup errors, retries, interrupted manifests, expected shard membership and duplicate shard tests. Earlier real Playwright success/failure/interruption/prerequisite probes remain applicable.
- Final `pnpm check:static` passed: 266 JavaScript tests, 107 provider tests, 310 browser tests, 34 Python unittest cases plus native accessibility, discovery and 862 Rust tests (one intentional helper skipped). Inspected the completed manifest, every required native artifact, adapter outcomes and log sizes. Syntax checks and `git diff --check` passed.
- Worker counts not exposed by a runner are explicitly null; test sums stay separate from wall duration. Protocol phase overlap is documented. Hard termination before final reporting remains incomplete evidence. No repeated speedup claim, commits or remote actions.

### Review follow-up: reject runs without executed coverage

Native summaries now fail when no cases passed, including all-skipped JUnit, Vitest and unittest reports. Node passing file records from unmatched name filters count as skipped file records instead of executed test cases. Mixed matching cases and unmatched files remain successful. Nine adapter tests passed; removing only the implementation reproduced the behavioral failures, and restoring it passed again. The real Claude provider command with an unmatched name filter exited 1 with zero passes; a matching filter exited 0 with one passed case and two unmatched file records. No test retries, runner migrations or performance measurements were added.

Merge preparation validation: `pnpm check:static` passed all 27 stages in 70.104 seconds (`static-41665fef-9039-49aa-92d0-c9c2251edeaa`). `git diff --check` passed. Hosted and legacy packaged proof retain their existing pending status.
