# In what order does the build agent execute the decisions?

Status: closed
Type: wayfinder ticket (grilling, HITL)
Label: wayfinder:grilling
Map: [Parallel build](../README.md)
Assignee: none
Blocked by: [07](07-backup-implementation.md), [08](08-reference-map.md), [16](16-reference-protocol.md), [11](11-command-envelope.md), [13](13-coordination-protocol.md), [14](14-speed-measure.md)

## Question

Given every decision on this map, what is the ordered execution list, the stop condition after each step, and which step is the trial run?

## Comments

- 2026-09-27 — Proposed order (awaiting the user):

  **Phase 0: foundation.** The coordinator works alone in the main checkout. Each step stops when build, typecheck, Clippy, rustfmt and Fallow are green; commit per step.
  1. Rules: update AGENTS.md with the test policy (no E2E until UI; in-process pure-core tests allowed), the coordinator and worker ownership rules, and the reference protocol. Add a `THIRD-PARTY-NOTICES.md` scaffold. Record the operation tiers in `docs/proposed-architecture.md` section 4.
  2. Worker bootstrap: a script that fast-forwards to the build branch, runs `pnpm install` and clones `.ade/native`, `.ade/vendor` and `.ade/tools`. Also an evidence-file template, and build limits for 10 workers: install sccache and cap `CARGO_BUILD_JOBS` per worker.
  3. Hot-file splits, steps 1–6 from [ticket 05](05-hot-file-seams.md). Pure moves come first.
  4. Contracts scaffold: `packages/contracts`, the Schemars → json-schema-to-typescript and Ajv pipeline, and the stale-file check. Port the 4 daily-use operations, and retire `protocol/daily-use.json` and its generator.
  5. The receipt module and `operations` table schema, and the tier field in the schema.

  **Phase 1: first parallel round, which is the trial run.** Up to 10 workers, one domain each. Each types its daemon handlers and contracts, and migrates its receipts, for these domains: sessions/conversations, review, worktrees, scripts, files, services, terminals, browser, profiles/control, and runtime protocol. The coordinator merges serially. Judge the round by [ticket 14](14-speed-measure.md)'s measure against the `5f89455` baseline.

  **Phase 2: parallel rounds.** Workers take the daemon-side outbox and list/acknowledge operations ([ticket 10](10-sdk-sync-outbox.md)), the Rust backup gains needed to retire the Python backup ([ticket 07](07-backup-implementation.md)), and then the queued v1 feature slices from `progress.md`. Each slice declares its operation tiers, writes an evidence file and cites its references.

  **Stop and report to the user if (confirmed by the user 2026-09-27, with sccache installed):** two consecutive rounds fail to merge green; a round's accepted-feature rate is below the baseline; or build contention makes the round slower than 5 workers would be (lower the cap).

- 2026-09-27 — Coordinator amendment, pending user confirmation. With E2E paused, no feature can meet its E2E acceptance criteria, so the "accepted-feature rate" stop condition would read zero and stop every round. Until E2E returns, throughput is measured as slices merged per round, requirement IDs advanced, and minutes per slice. Stop if throughput falls below the build agent's pace of about one slice per 20–40 minutes. Condition 3 (build contention) lowers the worker cap instead of stopping.
