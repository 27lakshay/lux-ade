# Root pnpm workspace and development entry

Status: claimed
Type: implementation ticket
Owner: coordinator
Requirements: F139, R020 (foundational portion)
Blocked by: none

Outcome: the repository installs a root pnpm workspace and launches a real
Electron/React shell while the existing Rust/GPUI prototype remains runnable.
Keep the existing provider install paths working until their migration has separate
acceptance evidence.

Owned modules: root JS workspace configuration, desktop shell, initial dev/build
scripts and reproducible package versions. Coordinate changes to provider lockfiles,
Rust protocols, terminal recovery and E2E harness with their separate tickets.

E2E acceptance: launch the actual desktop with its selected development profile;
observe a real renderer window and daemon connection status; modify renderer code
and observe HMR without stopping a runtime-owned fixture process. The early shell
may show an unavailable backend state before the connection ticket lands.

Completion evidence: committed files, clean install/build, E2E run and recorded
limits. A build alone does not mark F139 or R020 complete.
