# 10 — Pilot Bacon for Rust feedback

**Type:** implementation ticket

**Status:** ready-for-agent

**Completion:** complete (verified 2026-09-29)

**What to build:** Rust contributors can use an optional focused watcher when it measurably or practically improves their edit/check loop.

**Blocked by:** [08 — Add focused test selection with an explanation mode](08-affected-selection.md)

## Acceptance criteria

- [x] Pin and document the tested optional Bacon version through existing provisioning conventions; do not require it in CI or production.
- [x] Provide focused check, Clippy and nextest jobs through the existing Cargo wrapper, preserving feature flags, tool paths and cache behavior.
- [x] Document a crate/filter example and an explicit full-run command; avoid continuous complete protocol acceptance.
- [x] Verify source changes trigger the intended work, diagnostics remain readable, generated outputs do not loop and cancellation leaves no child job running.
- [x] Record a keep/remove decision from actual use. If rejected, remove trial configuration and preserve usable focused Cargo/nextest instructions.
- [x] Document stopping the watcher before benchmarks and validate retained configuration with its native tool.

## Validation and handoff

- Verify the current code before relying on the audit’s observations. Preserve existing acceptance scope and document any evidence that changes the proposed approach.
- Before integrating a tool or dependency, check current official documentation and available agent guidance; pin compatible versions through the existing package manager or tool installer.
- Run `pnpm check:static` and the checks affected by this change. Validate edited tracked configuration with its own tool. Record commands, outcomes and any unexecuted proof.
- Report the result and evidence. Ticket publication does not authorize implementation, commits, pushes, workflow dispatches, remote settings or releases.


## Comments

### 2026-09-29 — Keep the optional Bacon watcher

Decision: keep Bacon 3.26.0 as an optional local tool for automatic focused reruns and readable
diagnostics. No compilation-speed improvement is claimed. The release archive and checksums
were checked against the official release; official configuration/analyzer guidance and the
previously inspected upstream tree supplied no separate agent skill or AGENTS/llms file.

The existing installer now supports selecting a declared ZIP member. The same verified Bacon
ZIP contains Darwin and Linux binaries; only the declared platform member is copied. Two new
archive tests verify platform selection and refusal of absent, directory, symlink and parent-path
members. All five installer tests pass. Default provisioning still lists only cargo-nextest and
cargo-deny, so Bacon is absent from ordinary acceptance prerequisites and production packages.

`.config/bacon.toml` defines check-core, clippy-core, test-core and check-runtime. Every job uses
`scripts/cargo.mjs`; runtime explicitly enables native-terminal and nextest uses the zero-retry
CI profile. `pnpm test:rust:watch` supplies the static gate's tool paths and existing process-group
cancellation. Core jobs watch core sources/manifests; runtime adds its platform/native inputs.
No protocol acceptance job is watched. The README documents focused filters and explicit full
acceptance, and tells contributors to stop watchers before benchmarks.

Actual-use evidence in `test-results/ticket10-bacon`:

- A temporary core compile error produced its source location after 3.12 seconds. Restoring
  the source returned the job to green; the complete edit/restore cycle took 6.57 seconds.
  An ignored target output did not trigger another job (`watch-evidence.json`, `watch.log`).
- Cancellation during an active fresh runtime compile returned 130 through the wrapper.
  The observed process tree included the compiler, and no observed descendant remained
  (`cancel-evidence.json`, `cancel.log`). This validates cancellation, not a completed runtime check.
- In the actual terminal UI, core Clippy completed successfully (17.88 seconds including its
  local build work). Pressing `t` switched to nextest: all 183 core cases passed in 13.124 seconds
  of reported test time. Pressing `q` exited normally. These are single diagnostic observations.
- The documented `-- -E 'test(contract::devices)'` filter ran three tests, all passing, and excluded
  180 others (`filtered-nextest.log`). Its watcher was stopped; no test retries were introduced.
- `pnpm test:rust:watch --list-jobs` validates the project configuration. The initial full static
  gate found TOML formatting; oxfmt fixed it and Bacon revalidated it. Final static proof is pending.

All temporary Rust changes were restored. A temporary CLI experiment with only an on_success
job override failed because Bacon replaces the whole job; the documented command uses the
normal watcher and explicit cancellation instead. No global preferences were created or edited.

Final validation: `pnpm check:static` passed all 25 stages in `static-f4c57361-36f1-4dcc-88ae-b8ab65a57eb6` (89.36 seconds). The runtime watcher also completed a full native-terminal check successfully (`test-results/ticket10-bacon/runtime-check.log`, 25.35 seconds including local build work), then stopped through its wrapper. No watcher remains. Ticket 10 is complete.
