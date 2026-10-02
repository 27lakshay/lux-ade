// The Claude worker under the provider conformance harness (@ade/provider-sdk/testing), on the
// deterministic Agent SDK double. Only the gaps recorded in conformance-fixture.mjs may fail.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { formatReport, runConformance } from '@ade/provider-sdk/testing'
import setup, { knownGaps } from './conformance-fixture.mjs'

test('the Claude worker conforms apart from its recorded gaps, with every check exercised', async () => {
  const { env, cleanup, ...fixture } = await setup({ cwd: process.cwd() })
  try {
    const worker = fileURLToPath(new URL('./worker.mjs', import.meta.url))
    const report = await runConformance({ target: { command: process.execPath, args: [worker], env }, fixture })
    const failing = report.checks.filter((check) => check.status === 'fail').map((check) => check.id)
    assert.deepEqual(failing.sort(), Object.keys(knownGaps).sort(), formatReport(report))
    assert.equal(report.counts.not_exercised, 0, formatReport(report))
  } finally {
    await cleanup?.()
  }
})
