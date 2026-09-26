# How does each slice record and attribute its reference use?

Status: closed
Type: wayfinder ticket (grilling, HITL)
Label: wayfinder:grilling
Map: [Parallel build](../README.md)
Assignee: none
Blocked by: none

## Question

Should the build adopt the protocol proposed in [the reference-map research](../research/08-reference-map.md)?

The protocol has four parts:
- a `References:` block in each slice's evidence, recording repo and snapshot, path, and whether it was studied, used as a pattern, or copied;
- a "Portions adapted from" header on every copied file;
- one `THIRD-PARTY-NOTICES.md` bundled into the macOS app;
- a merge-time static check that fails on copies from study-only paths.

It also needs two answers:
- Where does the notices file live?
- Does copying Apache-2.0 code need the user's approval, or only a report from the coordinator?

## Comments

- 2026-09-27 — Resolved: Adopt the protocol from the reference-map research. Each slice's evidence carries a `References:` block, and every copied file carries a "Portions adapted from" header. `THIRD-PARTY-NOTICES.md` sits at the repo root and is bundled into the macOS app. A merge-time static check fails on copies from study-only paths. Apache-2.0 copies need no approval from the user; the coordinator reports them.
