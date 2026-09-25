# Move provider installs to root pnpm ownership

Status: ready-for-review
Type: implementation ticket
Requirements: F021, F023, F139 (dependency ownership)
Blocked by: 01-root-workspace

Outcome: the root workspace owns the provider lockfile graph. Update bootstrap,
packaging and provider notices only after installed module resolution and existing
GPUI launch paths are verified. Preserve Oh My Pi's Bun execution requirement.

E2E acceptance: a fresh root install launches the three existing provider bridges
through the real runtime under deterministic fixtures; prototype build/startup
remains functional. Live provider accounts require separate coverage.

Evidence, 26 September 2026: frozen offline root install and peer check passed.
`ADE_TEST_DAEMON="$PWD/target/debug/ade-daemon" python3 scripts/test_providers.py`
passed eight mixed fixture conversations through the real daemon. Relocated Claude
and Oh My Pi bridges exited cleanly under Node and Bun, respectively. Packaging
validated internal dependency links and source/package runtime identity. Legacy
bootstrap and build-identity checks passed. `bash scripts/run.sh --build-only`
built the full GPUI client and packaged application successfully. GUI startup
remains unverified. No live provider account was exercised. The measured packaged provider tree is
2.0 GB on macOS arm64; this is a distribution-size concern for a later ticket.
