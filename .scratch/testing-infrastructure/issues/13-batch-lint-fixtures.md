# 13 — Batch lint-rule fixtures without losing diagnostics

**Type:** implementation ticket

**Status:** ready-for-agent

**Completion:** complete (verified 2026-09-29)

**What to build:** Lint-rule tests spend less time starting the linter while retaining exact case-level correctness checks.

**Blocked by:** [05 — Add repeatable benchmarks with Hyperfine](05-hyperfine-baseline.md)

## Acceptance criteria

- [x] Measure repeated baseline runs for the same fixture set before changing execution.
- [x] Batch fixtures by rule and attribute structured diagnostics to the correct case, including positive and negative cases.
- [x] Retain checks of expected diagnostics and detection of unexpected diagnostics, including unexpected messages in nominally passing fixtures.
- [x] Exercise missing, extra and misattributed diagnostics to prove the harness catches regressions; keep failure output actionable per case.
- [x] Compare repeated timings with unchanged assertion scope and retain batching only if the benefit justifies the added harness complexity.

## Validation and handoff

- Verify the current code before relying on the audit’s observations. Preserve existing acceptance scope and document any evidence that changes the proposed approach.
- Run `pnpm check:static` and the checks affected by this change. Validate edited tracked configuration with its own tool. Record commands, outcomes and any unexecuted proof.
- Report the result and evidence. Ticket publication does not authorize implementation, commits, pushes, workflow dispatches, remote settings or releases.

## Comments

### 2026-09-29 — Keep rule batching

- The original 84 fixture declarations are byte-identical: 29 valid cases and 55 invalid cases across 19 rules. Independent original native JSON confirmed zero diagnostics for every valid case and exactly one for every invalid case. Batching retains separate paths, extensions, message expectations and named Node test results while starting Oxlint once per rule. A focused Node name filter loads only the required rule batch.
- `oxlint-fixture-report.mjs` attributes native JSON diagnostics by fixture filename and rejects incomplete reports, unknown files, interrupted/failed invocations and inconsistent exit status. Each negative fixture checks exactly one error with its expected rule, severity and message; each positive fixture requires none. Five harness tests deliberately exercise missing, extra, misattributed, unexpected and malformed results.
- Five measured runs before and five after used the same external sample wrapper, no warmups and unchanged Node/Oxlint worker policy. All measured runs passed the same 84 fixtures. Before: **median 5.813 s, range 5.613–5.892 s**. After: **median 1.427 s, range 1.415–1.465 s**. Median reduction: **75.4%**, about 4.39 s per fixture-suite execution. This is a focused fixture saving, not a measured whole-acceptance speedup.
- Raw Hyperfine samples, native JUnit per repetition, original per-fixture native JSON, tool versions and source/wrapper hashes are preserved in `test-results/ticket13/`; `verified-comparison.json` maps measured samples separately from the unmeasured preflight runs. No package was added. Keep batching: the measured saving justifies the small native-report helper and its failure checks.
- Initial static validation exposed an independent client-journal cleanup race: `openClientJournals` rejected when a Git journal was invalid while its concurrent owner-file initialization still wrote into a directory the caller could remove. The function now waits for every initialization to settle before propagating failure. A regression holds the real owner-file write and observes the actual invalid-journal refusal; it failed before the fix, passed afterward, failed when only the fix was removed, and passed after restoration. The final regression uses explicit barriers, not a timed sleep. Logs remain in `test-results/ticket13/journal-regression`.
- All four CLI journal protocol cases passed (`protocol-81ef93e8-c3c0-4742-8da3-4fbb0a4adbb4`). Final `pnpm check:static` passed all 25 stages (`static-7a48b9d4-d60b-410f-b59d-943c85ca9a9d`), including 292 JavaScript cases, provider/browser checks, discovery and Rust checks. An intermediate unbound-method lint error in test instrumentation was fixed by binding the original static method; no suppression was added.
