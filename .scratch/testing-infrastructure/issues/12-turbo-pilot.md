# 12 — Pilot Turborepo on a narrow build and static-check graph

**Type:** implementation ticket

**Status:** ready-for-agent

**What to build:** A bounded local-cache pilot determines whether task orchestration improves ADE’s existing commands enough to retain it.

**Blocked by:** [08 — Add focused test selection with an explanation mode](08-affected-selection.md); [11 — Measure and adopt useful Rust CI caching](11-rust-ci-cache.md)

## Acceptance criteria

- [ ] Read current official Turborepo agent guidance and skill before integration; add a pinned root development dependency through pnpm for a small build/static subset.
- [ ] Preserve usable pnpm entry points without recursive wrappers. Declare actual dependencies, outputs and source, contract, toolchain, native-feature and environment inputs.
- [ ] Keep protocol, desktop, live, system and performance test-result caching disabled. Preserve conservative cross-language affected selection.
- [ ] Verify unchanged runs, package edits, shared Rust edits, changed fixtures, missing outputs, material environment/toolchain changes and failed upstream tasks.
- [ ] Compare equivalent pnpm-only and pilot runs using the measurement workflow; explain hits, misses and dependency ordering.
- [ ] Record a keep/remove decision based on savings or demonstrably simpler orchestration. Remove the pilot if unjustified; remote caching and Vite+ adoption are outside this ticket.

## Validation and handoff

- Verify the current code before relying on the audit’s observations. Preserve existing acceptance scope and document any evidence that changes the proposed approach.
- Before integrating a tool or dependency, check current official documentation and available agent guidance; pin compatible versions through the existing package manager or tool installer.
- Run `pnpm check:static` and the checks affected by this change. Validate edited tracked configuration with its own tool. Record commands, outcomes and any unexecuted proof.
- Report the result and evidence. Ticket publication does not authorize implementation, commits, pushes, workflow dispatches, remote settings or releases.
