# Audit fix: workspaces

Two confirmed audit defects in host claims and carry, fixed on
`claude/wf_bb3781ba-3ed-2`.

## 1. A lease after a restart deleted a quarantined effect claim

- **Defect.** `superseded_by` (`crates/ade-daemon/src/host_resources.rs`)
  retired any quarantined Use claim of this profile from an older incarnation
  on the same key. That included claims held by setup (`hook_outcome_unknown`),
  carry's exclusive target claim (`carry_outcome_unknown`) and resources. A
  lease taken by `refresh_leases` at startup, or by a new shell, deleted them
  without reconciliation.
- **Fix.** `superseded_by` now takes the wanted mode and retires only a lease
  claim: both claims shared, no operation ID on the old claim, and reason
  `owner_lost_during_use`. An effect's quarantined claim stays until explicit
  `resources.resolve`, and it keeps conflicting as its mode says.
- **Tests.** `host_resources::tests::a_lease_after_restart_never_retires_an_effects_quarantined_claim`
  reproduces the setup, carry-target and mid-effect cases, and checks through
  `supersedes` and `claim_conflicts` that the carry claim survives and refuses
  the lease. `only_this_profiles_own_quarantined_lease_of_the_same_key_is_superseded`
  keeps the lease case working and adds the mode check.

## 2. Carry's source cleanup could overwrite live edits

- **Defect.** `admit_carry` (`crates/ade-daemon/src/worktrees/transfer.rs`)
  took only a shared claim on the source and checked leases only in the target.
  With `clean_source`, a terminal or Agent still writing in the source could
  have an edit overwritten by `git checkout base` or deleted by `remove_file`.
- **Fix.** New pure decision `carry::source_claim(clean, source_leased)`. When
  cleaning, it refuses admission while this profile holds a lease inside the
  source, and returns `Exclusive`. The check runs under the data lock, before
  any claim, and the exclusive claim then refuses new leases and other
  profiles' use until the carry settles. Without cleaning the source stays
  shared, as before.
- **Test.** `worktrees::carry::tests::cleaning_the_source_needs_it_exclusively_and_unleased`.

## Not changed

- Wire contract unchanged; no `pnpm contract:generate` needed. The
  `clean_source` doc comment in the contract does not mention the new refusal.
- A carry with `clean_source` whose target is nested inside the source is now
  refused by the claim conflict. Default trees are siblings, so this should be
  rare; the refusal is definite.

## Checks

- `pnpm check:static`: passed (687 Rust tests passed, 5 skipped).

References:
- docs/proposed-architecture.md sections 4–6
