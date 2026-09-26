# What envelope does every mutating command carry?

Status: closed
Type: wayfinder ticket (grilling, HITL)
Label: wayfinder:grilling
Map: [Parallel build](../README.md)
Assignee: none
Blocked by: [09](09-schema-tool.md), [10](10-sdk-sync-outbox.md), [17](17-operation-tiers.md)

## Question

What operation ID, payload fingerprint, caller attribution and expected-revision fields does every mutating command carry? Where are receipts stored, and how do the per-feature request IDs used today migrate to it?

## Comments

- 2026-09-27 — Resolved: Only effect commands carry the envelope. The caller supplies `operation_id`. The daemon computes the fingerprint over the canonical payload, excluding the ID; clients never send one. The envelope also carries caller attribution (surface, profile, agent or user) and, per resource where needed, an optional `expected_revision`. One shared Rust receipt module and schema, with an `operations` table in each SQLite database, written in the same transaction as the state change. It replaces send intents, worktree operations, Git receipts and browser receipts. Receipts are kept 30 days; afterwards a reused ID returns `expired`, never a re-run. Migration is per domain, inside the slice that types that domain's handlers.
