# 11 — Measure and adopt useful Rust CI caching

**Type:** implementation ticket

**Status:** ready-for-agent

**What to build:** CI reuses Rust compilation only when measured end-to-end savings and invalidation evidence justify the cache.

**Blocked by:** [05 — Add repeatable benchmarks with Hyperfine](05-hyperfine-baseline.md); [07 — Make CI run the same acceptance gates as local development](07-ci-parity.md)

## Acceptance criteria

- [ ] Measure uncached hosted install, compile, test and transfer phases; capture existing sccache hit/miss/non-cacheable statistics without changing global settings.
- [ ] Trial a commit-pinned Swatinem/rust-cache action with relevant native inputs, features, toolchains and lockfiles. Explain overlap with sccache and incremental-compilation behavior.
- [ ] Compare first misses and repeated hits including restore, build and save costs; verify invalidation for toolchain, dependency/lockfile and native-feature changes.
- [ ] Keep executable build artifacts tied to the same source revision and compatible target. A cache miss must rebuild successfully.
- [ ] Record a keep/remove decision using total hosted job time and remove unsuccessful trial configuration.
- [ ] Hosted proof requires a separately authorized push or dispatch; local checks do not substitute for it. Pending authorization is not a completed experiment.

## Validation and handoff

- Verify the current code before relying on the audit’s observations. Preserve existing acceptance scope and document any evidence that changes the proposed approach.
- Before integrating a tool or dependency, check current official documentation and available agent guidance; pin compatible versions through the existing package manager or tool installer.
- Run `pnpm check:static` and the checks affected by this change. Validate edited tracked configuration with its own tool. Record commands, outcomes and any unexecuted proof.
- Report the result and evidence. Ticket publication does not authorize implementation, commits, pushes, workflow dispatches, remote settings or releases.
