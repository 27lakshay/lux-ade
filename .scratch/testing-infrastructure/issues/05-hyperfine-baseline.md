# 05 — Add repeatable benchmarks with Hyperfine

**Type:** implementation ticket

**Status:** ready-for-agent

**Completion:** complete (verified 2026-09-29)

**What to build:** A contributor can reproduce a selected suite’s baseline and inspect every sample before evaluating an optimization.

**Blocked by:** [04 — Produce trustworthy test reports and fixture timings](04-reports-and-fixture-timings.md)

## Acceptance criteria

- [x] Provision Hyperfine as an optional pinned tool using existing installer conventions and verified platform checksums. Normal acceptance must work without it.
- [x] Require explicit measured-run and worker counts; expose warmups and build preparation. Avoid the tool’s default ten full acceptance runs.
- [x] Store each repetition’s native results and Hyperfine timings separately, with the metadata from the reporting ticket. A failed sample fails the benchmark command and remains visible.
- [x] Record three comparable warm runs and a separately defined cold-build baseline on the same revision; report median and range, and avoid tail-percentile claims from insufficient samples.
- [x] Cover representative cases and the full suite separately; record assertion scope, build mode and cache conditions so later comparisons remain meaningful.
- [x] Verify wrapper arguments, failure propagation and aggregation. Test installer selection compatibility if provisioning behavior changes.

## Validation and handoff

- Verify the current code before relying on the audit’s observations. Preserve existing acceptance scope and document any evidence that changes the proposed approach.
- Before integrating a tool or dependency, check current official documentation and available agent guidance; pin compatible versions through the existing package manager or tool installer.
- Run `pnpm check:static` and the checks affected by this change. Validate edited tracked configuration with its own tool. Record commands, outcomes and any unexecuted proof.
- Report the result and evidence. Ticket publication does not authorize implementation, commits, pushes, workflow dispatches, remote settings or releases.

## Comments

### 2026-09-29 — Baselines exposed a setup race; completion remains pending

- Hyperfine 1.20.0 is optional and pinned with release archive checksums. Explicit run/worker counts, separate warmups/preparation, per-sample native reports and failed-sample propagation are implemented. A failed Hyperfine run may leave an empty export; the wrapper now records a failed terminal summary in that case. Filters are restricted to case selection.
- Initial stable-source measurements: static median 69.7 s (58.6–71.0), 20 protocol boot cases median 20.5 s (20.1–21.2), seven desktop cases median 7.9 s (7.8–8.9), and one cold backend build 43.0 s. Three static runs each passed 270 JavaScript, 107 provider, 310 browser, 37 Python and 862 Rust cases, plus native accessibility; one intentional Rust helper was skipped.
- Full protocol repetitions retained all outcomes: 976 passed/five skipped in 493.3 s; 976 passed/five skipped in 525.3 s; then 975 passed/five skipped/one failed in 527.9 s. Hyperfine failed the aggregate. This is not a successful full-suite baseline. Native results remain under `test-results/runs/benchmark-7d928896-a245-4a73-a26e-e62fedeb55a7`; the source checksum matched before and after collection.
- The failure was in `storage/busy.spec.ts` setup: the injected writer used SQLite's default zero busy timeout. A short competing writer reproduces `database is locked` at `BEGIN IMMEDIATE`. The regression was observed red before the fix, green afterward, red again when only the timeout was removed, then green in ten separate reported executions. A five-second acquisition timeout and close-on-failure leave the original daemon refusal, persistence and replay assertions unchanged. Correctness retries remain zero.
- The attempted `--repeat-each 10` run had ten passing test bodies but failed report validation on duplicate IDs; it is not counted as a passing command. Ten independent executions passed under `benchmark-573c83b3-0b4d-4da7-bbd0-1dda57052863`. Further storage coverage and the static gate remain to be checked after this fix; successful comparable full-suite measurements remain pending.

- Follow-up validation: all three storage-busy cases passed in three independent five-worker samples (`benchmark-bcf9450d-be66-473d-9192-2824bf7dc84f`). `pnpm check:static` passed with the Hyperfine binary temporarily unavailable, then the binary was restored. This also validates the selection-only argument restrictions. Successful full-suite baseline collection remains pending after the setup-race repair.

### 2026-09-29 — Child recovery setup made deterministic

- The revised full acceptance measurement (`benchmark-825c0692-16c7-4f23-9b9c-17ec0ae0cf52`) failed its first sample: static and backend build passed; protocol reported 976 passed, five skipped and one failed in 540.2 s. Desktop remained pending. Source checksum was unchanged during collection. This failed sample remains part of the evidence.
- The child-runtime test attempted automatic resume without ensuring that the daemon had recorded process identity. The daemon correctly refused unresolved execution ownership. The fixture now observes the provider turn and waits for the existing durable attempt record before crashing the daemon and runtime. Stopping the daemon first exercises recovery without allowing the old connection to settle the loss. Production recovery behavior is unchanged.
- Pinning that crash order reproduced the failure (`benchmark-2adade8f-9ca5-455c-96c3-69966f1cf135`). Adding record readiness passed ten independent executions (`benchmark-ac6f959f-8b83-4fd0-8f75-4885de187b4a`). Removing only the record wait reproduced the same refusal again; the fix was restored.
- Both orchestration delegation and runtime-crash files passed together: 13 tests, zero skips, five workers, zero correctness retries (`protocol-d962b529-07e7-4dfa-bcf4-10bfc2a4e987`). This includes the separate unrecorded-loss case that requires explicit user release. Successful comparable full acceptance measurements remain pending.

- The static gate passed after the child recovery setup change (`static-fa5858ae-4ad8-4203-b495-37ba03069a11`), including browser, provider, discovery, Rust and doctest stages.

### 2026-09-29 — Restart snapshot readiness

- Collection at source checksum `10e90e0adb3115b65e01dbd40eff127deb92782a4449978f74ffd83d6ad47be2` passed the cold backend build (35.8 s, fresh target, sccache disabled) and three 20-case boot samples (median 17.5 s, range 16.4–18.2 s). The first full acceptance sample failed: 976 protocol cases passed, five skipped, one failed; desktop was not run. The collection stopped and source verification passed. Results remain in `test-results/ticket05-final-collection.json` and `benchmark-6d1ae54f-cb30-4c41-92d8-9fab4024f569`.
- The restart-survival case captured its initial transcript after the mock recorded a tool PID but before its tool event reached the daemon. Its restored transcript legitimately included that later event. A temporary 300 ms delay between PID recording and event emission reproduced the exact equality failure in a focused run (`protocol-2e452174-2272-45c2-9779-346227f9bd45`).
- The test now waits for that tool message in the view before capturing its initial snapshot. All equality, process identity, resource claim, deduplication and subsequent-turn assertions remain. The delayed scenario passed (`protocol-1826b6e6-49f9-4a2a-b284-7050633b32fa`); removing only readiness reproduced the same failure. The fix was restored and the temporary mock delay removed.
- Ten independent focused executions then passed (`benchmark-16305c27-7f2e-4a3d-be1d-a3234b7a2fc2`). The static gate and new full-suite measurements remain pending after this repair.

- The static gate passed after restart snapshot readiness was fixed (`static-cf07c107-97ec-437b-9301-0faee1998391`). The provider mock is unchanged; no diagnostic delay remains.

### 2026-09-29 — Hook retry receipt and delivery outcomes

- The next collection retained a complete acceptance pass in 627.5 s (977 protocol passed, five known skips; seven desktop passed), then failed its second sample in 671.5 s (976 protocol passed, five skips, one failure; desktop pending). The third sample did not run. The wrapper failed and source verification passed. Evidence remains in `test-results/ticket05-restart-collection.json` and `benchmark-c0bc06e3-c7a6-4bdd-a2f6-09bb5ae29084`.
- The failure concerned `hook.delivery.retry` after a lost reply and immediate daemon crash. Its cached receipt correctly described queue admission. Inspection of the retained delivery showed `unknown`, attempts two: the daemon had durably claimed the retry before crashing, without an observed external effect. The test's unconditional known-outcome classification was incorrect; production unknown-outcome handling remains unchanged.
- Added a deterministic case that pauses the fixture hook before its second external effect and crashes after dispatch. It reproduced the classification failure in 1.3 s. The hook case now retains the receipt and separately reads the settled delivery through `hook.delivery.inspect`; an explicit unknown permits at most one external effect, while known outcomes still require exactly one. Replay equality and changed-payload refusal remain asserted.
- All four hook retry cases passed (`protocol-aed9d687-4fda-4a42-838d-ff7f1036faca`). Removing only the outcome-reading fix reproduced the failure; restoring it passed ten independent four-case executions (`benchmark-75e4b9a5-0d76-4675-954c-5013b01b170e`). The new crash case is permanent. Static validation and complete baseline collection remain pending after this change.

- All 24 static stages passed after the hook outcome fix (`static-960ae73e-35d9-46dd-b3ee-64f126377cff`). Baseline collection remains open while independently unblocked runner tickets proceed.


### 2026-09-29 — Desktop send synchronization

The full affected run `affected-f67e1356-5a05-4a2c-bd19-1243dc8490fb` passed all
978 protocol cases (five known skips), then failed the desktop send case: its immediate
native call count was zero although the window already reported Running. The retained
mock log later contained exactly one `turn/start` for `desktop-send-1`.
A temporary one-second mock initialization delay reproduced the same assertion failure
(`desktop-51a56e11-f920-44bd-8f4f-358a62907390`). Waiting for native dispatch before
replaying the request passed (`desktop-45280818-cb67-40f3-bb58-7ad3cf001c55`). Removing
only that wait reproduced the failure (`desktop-006f81a1-4431-4747-8b1b-ec777e8d541a`).
Restored the wait and removed the temporary delay; all seven desktop cases then passed
with five workers (`desktop-982b5f54-c096-4f15-8a08-1db3a0861fe2`). The exact one-turn,
one-user-message and replay assertions remain. No product change or correctness retry.
This is correctness evidence, not a comparable performance baseline. The three-run full
baseline remains outstanding.

### 2026-09-29 — Fresh collection after local runner/tooling work

Tickets 08, 09 and 10 now pass their local acceptance and static gates. All temporary
defects and watchers have been removed/stopped. Begin a fresh source-fingerprinted collection
in `test-results/ticket05-drain-failed-collection.json`: one cold backend sample, three representative
protocol samples and three complete acceptance samples, each at five workers. Current expected
complete protocol inventory is 984 cases (979 passing and five known skips); desktop has seven.
Do not treat this planned collection as passed until every sample and native inventory is audited.
Earlier failed collections remain evidence and are not overwritten.

### 2026-09-29 — Concurrent generation inspection could retire a draining host

- The source-frozen collection at `08b4b451a635f440e5b1353ca59c6d0f5042f1708fb118193afb29190be4efb1` passed a defined cold backend build (64.575 s) and three 20-case boot samples (median 20.399 s; range 20.211–21.893 s). Its first two full acceptance samples passed in 702.455 s and 689.017 s. Native inventories matched: 25 static stages, 979 protocol passes/five skips and seven desktop passes, with zero correctness retries.
- The third full sample failed `plugin-dev/drain.spec.ts`: inspection returned generation 1 retired while the frozen old host should still drain. The protocol result was 978 passed/five skipped/one failed; desktop did not execute. The failed collection and unchanged-source verification remain in `test-results/ticket05-drain-failed-collection.json`, with raw samples in `benchmark-0222847d-5647-4b5a-8dbf-586948606d46`. This is not a successful three-sample acceptance baseline.
- Ten ordinary parallel diagnostic repetitions passed. Polling generation state every millisecond reproduced the exact failure in one of ten repetitions, with native reports preserved outside the aggregate reporter. A temporary 250 ms delay after the generation commit reproduced it in a single focused run (`protocol-fce27cb5-f984-4bcd-8b5a-40248521aaf9`).
- The cause was a production synchronization gap: reload published the new generation before registering the old host's drain. Generation queries could also use a draining snapshot taken before acquiring the registry lock. They could permanently retire the still-running generation and remove its artifact.
- Reload now registers the drain before releasing the registry lock. Settlement paths read the draining set after acquiring that lock. The drain still runs on its background thread. The original frozen-host acceptance retains all assertions and polls frequently across publication to exercise the race.
- The pinned scenario passed with the fix (`protocol-cfaa246f-5213-4d5d-bc0f-321e152be980`); removing only the fix reproduced the original retired-versus-draining assertion (`protocol-74898329-ce75-46de-94e0-b23dd7ea1979`). The fix was restored and the temporary delay removed. Both drain acceptance cases then passed (`protocol-22ac02f8-ff76-4e48-a123-2c42e45f17de`). All 25 static stages passed (`static-c2dc132e-eae5-4816-894c-6597f795dd9e`). Broader plugin acceptance and fresh full baseline evidence remain pending.

- Broader plugin acceptance passed all 38 cases (`protocol-9e5a5666-6689-4181-aed3-0809fd4e7eba`). The same ten-repeat, five-worker, 1 ms polling stress run that reproduced the race now passed all ten tests with one attempt each. Native diagnostic reports and red/green logs are retained in `test-results/ticket05-drain-regression`. No temporary production delay remains.

### 2026-09-29 — Verified baseline complete

- Collection `test-results/ticket05-drain-fixed-collection.json` completed successfully at revision `efc8ad3cc44c46632fa63e59bdd6a7cd8df94896`, with 1,514 source files and identical before/after SHA-256 `394b2f4e94c842341456a7cb38209333afb9fc09d5222cc60c04ee3b5a9893cc`. The worktree was dirty; the fingerprint identifies the measured implementation. No competing tests, builds or watchers were launched during collection.
- All samples used five workers, zero warmups and existing prepared inputs. Three warm full acceptance runs took **801.537, 599.806 and 611.565 seconds** by Hyperfine: **median 611.565 s, range 599.806–801.537 s**. The wide range is retained; three observations do not support tail-percentile claims or a precise speedup. Evidence: `benchmark-ffcda6c8-cf59-4d70-bc8a-e96d25f80abb`.
- Each full sample passed the same 25 static stages, backend build, **979 protocol tests with five recorded skips**, and **seven desktop tests**. Static inventories matched across samples. The audit independently compared native Playwright cases with summaries and verified zero retries, no missing/duplicate cases and unchanged skip reasons. Required native static reports were present and passed. This is local execution evidence, not hosted CI proof.
- Three warm representative runs of the same 20 boot cases took **24.763, 26.522 and 32.063 s**: **median 26.522 s, range 24.763–32.063 s**. Evidence: `benchmark-6c86ed3c-cbe4-410c-8a8f-a91584c3de2f`.
- The separately defined cold backend build took **57.092 s** (`benchmark-61fd9ed7-4a43-40d8-b966-5b9b33a1889f`). It used a fresh Cargo target with sccache disabled and the existing native bootstrap/tool inputs. It is not a fresh-machine dependency installation measurement. Backend builds use the development/debug profile.
- Consolidated verified metadata, per-stage timings and sample inventories are in `test-results/ticket05-verified-baseline.json`. Earlier failed collections remain retained and are not included as successful samples. Hyperfine is kept as an optional measurement tool; normal acceptance does not require it. Tickets 13–16 and 18 can now use this baseline, with their own focused before/after measurements.
