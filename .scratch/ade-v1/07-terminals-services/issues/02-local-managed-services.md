# Local managed service controls

Status: in-progress
Type: implementation ticket
Requirements: F085, F086
Blocked by: 01-xterm-surface, 02-client-connection

Outcome: The local CLI and Electron app can inspect configured workspace services, start and stop them through the same profile daemon, and show assigned ports with execution state. This is one daily-use slice; F085 and F086 remain unverified against their full specifications.

E2E acceptance: In an isolated real daemon and Electron process, configure a service recipe through the CLI for a workspace, start an actual process, observe its assigned port and running state in both CLI and app, close/reopen the UI while the service remains alive, then stop it and observe the process exit. Show an explicit error for an invalid recipe. Do not label a port as listening merely because it was allocated.

Dependencies and limits: The daemon already owns `service.configure`, `service.list`, `service.start` and `service.stop`, including durable service identities and verified stop. The configured port is an advisory assignment until the child binds. This slice does not discover arbitrary processes, attribute unknown listeners to workspaces, implement readiness checks, or meet the full F085/F086 acceptance criteria.

Evidence (26 September 2026): The local CLI configures, lists, starts and stops a managed service. Electron lists its configured port and execution state and starts/stops it through the same daemon. A real-process E2E keeps an HTTP service alive across full Electron closure/relaunch, then verifies stop closes its listener. The UI deliberately states that an assigned port does not prove a listener. Arbitrary listener discovery, ownership attribution and readiness remain open, so F085/F086 retain their register status.
