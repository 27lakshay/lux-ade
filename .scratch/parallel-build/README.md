# Parallel build: faster, architecture-aligned ADE v1 delivery

Status: complete — every ticket is resolved. Execute [the handoff](issues/15-handoff-order.md).
Type: wayfinder map
Label: wayfinder:map

## Destination

An ordered, ticketed handoff that the build agent can execute. It settles every
structural decision needed so that a coordinator and parallel workers close v1
features faster than the single shared checkout does today, and the build stops
drifting from the [proposed architecture](../../docs/proposed-architecture.md).

## Notes

- Domain: delivery process for the ADE v1 build. This is not a v1 product feature
  and is not in the [requirements register](../ade-v1/requirements.md).
- This map plans. It produces decisions, not code. Execution happens after
  handoff as ordinary v1 work under the project [AGENTS.md](../../AGENTS.md).
- Consult on every ticket: `/grilling` and `/domain-modeling` for grilling
  tickets; `/research` for research tickets; `CONTEXT.md` for terms;
  `docs/proposed-architecture.md` and `docs/monorepo-initialization-plan.md` for
  ownership rules; `~/dotfiles/agents/machine/worktrees.md` before any worktree
  decision.
- Path decision (user, 2026-09-27): the reliability bar is the product. Stay on
  the current Rust daemon/runtime path and speed it up. A TypeScript or Effect
  rewrite, or a fork of t3code or Orca, was considered and rejected.
- Standing choices (user, 2026-09-27):
  - The build agent pauses after its current slice while this map is charted.
  - Workers run under a Claude Workflow. For this build, rounds need no approval
    from the user; the coordinator reports each round's cost afterwards.
  - Contract-drift checks are static checks.
  - The coordinator may merge worker branches into `codex/architecture-proposal`
    locally. It does not push.
  - Claude resolves technical tickets AFK and brings only real trade-offs to the
    user.
  - Up to 10 worker worktrees plus the coordinator.
  - No E2E work until the UI phase.
- Evidence so far (2026-09-27 audit): implementation takes 4–12 minutes per
  slice and checks take 6–22 minutes. Workers already exist but share one
  checkout. Five files take most edits: `apps/desktop/src/main/index.ts`,
  `apps/desktop/src/renderer/src/main.tsx`, `crates/ade-daemon/src/sessions.rs`,
  `apps/cli/src/index.ts` and `crates/ade-daemon/src/store.rs`. Only 2 of the
  107 v1 features are fully accepted.
- The map lives on branch `claude/parallel-build` (worktree
  `~/work/worktrees/lux-ade/claude-parallel-build`), not in the main checkout.
- Tracker: local Markdown. Tickets live in `issues/`. Research findings live in
  `research/`. Blocking uses the `Blocked by:` line because the tracker has no
  native dependencies. A ticket is claimed by setting `Assignee:`.

## Decisions so far

<!-- one line per closed ticket -->

- [Pause the build agent after its current slice](issues/01-pause-build-agent.md): paused at `5f89455`. It had already generated a first client contract (`542b0fa`), which ticket 09 now weighs.

- [Which Workflow setup runs a coordinator and workers in worktrunk worktrees?](issues/02-workflow-harness.md): the main session in the main checkout is the coordinator. Each Workflow run is 2 hook-made worktrunk workers that fast-forward to the build branch, run long checks in the background, and are merged, checked and retired by the coordinator.
- [Which backup implementation ships?](issues/07-backup-implementation.md): Rust `ade-control backup` ships. The Python backup retires after Rust gains five behaviours and the 19 Python-backed E2E cases switch over.
- [What stops two E2E suites running concurrently on one Mac?](issues/03-e2e-isolation.md): almost nothing, because each E2E derives its paths from its own temp directory. Three small fixes are needed: isolate `desktop-smoke.spec.ts` from the real profile registry, clear inherited `ADE_*` variables in the Playwright config, and give new worktrees `.ade/native`, `.ade/vendor` and `.ade/tools`. Keep `target/` per worktree. Playwright runs 1 worker with no sharding, and a serial source run takes about 6 minutes.
- [Why do the Electron send and Git journals exist?](issues/06-client-journals.md): their unique job is the crash window before the daemon admits an operation. Everything after admission (pending list, acknowledgement, quit gate, profile transfer) could move into the daemon, leaving a small outbox in `@ade/client` that holds only unadmitted operations. Moving feed catch-up into the SDK needs a Node-free subpath and injected transport. The CLI leaves durability to its caller.
- [Where do the hot files split?](issues/05-hot-file-seams.md): split in six steps, in this order: Electron main IPC by domain, renderer panes, CLI command areas with per-area usage text, `sessions.rs` as child `impl` modules, per-domain `window.adeHost` namespaces, then `store.rs` with coordinator-assigned migration numbers. Together they cut cross-feature co-edits from 1,950 pairs to 430. What remains is real coupling that needs contract and envelope work.
- [How are wire messages typed today, and which schema tools fit?](issues/04-wire-typing.md): the wire is untyped newline-delimited JSON with about 96 daemon operations and no typed request or response structs. TS validates little, and shapes are hand-written 2–3 times per operation. The recommended tool is Schemars with json-schema-to-typescript and Ajv, with ts-rs as the fallback. Migration is about 10 slices, and the Rust handlers get typed structs first.
- [Which reference repo applies to each remaining slice, and may it be copied?](issues/08-reference-map.md): all seven repos are MIT or Apache-2.0 (Herdr only from 0.8.0), so their code may be copied with attribution. The exceptions are GPLv3 Ghostty scripts and vendored third-party directories, which are study-only. A slice-to-reference table covers 7 daily-use slices and 12 domains; most rows borrow patterns rather than code.
- [Which schema tool generates the contracts?](issues/09-schema-tool.md): Schemars on typed Rust structs, generating TS types and Ajv validators into `packages/contracts` with a stale-file check. The build agent's hand-written `protocol/daily-use.json` is ported, then retired.
- [Where do feed sync and the pending-operation outbox live?](issues/10-sdk-sync-outbox.md): the daemon owns everything after admission. `@ade/client` keeps a small outbox for operations not yet admitted, plus a Node-free sync core. It lands after the Electron-main split.
- [How is delivery speed measured?](issues/14-speed-measure.md): fully accepted feature IDs plus R-requirements per week, baseline `5f89455`, and per-slice time logs.
- [How does each slice record and attribute its reference use?](issues/16-reference-protocol.md): `References:` blocks, "Portions adapted from" headers, a root `THIRD-PARTY-NOTICES.md`, a merge-time check, and coordinator reports instead of approval for Apache-2.0 copies.
- [Which operations need the full reliability machinery?](issues/17-operation-tiers.md): three tiers (query, idempotent command, effect command). Only effect commands get IDs, fingerprints, receipts and reconciliation.
- [Which checks, besides E2E, may cover pure logic?](issues/18-test-policy.md): no E2E work until the UI phase. Backend slices are verified by static checks plus in-process tests of pure cores.
- [How many workers can this Mac run?](issues/12-worker-capacity.md): not measured. The user chose 5 worker worktrees plus the coordinator, later raised to 10.
- [What envelope does every mutating command carry?](issues/11-command-envelope.md): only effect commands carry one. The caller supplies an operation ID and the daemon fingerprints the payload. A shared receipt module writes to a per-database `operations` table in the same transaction as the change, and keeps receipts 30 days. It migrates per domain.
- [How do the coordinator and workers own, integrate and verify work?](issues/13-coordination-protocol.md): a fresh Claude coordinator in the main checkout runs a serial foundation phase, then up to 10 domain-owning workers. The coordinator alone edits shared files. Evidence goes to per-slice files. There is a review per slice, and the coordinator merges serially after static checks and the build.
- [In what order does the build agent execute the decisions?](issues/15-handoff-order.md): **this is the handoff.** Phase 0 is the serial foundation (rules, worker bootstrap, hot-file splits, contracts scaffold, receipts). Phase 1 is a 10-domain trial round judged against the baseline. Phase 2 is steady rounds (outbox, backup, then queued v1 slices), with stop conditions.

## Not yet specified

- Changes to `progress.md` and the per-domain `issues/` tickets so parallel
  workers can record evidence without conflicting edits.
- A trial run that confirms the new setup raises the rate of fully-accepted
  features. This is the first execution item after handoff, not a map ticket.

## Out of scope

- E2E infrastructure (Playwright sharding, headless protocol E2E, the three
  isolation fixes from [ticket 03](issues/03-e2e-isolation.md)): deferred to the
  UI phase by the user's test-policy decision.

- Frontend adoption of the D07 UI stack: it follows the Pen-first design
  workflow instead.
- Other holes from the 2026-09-27 architecture review: the daemon↔runtime
  reconciliation specification, the cross-profile topology, the authority split
  between the two terminal emulators, plugin hooks before admission, and the
  concurrency model (thread disciplines versus tokio at the connection layer).
  They are real architecture work, but not speed work. Take them to an
  architecture design session.
- HostResources, the durable change feed and per-profile database consolidation:
  these are real architecture gaps, but they do not block parallel work. Record
  them as open against their v1 requirements.
- The provider contract and plugin seams: they belong to Milestone D.
- Live-account blockers (a real Oh My Pi account, real two-account Claude): only
  the user can clear them.
