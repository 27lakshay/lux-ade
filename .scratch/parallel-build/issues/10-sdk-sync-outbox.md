# Where do feed sync and the pending-operation outbox live?

Status: closed
Type: wayfinder ticket (grilling, HITL)
Label: wayfinder:grilling
Map: [Parallel build](../README.md)
Assignee: none
Blocked by: [06](06-client-journals.md)

## Question

Should feed catch-up and the pending-operation outbox move from Electron main and the renderer into `@ade/client`, move to the daemon, or stay split? Who owns durability for a submitted-but-unacknowledged operation?

## Comments

- 2026-09-27 — Resolved: The daemon owns everything after admission, through new list and acknowledge operations for pending sends and Git operations; this replaces the transfer bundle. `@ade/client` keeps only a small outbox for operations the daemon has not yet admitted, with pluggable storage that Electron main persists. The feed catch-up moves into a Node-free `@ade/client` sync core fed over IPC. Schedule it after the Electron-main split from ticket 05, because both edit `index.ts`.
