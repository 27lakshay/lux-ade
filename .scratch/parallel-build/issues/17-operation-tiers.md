# Which operations need the full reliability machinery?

Status: closed
Type: wayfinder ticket (grilling, HITL)
Label: wayfinder:grilling
Map: [Parallel build](../README.md)
Assignee: none
Blocked by: none

## Question

Should ADE classify every operation into tiers, and apply operation IDs, payload fingerprints, receipts, outboxes and reconciliation only to the tier that has external effects?

Proposed tiers:
- **Query:** no side effects.
- **Idempotent command:** repeating it is naturally safe, like file browsing or workspace registration.
- **Effect command:** it acts on the outside world, like a provider prompt, an approval answer, a Git mutation, worktree removal or process launch.

Record the tiers in `docs/proposed-architecture.md` section 4 and in the contract schema.

Origin: the 2026-09-27 architecture review found that uniform application of the durability machinery to every operation is the biggest cost behind 2 of 107 features being accepted. The reliability bar stays the product. This ticket decides where the bar applies, not whether it applies.

## Comments

- 2026-09-27 — Resolved: Yes, with three tiers: query, idempotent command and effect command. Only effect commands carry an operation ID, a payload fingerprint, a receipt, an outbox entry and reconciliation. The tier is declared in the contract schema per operation, and `docs/proposed-architecture.md` section 4 gets the rule.
