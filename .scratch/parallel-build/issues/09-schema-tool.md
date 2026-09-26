# Which schema tool generates the contracts?

Status: closed
Type: wayfinder ticket (grilling, HITL)
Label: wayfinder:grilling
Map: [Parallel build](../README.md)
Assignee: none
Blocked by: [04](04-wire-typing.md)

## Question

Which tool is the single authority for ADE wire contracts, and where does the generated `packages/contracts` sit in the build? This is decision D02; record the answer in `.scratch/ade-v1/decisions.md`.

Context added 2026-09-27: after the research, commit `542b0fa` introduced a hand-written contract DSL (`protocol/daily-use.json`: 4 operations and 2 feed frames) and a custom generator (`scripts/generate-client-contract.mjs`). The generator emits TS types plus runtime validators into `packages/client/src/generated.ts`, and has a `--check` drift mode. The Rust daemon is not bound to it; only E2E catches Rust drift. Options now:
- extend the DSL and add a Rust-side binding or conformance check;
- replace it with Schemars as the Rust authority (the research pick);
- keep the DSL, and derive Rust types from it.

## Comments

- 2026-09-27 — Resolved: Schemars on typed Rust structs is the single authority (D02). It generates JSON Schema, then TS types via json-schema-to-typescript and Ajv validators. The contracts are committed in `packages/contracts`, and a `--check` stale-file gate runs as a static check. The first slice ports the 4 operations in `protocol/daily-use.json` and retires that hand-written format and its generator. Every later domain slice types its Rust handlers first.
