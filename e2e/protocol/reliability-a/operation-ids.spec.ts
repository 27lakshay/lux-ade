// R002: these 21 operations are declared effect commands, and round 4 gave
// each a required caller-supplied operation ID (AGENTS.md: "Only effect
// commands carry an operation ID, a daemon-computed payload fingerprint, a
// receipt and reconciliation"; architecture section 4). This file proves the
// contract requires the field. The replay, conflict and crash behaviour for
// every effect command is proven in e2e/protocol/reliability-core.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '../fixtures'
import { repositoryRoot } from '../fixtures/environment'

const addedInRound4 = [
  'conversation.create',
  'queue.pause',
  'agent.cancel',
  'agent.resume',
  'agent.disconnect',
  'account.create',
  'terminal.restart',
  'terminal.stop',
  'terminal.retire',
  'service.start',
  'service.stop',
  'service.remove',
  'service.proxy.remap',
  'service.proxy.retire',
  'service.proxy.recovery.retry',
  'service.proxy.recovery.reset',
  'worktree.adopt',
  'script.start',
  'script.stop',
  'script.retire',
  'runtime.prepare_restart',
] as const

const contracts = JSON.parse(
  readFileSync(join(repositoryRoot, 'packages/contracts/schema/contracts.json'), 'utf8'),
) as {
  $defs: Record<string, { required?: string[] }>
  operations: Array<{ name: string; request: string; tier: string }>
}

/** The fields the `op` request contract requires. */
function requiredFields(op: string): string[] {
  const operation = contracts.operations.find((entry) => entry.name === op)
  expect(operation?.tier).toBe('effect_command')
  return contracts.$defs[operation!.request]?.required ?? []
}

for (const op of addedInRound4) {
  test(`R002: ${op} is an effect command that takes a required operation ID`, () => {
    expect(requiredFields(op)).toContain('operation_id')
  })
}
