// These exact Node patterns are used by both execution and ownership discovery.
export const nodeTestGlobs = ['packages/*/src/**/*.test.mjs', 'apps/*/src/**/*.test.mjs', 'scripts/*.test.mjs']
export const pythonChecks = [
  'test_live_profile.py',
  'test_runtime_test_support.py',
  'test_native_report.py',
  'test_tools_installer.py',
  'test_ci_build_artifact.py',
  'test_bootstrap.py',
  'test_build_identity.py',
  'test_first_launch.py',
  'test_native_accessibility.py',
]
export const externalTests = {
  'provider-installed': [
    'providers/opencode/loopback.test.mjs',
    'providers/opencode/live.test.mjs',
    'providers/omp/live.test.mjs',
    'providers/omp/loopback.test.mjs',
    'scripts/test_codex_loopback.py',
    'scripts/test_claude_loopback.py',
    'providers/claude/loopback.test.mjs',
    'scripts/test_agent_handoff_loopback.py',
  ],
  'provider-live': ['scripts/test_agent_handoff_live.py', 'scripts/live_provider_check.py'],
}
// Retain these historical checks as migration references. Exclusion never claims parity.
// Their old setup/contract assumptions must be ported before treating them as current acceptance.
export const historicalTests = {
  'test_agent_handoff.py':
    'Uses ADE_ROOT-created workspace and runtime.prepare_restart with release binaries; retain handoff assertions for protocol migration review.',
  'test_attachments.py':
    'Uses ADE_ROOT-created workspace and old conversation.get history envelope; retain attachment assertions for protocol migration review.',
  'test_binary_transport.py':
    'Exercises the old unscoped subscribe/resize/input terminal wire protocol; current terminals use explicit identities.',
  'test_diagnostic_correlation.py':
    'Historical automatic ADE_ROOT setup; successful request/run/provider correlation, viewer disconnect and private CLI export assertions migrated to e2e/protocol/ops/diagnostic-correlation.spec.ts.',
  'test_gui_only.py':
    'Requires a caller-provided socket and asserts old session-operation error text; not an isolated current acceptance entry point.',
  'test_providers.py':
    'Uses release binaries and old automatically opened workspace/conversation envelopes; deterministic provider and protocol suites own current execution, parity remains unverified.',
  'test_reconnect_memory.py':
    'Measures the old unscoped input/ping/subscribe terminal protocol; retain workload for the performance ticket, not a current performance result.',
  'test_recovery.py':
    'Tests the Python recovery controller and old automatic terminal through runtime.prepare_restart; preserve until migration parity is audited.',
  'test_recovery_admission.py':
    'Injects historical session/database state and uses automatic ADE_ROOT workspace setup; retain recovery/admission assertions for migration review.',
  'test_render_scaling.py':
    'Launches removed ade-client with --windows and native telemetry; retain the ten-view workload for current Electron performance work.',
  'test_review.py':
    'Uses request_id-based review receipts and old review.hunk/review.operation payloads; current effect commands use operation_id.',
  'test_runtime.py':
    'Uses historical unscoped ping/input/resize and automatic terminal setup; preserve assertions for current terminal acceptance review.',
  'test_services.py':
    'Uses release binaries, automatic ADE_ROOT workspace and historical service operations; preserve until current service parity is audited.',
  'test_sessions.py':
    'Exercises ade-sessions-v1 and historical session.subscribe envelopes; retain as protocol migration reference.',
  'test_tabs.py':
    'Assumes catalog workspace terminal_id and automatic terminals; current layout tabs and terminals have separate ownership.',
  'test_terminal_ownership.py':
    'Launches the removed ade-client native binary; preserve terminal ownership assertions for current protocol/desktop review.',
  'test_view_lifetime.py':
    'Requires removed ade-client --ui-smoke and native child panels; current desktop is Electron.',
  'test_worktrees.py':
    'Uses old worktree.get and request_id mutation payloads with ADE_ROOT bootstrap; preserve lifecycle assertions for migration review.',
}
