# Which checks, besides E2E, may cover pure logic?

Status: closed
Type: wayfinder ticket (grilling, HITL)
Label: wayfinder:grilling
Map: [Parallel build](../README.md)
Assignee: none
Blocked by: none

## Question

Should the E2E-only rule in AGENTS.md allow deterministic in-process checks for pure cores, while user-visible behaviour stays E2E-only? Examples of pure cores: payload fingerprinting, cursor and feed reducers, frame codecs, reconciliation deciders, and property tests over the contract schema.

Also: should most behavioural E2E run through a headless protocol client, with real daemon and runtime but no Electron, in parallel Playwright workers, with Electron E2E reserved for UI-only behaviour?

Evidence: about 185 serial E2Es take about 6 minutes. Checks take most of each slice's time. There have been timing-sensitive races. At 107 features the suite extrapolates to hours. Only the user can change this policy.

## Comments

- 2026-09-27 — Resolved: Decided differently from the recommendation. No E2E work at all until UI work begins: no new E2E specs, and the existing suite is not a gate for backend slices. Backend slices are verified by static checks (typecheck, Clippy, rustfmt, Fallow, the contract `--check`) and by deterministic in-process tests of pure cores (fingerprints, reducers, codecs, reconciliation deciders). E2E returns when UI work starts. AGENTS.md gets this rule at handoff.
