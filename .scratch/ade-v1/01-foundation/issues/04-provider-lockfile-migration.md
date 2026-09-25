# Move provider installs to root pnpm ownership

Status: ready-for-agent
Type: implementation ticket
Requirements: F021, F023, F139 (dependency ownership)
Blocked by: 01-root-workspace

Outcome: the root workspace owns the provider lockfile graph. Update bootstrap,
packaging and provider notices only after installed module resolution and existing
GPUI launch paths are verified. Preserve Oh My Pi's Bun execution requirement.

E2E acceptance: a fresh root install launches the three existing provider bridges
through the real runtime under deterministic fixtures; prototype build/startup
remains functional. Live provider accounts require separate coverage.
