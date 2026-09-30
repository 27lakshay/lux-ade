# 12 — Adopt Nx for local builds and checks

**Type:** implementation ticket

**Status:** complete

**Completion:** local Nx adoption and stack validation complete; hosted rollout remains separate

**What to build:** Nx orders ADE’s existing commands, caches deterministic development builds and type checks, and exposes the mixed-language project graph. Existing acceptance runners produce fresh evidence.

**Blocked by:** [08 — Add focused test selection with an explanation mode](08-affected-selection.md). Local adoption can proceed independently of [11 — Measure and adopt useful Rust CI caching](11-rust-ci-cache.md); hosted rollout still depends on [07 — CI parity](07-ci-parity.md).

## Acceptance criteria

- [x] Read official Nx documentation and agent guidance; add a pinned development dependency through pnpm and verify current Node/pnpm compatibility.
- [x] Preserve current package layout and leaf pnpm scripts. Declare build dependencies, outputs, source and material toolchain/environment inputs without recursive wrappers.
- [x] Keep all evidence-producing acceptance and test runners uncached. Preserve existing conservative cross-language acceptance selection.
- [x] Verify the actual graph against Cargo metadata, contract consumers and acceptance dependencies. Add a guard against caching evidence or omitting build outputs, with behavioral regression tests.
- [x] Verify unchanged builds, a package edit, shared Rust changes, fixture selection, deleted outputs, a material environment change and an upstream failure.
- [x] Verify the latest stack through real Nx build/typecheck, browser, protocol and desktop commands, followed by the required static gate.
- [x] Record a retain decision based on bounded feedback measurements and dependency ordering. Document local commands and limitations; hosted caching, task distribution and framework plugin adoption remain separate work.

## Validation and handoff

Run `pnpm check:static` and affected acceptance. Nx cache hits prove reuse, not fresh test execution. No hosted run, global agent configuration, commit, push or release is authorized by setup.

## Comments

### 2026-09-30 — User selected Nx

This replaces the unrun Turborepo pilot. The user requested Nx setup and validation against the latest ADE stack. Local adoption no longer waits for the hosted Rust cache experiment. Core Nx uses explicit commands and package-manifest relationships; no TypeScript, Vitest or Electron inference plugin was added.

Nx 23.2.1 is pinned. Six package typechecks pass with TypeScript 7.0.2. All four JS/Electron builds pass with Electron Vite 6.0.0-beta.3; an unchanged invocation restores all four cached builds. The graph contains 16 projects. A guard verifies Cargo path dependencies, the Rust-to-contract edge, consumers and provider/E2E edges, cache policy and build outputs.

The bounded validation restores deleted CLI outputs byte-for-byte, invalidates package and Rust source changes, selects changed protocol fixtures, invalidates NODE_OPTIONS and stops downstream consumers on an intentional contracts compiler error. Nx returned 130 for that failure, which is nonzero; the diagnostic harness’s initial exact-exit assumption failed and remains recorded. Every temporary source edit was restored. Evidence: `test-results/nx-validation-final.json`; individual logs are beside it.

Focused Vitest 5 browser execution through Nx passes four tests with a fresh report in `browser-bb6b84f3-f43b-4f1b-8a02-4246f9c5aa5d`. Focused public-protocol execution passes in `protocol-9b72b719-ccff-4c73-9005-1f3636646391`. Rust backend build also passes through Nx using the existing Cargo wrapper and native features. Desktop execution passes all eight cases in `desktop-5afa4a62-da33-4f85-b9e9-c5c39e82a3bd`. The full static gate passes all 28 stages in `static-3f027337-468b-4a52-b23c-fcc3b950d976`, including 320 JavaScript tests, 315 browser tests and 864 Rust passes with one existing skip. Nx did not cache either evidence run.

### Retain decision

Retain Nx core for local dependency ordering, graph inspection and deterministic build/typecheck reuse. The first four-project build took 3.6 seconds inside Nx; the unchanged invocation took 160 milliseconds with four cache hits. These are single observations of different cache states, not a benchmark or a statistically supported speedup. Six package typechecks and their prerequisite builds passed in 1.9 seconds. CLI, Rust, fixture, environment, missing-output and upstream-failure checks provide the adoption evidence. Existing root checks remain authoritative and cover E2E TypeScript that `typecheck:nx` does not include.

No framework inference plugins, Rust task-output caching or remote caching are configured. The full protocol suite was not repeated for this orchestration setup; one focused real-process case and all eight desktop cases passed through the existing wrappers. Hosted rollout remains under tickets 07 and 11.

### 2026-09-30 — Default command integration (steps 1–4)

Normal build, SDK build and complete typecheck commands now use Nx; E2E TypeScript remains included. The static gate schedules six repository checks concurrently through Nx and validates each fresh command summary. Lint declares SDK build prerequisites. Discovery is an explicit uncached target. The 23 top-level stages retain the earlier 28-stage coverage by grouping six checks into one static-analysis stage.

Protocol and desktop targets now depend on JS builds and the uncached backend build, then invoke their test-only commands. Shared prerequisites execute once per task graph. A focused diagnostic-correlation case passes in `protocol-de3882e7-89fe-48d8-bc39-a706612d6bad`. Regression guards reject missing E2E prerequisites, redundant wrappers and cached repository checks.

Build inputs exclude Markdown; desktop build inputs exclude test/spec files and Vitest config. TypeScript package builds retain all potentially emitted compiler inputs. A temporary desktop test-only edit retained all four production build cache hits and forced desktop typecheck execution (two prerequisite cache hits, one fresh typecheck). The edit was restored. Evidence: `test-results/nx-input-check.json`.

The final static gate passes all 23 stages in `static-e6ef3cc5-dd9e-4892-9f46-f00a696163f3`, with 323 JavaScript tests, 315 browser tests and 864 Rust passes plus one existing skip. It took 53.913 seconds; this is a single correctness run, not a controlled speedup comparison. Hosted rollout remains separate.

All eight desktop cases also pass with the final prerequisite graph in `desktop-23e3a6d6-9b1d-4e5c-98d0-c367d54aeadc`. Nx reused four JS builds; the backend build and desktop tests executed fresh.
