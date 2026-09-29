# 22 — Verify the overhaul against its baseline

**Type:** implementation ticket

**Status:** ready-for-agent

**Completion:** final local acceptance verified; overhaul completion pending hosted, trial and legacy package evidence

**What to build:** The completed overhaul has an evidence-backed comparison and accurate contributor guidance, with outstanding acceptance clearly visible.

**Blocked by:** [06 — Provide one complete local acceptance command](06-local-acceptance.md); [07 — Make CI run the same acceptance gates as local development](07-ci-parity.md); [08 — Add focused test selection with an explanation mode](08-affected-selection.md); [09 — Make browser and Electron failures easy to reproduce](09-failure-debugging.md); [10 — Pilot Bacon for Rust feedback](10-bacon-pilot.md); [11 — Measure and adopt useful Rust CI caching](11-rust-ci-cache.md); [12 — Pilot Turborepo on a narrow build and static-check graph](12-turbo-pilot.md); [13 — Batch lint-rule fixtures without losing diagnostics](13-batch-lint-fixtures.md); [14 — Shorten protocol waits through explicit clock policies](14-protocol-clock-policies.md); [15 — Reduce measured protocol fixture overhead](15-protocol-fixture-overhead.md); [16 — Reduce browser test setup costs](16-browser-setup-cost.md); [17 — Tune workers and evaluate CI sharding](17-workers-and-sharding.md); [18 — Establish an isolated performance suite](18-isolated-performance.md); [19 — Verify a packaged release candidate end to end](19-packaged-release-acceptance.md); [20 — Make live-provider and system-dependent acceptance explicit](20-live-and-system-acceptance.md); [21 — Add targeted axe checks to desktop acceptance](21-desktop-accessibility.md)

## Acceptance criteria

- [x] Reconcile maintained test ownership, suite discovery, skip categories and local/CI membership against the baseline; explain every intentional change in coverage.
- [ ] Repeat comparable warm and defined cold measurements and separate existing-suite savings from runtime added by new coverage. Record revision, machine, workers, caches, raw samples and failures.
- [x] Confirm provider coverage, conservative focused selection, correctness retries at zero and preserved real-process isolation and acceptance.
- [x] Confirm performance, package, live and system commands run only in their intended modes; distinguish implemented desktop UI evidence from bridge-only or synthetic evidence.
- [ ] Record completion evidence and keep/remove decisions for Hyperfine, debugging tools, Bacon, CI caching, Turborepo and axe. An unsuccessful optional trial can finish by removal; an unrun required proof stays pending.
- [x] Update contributor test guidance and architecture verification guidance to the implemented commands. Confirm retained tools are reproducible and absent from runtime bundles unless required by the product.
- [ ] Run the full acceptance gate and inspect hosted/release evidence. Name any unexecuted checks explicitly and do not declare the overhaul complete while required proof remains missing.

## Validation and handoff

- Verify the current code before relying on the audit’s observations. Preserve existing acceptance scope and document any evidence that changes the proposed approach.
- Run `pnpm check:static` and the checks affected by this change. Validate edited tracked configuration with its own tool. Record commands, outcomes and any unexecuted proof.
- Report the result and evidence. Ticket publication does not authorize implementation, commits, pushes, workflow dispatches, remote settings or releases.

## Comments

### 2026-09-30 — Final ordinary acceptance and reconciliation

`pnpm test:acceptance --workers 5 --desktop-workers 2` passed in 587.804 seconds:
27 static stages, backend build, 985 protocol passes with five unchanged skips,
and eight desktop passes. Native protocol/desktop times were 500.343/11.220
seconds; static took 70.316 seconds. Every passed protocol/desktop case executed
once. No baseline case or static stage was removed and no baseline outcome
changed. See `test-results/ticket22-verification/final-acceptance-audit.json`
and `static-final-inventory.json`.

Against ticket 05's baseline, protocol adds six cases: two Git isolation cases,
one live-fixture environment isolation case, two retired-plugin-host admission
cases and the terminal raw-mode signal regression. Desktop adds the targeted
axe/keyboard acceptance case. Static adds two Python check stages, 30 JavaScript
cases, three browser cases and two Rust cases. Deterministic provider coverage
remains 107 cases. The same five protocol gaps and one Rust subprocess-helper
skip remain explicit. No removal is hidden by aggregate totals.

Testing guidance, the implementation plan and architecture verification guidance
now describe actual commands, worker decisions, candidate identity and pending
proof. The real darwin-arm64 candidate passed nine protocol and two current
desktop cases. Its full content identity stayed unchanged during acceptance;
the new tooling is absent from the runtime candidate inventory. Partial candidate
selection stays labelled partial. Retained legacy UI cases remain discoverable.

Keep decisions and before/after comparisons are recorded in the individual tickets
and the plan checkpoint. No final full benchmark matrix was restarted after the
user's speed instruction. One final acceptance run is not a final median/tail
estimate: baseline/final coverage and desktop workers differ. The defined
57.092-second fresh-target cold baseline remains; no final fresh-target comparison
was collected. Those missing measurements are not passed performance proof.

Outstanding: ticket 07 hosted execution/provisioning/transport; ticket 11 hosted
cache costs and invalidation; ticket 12's dependent Turbo trial; ticket 19's nine
legacy packaged UI cases; final comparable cold measurement and repeated aggregate
performance evidence if still required. Signed/notarized distribution and separate
authenticated, physical-device and system requirements remain unexecuted where
their owning feature/platform requires them. None is silently counted as a pass.

Ticket 22 and the overhaul remain incomplete. All changes remain uncommitted on
`codex/testing-infrastructure`; no hosted workflow, remote setting or release was
changed.

### Defined cold comparison and coverage costs — 2026-09-30

One final fresh-target backend build passed: `benchmark-83d9ae50-1d01-4c96-8270-99ca23838787`,
33.718 seconds, versus the defined baseline's 57.092 seconds. Both use five
Cargo workers, existing preparation, no warmups, an empty Cargo target and
sccache disabled. Source stayed unchanged during collection. Node, pnpm, Python,
Bun, OS and architecture match the native manifests. Their generic tool probe
could not expose rustc/nextest from PATH; the baseline compiler version is
unavailable. These are single observations, not a reliable speedup or tail result.
Registry/tool/native-bootstrap inputs already exist; this is not a fresh-machine
installation or all-cache cold result. See `cold-final-comparison.json`.

`added-coverage-costs.json` separates coverage added since the baseline. The two
new sequential Python stages cost 125/449 ms in final acceptance. New test bodies
sum to 5.896 seconds JavaScript, 0.960 seconds browser, 0.030 seconds Rust,
16.205 seconds protocol and 4.034 seconds desktop. Parallel durations overlap;
these sums are not added wall time and are not subtracted from the aggregate to
manufacture an old-inventory timing. Existing comparable warm subset measurements
remain in tickets 13–17. No full benchmark matrix was restarted.

The one legacy launch-refusal case was executed and failed with test/teardown
timeouts; the other eight legacy cases require unbuilt profile controls. The
earlier nine-unexecuted classification is superseded by eight unexecuted plus
one failed. This distinction is recorded in ticket 19. The final ordinary gate
remains passed; package failures remain separate required proof, not suppressed.

The final cold comparison gap is now covered with its limitations. Hosted proof,
cache/Turbo decisions and full packaged acceptance still block completion. No
final aggregate median/tail estimate is claimed from the single final gate.

### Final cleanup verification

The restored cleanup diagnostic (`package-8a3ec175-7b01-4eff-affb-e4bd6fb9a195`) retained the expected failed recovery-window case and exited 1 without a worker teardown error. No candidate executable or helper survived. This verifies cleanup only; packaged recovery behavior remains failed. The final static gate (`static-1c426dee-d7c6-4aa4-9397-d2972cfbcb71`) passed all 27 stages in 60.181 seconds. The earlier complete ordinary acceptance remains valid; its suites were not rerun for this legacy fixture-only cleanup change.
