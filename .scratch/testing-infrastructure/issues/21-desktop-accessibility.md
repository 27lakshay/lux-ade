# 21 — Add targeted axe checks to desktop acceptance

**Type:** implementation ticket

**Status:** ready-for-agent

**Completion:** complete (verified 2026-09-30)

**What to build:** Built desktop acceptance detects actionable accessibility violations in representative implemented UI states.

**Blocked by:** [07 — Make CI run the same acceptance gates as local development](07-ci-parity.md); [09 — Make browser and Electron failures easy to reproduce](09-failure-debugging.md)

## Acceptance criteria

- [x] Add compatible `@axe-core/playwright` as a development dependency in the workspace owning the Playwright desktop runner, using pnpm.
- [x] Scan the built shell, open command palette and representative confirmation dialog once each after public UI interactions reach readiness.
- [x] Retain explicit keyboard, focus and interaction tests. Add conversation scans only when that production surface exists; do not claim bridge tests prove composer/transcript accessibility.
- [x] Report rule IDs, affected elements and useful failure details through the established reports.
- [x] Fix discovered violations or give each narrowly scoped temporary exclusion a reason and a tracked issue; do not blanket-ignore the initial results.
- [x] Verify a temporary missing-label defect is detected, then restore it. Include scans in desktop acceptance/CI and report their incremental runtime separately.

## Validation and handoff

- Verify the current code before relying on the audit’s observations. Preserve existing acceptance scope and document any evidence that changes the proposed approach.
- Before integrating a tool or dependency, check current official documentation and available agent guidance; pin compatible versions through the existing package manager or tool installer.
- Run `pnpm check:static` and the checks affected by this change. Validate edited tracked configuration with its own tool. Record commands, outcomes and any unexecuted proof.
- Report the result and evidence. Ticket publication does not authorize implementation, commits, pushes, workflow dispatches, remote settings or releases.

## Local implementation progress — 2026-09-30

Ticket 07's local workflow and artifact wiring are implemented and verified. Its hosted proof
remains pending under the user's instruction to keep working locally. This permits the local
accessibility integration; no hosted result is claimed.

The root desktop runner now owns pinned development dependencies `@axe-core/playwright` 4.13.0
and `playwright-core` 1.60.0. The official adapter documentation and Deque's agent toolkit were
checked before integration. Electron refused axe's default blank-page aggregator with
`Target.createTarget: Not supported`. The spec uses documented legacy mode and requires one
frame so omitted cross-origin frame coverage cannot pass silently. All default rules remain
enabled with no exclusions.

The implemented shell, palette and workspace removal confirmation are reached by public UI
interactions. Raw results, selectors, HTML, durations and screenshots are attached to native
reports. Initial focus, Escape, keyboard cancellation and the retained daemon workspace are
asserted. Conversation UI remains unbuilt and unscanned.

The first scan found missing shell landmarks/heading and a closed palette's mounted text outside
landmarks. The workspace now has a main landmark and hidden level-one heading; the closed
palette unmounts. A real confirmation contrast failure exposed `--color-base` generating an
unintended text color for stock `text-base` font-size classes. A background-only `bg-base`
utility fixes the collision while stock kit files stay unchanged. Light and dark kit tests
check that dialog titles inherit their dialog foreground.

The scan initially also observed the closing menu's fade; it now waits for that DOM to leave
before scanning the confirmation. A launcher diagnosis found a separate `pnpm test -- <file>`
separator forwarded into Vitest, causing reporter flags to become filters and the native JSON
to be absent. The launcher strips the leading package separator; its new regression fails
when only that fix is removed, and the original caller now runs the four kit cases with native
JSON. Temporary missing-label and removed-color probes, full desktop acceptance and final
static validation are in progress. Ticket 21 is incomplete until these checks pass.


## Final local verification — 2026-09-30

All Ticket 21 infrastructure criteria are complete. The maintained desktop suite discovers
and runs the new spec through the existing local acceptance and CI job commands. Hosted
execution remains pending under Ticket 07; no push or workflow dispatch was performed.

`pnpm check:static` passed all **27 stages in 71.268 s**:
`static-d8c2780f-3087-418f-bfea-338b3cc93ea3`. This includes **313 browser cases**, the two new light/dark
contrast regressions and the package-separator regression. Full desktop acceptance passed
**8 cases, zero skips and retries, in 14.113 s**:
`desktop-cee518c1-6d51-46f4-a218-a28a45cc2fd4`. Tab and Shift+Tab keep focus in the palette and cycle between
the confirmation buttons; keyboard cancellation leaves the workspace in the daemon catalog.

The temporary missing-label defect failed with `button-name`. Removing only the theme fix
failed the real desktop confirmation with `color-contrast` and both light/dark browser
regressions. Restoration passed three independent fresh desktop samples. All temporary
source mutations are removed. The package separator fix has its own removal proof and the
original caller now produces native JSON for the four selected kit cases.

The three scans cost **621.584 ms combined at the median** across fresh focused samples.
That measures added scan execution, excluding launch, readiness and keyboard checks; it is
not a before/after speed claim. Raw samples, rule results, screenshots, failures and final
reports are retained in `test-results/ticket21-accessibility/verified.json`. No owned daemon or
runtime remained. Axe's incomplete findings remain explicit: the empty pane tab list, Base UI
modal focus guards, shortcut glyph contrast and the confirmation description's overlapping
background. Focus confinement is verified; the other incomplete findings are not automated
passes or a full accessibility signoff. Conversation UI remains unbuilt and unscanned.
