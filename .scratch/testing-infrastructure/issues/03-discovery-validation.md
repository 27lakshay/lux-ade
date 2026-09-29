# 03 — Detect tests that belong to no gate

**Type:** implementation ticket

**Status:** ready-for-agent

**Completion:** complete (verified 2026-09-29)

**What to build:** A maintained test cannot silently fall outside acceptance when it is added, moved or excluded.

**Blocked by:** [01 — Include every deterministic provider suite in the static gate](01-provider-gate.md); [02 — Separate correctness, load, package and environment-dependent suites](02-suite-selection.md)

## Acceptance criteria

- [x] Inventory JavaScript, Rust, Python, browser, protocol, desktop, package, live, system and performance entry points against the code. Classify historical checks by actual behavior and preserve unique coverage.
- [x] Assign every maintained test file to a named suite or a reasoned historical exclusion, using the shared suite definitions.
- [x] Add discovery validation to the static gate. Detect unassigned files, conflicting ownership, stale exclusion patterns and empty required suites.
- [x] Use runner-native discovery, including nextest for Rust, and explicit standalone Python entry points. Permit documented fault-subset overlap.
- [x] Test the validator itself with a new unassigned test, missing file, stale exclusion, empty suite, conflicting ownership and legitimate overlap.
- [x] Document ownership rules so adding a new maintained test has a verifiable path into acceptance.

## Validation and handoff

- Verify the current code before relying on the audit’s observations. Preserve existing acceptance scope and document any evidence that changes the proposed approach.
- Run `pnpm check:static` and the checks affected by this change. Validate edited tracked configuration with its own tool. Record commands, outcomes and any unexecuted proof.
- Report the result and evidence. Ticket publication does not authorize implementation, commits, pushes, workflow dispatches, remote settings or releases.

## Comments

### 2026-09-29 — Inventory and validator foundation; ticket remains incomplete

- Rechecked the actual old shell gate and current static gate. The old gate alone enforced Python bootstrap (23 tests), build identity (2), first launch (4), and the macOS native accessibility harness. Ran all four successfully and added their existing entry points to the current static gate; no unique legacy check was removed.
- Collected runner-native Vitest file discovery (real browser configuration) and nextest JSON enumeration with the native-terminal feature. These will supply ownership data; no Rust or JavaScript test-body parser is needed.
- Added a pure ownership validator and five regression tests covering unassigned files, missing files, empty required suites, stale/reasonless/conflicting exclusions, documented subset overlaps, stale overlaps and duplicate suite definitions. The validator is not yet wired to the full repository inventory.
- Remaining work: classify all other Python compatibility/live/performance entry points against their implementations, connect native discoveries and independent file inventory to the validator, add the completed discovery command to the static gate, and document suite ownership. Do not count this ticket complete from the helper tests alone.
- Validation after these changes: `pnpm check:static` passed, including the newly retained Python/native checks, 258 JavaScript tests, 107 provider tests, 310 browser tests and 862 Rust tests (one intentional helper skipped). `git diff --check` passed. No commits or remote actions.

### 2026-09-29 — Discovery integrated and verified

- Added `pnpm test:discovery` and its JSON inventory mode to the static gate. Node patterns and Python static entry points are shared with actual execution; provider selection calls the provider runner’s discovery. Vitest and all seven Playwright configs supply native file lists. nextest supplies compiled Rust test/binary enumeration with native-terminal enabled.
- Inventory includes tracked and untracked nonignored test files, with exact historical exclusions. Explicit installed/live provider entry points remain separate suites. Rust inline/module registration stays with Cargo; no test-body parser was introduced.
- Documented 18 historical Python files with per-file implementation assumptions. Their source and assertions remain preserved; no current coverage equivalence or deletion is claimed. Retained Python/native static checks continue to execute.
- Verified a real temporary untracked `.test.ts` outside runner selection caused `pnpm test:discovery` to fail with its path, then removed the probe. Ownership regression tests cover stale and reasonless exclusions, duplicate/conflicting owners, missing files, empty required suites and legitimate/stale overlap rules.
- `pnpm check:static` passed, including 258 JavaScript tests, 107 provider tests, 310 browser tests, retained Python/native checks, native discovery and 862 Rust tests (one intentional helper skip). Discovery took 3.9 seconds in this run; no repeated performance claim. `node --check` and `git diff --check` passed.
- Added contributor ownership guidance in `docs/testing.md`. Native discovery recorded 863 Rust tests before profile filtering. Case-level protocol/fault/system partition regression checks remain enforced. No commits or remote actions.
