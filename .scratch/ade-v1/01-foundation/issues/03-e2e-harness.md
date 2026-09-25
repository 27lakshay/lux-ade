# Full-stack E2E harness

Status: ready-for-agent
Type: implementation ticket
Requirements: F140 and all affected R-series release criteria
Blocked by: 01-root-workspace

Outcome: one root command launches test-owned ADE processes and Electron, performs
a user-observable action, gathers bounded failure evidence and cleans only owned
resources. New behavioral tests are E2E through running UI, CLI or public protocol.

E2E acceptance: repeat the smoke run from a clean temporary profile; observe
readiness and teardown rather than relying on sleeps. Record deterministic fixture
coverage separately from real-provider coverage.
