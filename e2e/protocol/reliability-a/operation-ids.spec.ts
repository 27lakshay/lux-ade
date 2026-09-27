// R001 and R002 gap: these operations are declared effect commands, but their
// requests carry no caller-supplied operation ID (AGENTS.md: "Only effect
// commands carry an operation ID, a daemon-computed payload fingerprint, a
// receipt and reconciliation"; architecture section 4). Without one, a retry
// after a lost reply cannot be told apart from new work, a changed payload
// cannot conflict, and a crash between admission and settlement has no
// receipt to reconcile. Each test is a fixme until its contract gains a
// required `operation_id` and its daemon handler a receipt; the body states
// the first thing that must then hold.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '../fixtures'
import { repositoryRoot } from '../fixtures/environment'

const withoutOperationId = [
  'conversation.create', 'queue.pause', 'agent.cancel', 'agent.resume', 'agent.disconnect', 'account.create',
  'terminal.restart', 'terminal.stop', 'terminal.retire', 'service.start', 'service.stop', 'service.remove',
  'service.proxy.remap', 'service.proxy.retire', 'service.proxy.recovery.retry', 'service.proxy.recovery.reset',
  'worktree.adopt', 'script.start', 'script.stop', 'script.retire', 'runtime.prepare_restart',
] as const

const contracts = JSON.parse(readFileSync(join(repositoryRoot, 'packages/contracts/schema/contracts.json'), 'utf8')) as
  { $defs: Record<string, { required?: string[] }>; operations: Array<{ name: string; request: string; tier: string }> }

/** The fields the `op` request contract requires. */
function requiredFields(op: string): string[] {
  const operation = contracts.operations.find((entry) => entry.name === op)
  expect(operation?.tier).toBe('effect_command')
  return contracts.$defs[operation!.request]?.required ?? []
}


for (const op of withoutOperationId) {
  // Gap: the `${op}` request has no operation ID, so R001 and R002 cannot hold for it.
  test.fixme(`R002: ${op} is an effect command that takes a required operation ID`, async ({ profile }) => {
    expect(requiredFields(op)).toContain('operation_id')
    // Then: the same ID and payload replays, another payload conflicts, and
    // both hold after profile.restartDaemon('kill'), as receipts.spec.ts checks.
    expect(profile.hello.pid).toBeGreaterThan(0)
  })
}
