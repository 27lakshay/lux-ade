# 02 — Separate correctness, load, package and environment-dependent suites

**Type:** implementation ticket

**Status:** ready-for-agent

**Completion:** complete (verified 2026-09-29)

**What to build:** Each test command selects a clear class of evidence, so ordinary correctness cannot accidentally run load, packaged-artifact or live workloads.

**Blocked by:** None — can start immediately

## Acceptance criteria

- [x] Use small shared suite definitions and runner-native discovery for protocol correctness, fault subsets, desktop, performance, package and live/system execution.
- [x] Both normal protocol entry points exclude load and package-dependent cases. Preserve the fault coverage mapping and intentional subset relationship.
- [x] Provide explicit entry points for the separated suites; package/live/system commands report unmet prerequisites as failures when explicitly requested, without exposing credentials.
- [x] Verify suite membership through discovery, including intentional overlaps. Do not parse test bodies or hardcode case totals.
- [x] Preserve correctness retries at zero, scratch profiles and process cleanup. Verify arguments, failures and signals reach the underlying runner.
- [x] Update command guidance to explain changed discovery and distinguish optional environments from missing correctness coverage.

## Validation and handoff

- Verify the current code before relying on the audit’s observations. Preserve existing acceptance scope and document any evidence that changes the proposed approach.
- Run `pnpm check:static` and the checks affected by this change. Validate edited tracked configuration with its own tool. Record commands, outcomes and any unexecuted proof.
- Report the result and evidence. Ticket publication does not authorize implementation, commits, pushes, workflow dispatches, remote settings or releases.

## Comments

### 2026-09-29 — Implemented and verified

- Shared Playwright definitions now select correctness, desktop, load, system, packaged protocol/desktop and live cases. Existing commands invoke Playwright directly, retaining native filter, signal and exit behavior. Added `pnpm test:performance` and `pnpm test:e2e:system`.
- Native discovery recorded 981 protocol correctness cases, 638 fault-subset cases, one load case, one system case and 18 packaged cases across two projects. These are observed counts, not hardcoded acceptance totals.
- The full-volume fault case moved into the serial system suite; its existing fault-map reference remains and the fault-map verifier checks system discovery separately. Ordinary correctness excludes system and load tags and packaged files regardless of inherited opt-ins.
- Package preflight requires executable bundle prerequisites. Live and system preflight require explicit opt-in; the Python live probe also rejects missing opt-in. Listing remains available without running global setup. Package protocol cases fail directly invoked runs with a missing artifact instead of skipping.
- Two regression tests passed using native Playwright discovery and negative prerequisite execution. They verify the fault subset, nonempty selections, serial load/system defaults, zero retries and nonzero prerequisite failures.
- Real-process focused acceptance: `pnpm test:e2e:protocol:only boot load/fault-classes.spec.ts --workers=2` passed 17 tests in 23.7 seconds, with two pre-existing explicit coverage gaps skipped. The name filter also selected remote bootstrap cases. No full-suite speedup is claimed.
- `pnpm check:static` passed: 253 JavaScript tests, 107 deterministic provider tests, 310 browser tests and 862 Rust tests, with one intentional Rust helper skip. Python compilation and `git diff --check` passed.
- No live provider, system-volume or actual packaged candidate execution was performed for this selection ticket. Their execution evidence belongs to tickets 18–20; prerequisite rejection is not acceptance of those environments. No commits or remote actions.
