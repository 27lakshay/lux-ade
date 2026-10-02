// The conformance harness's own tests: a conforming reference worker passes every check, and each
// deliberately broken variant fails exactly the check that names its fault. Also covers the
// factory target and the CLI. Run after `pnpm build:sdk`: node --test packages/provider-sdk/src/testing.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { descriptorProblems, formatReport, runConformance } from '../dist/testing.js'

const worker = fileURLToPath(new URL('../test-fixtures/reference-worker.mjs', import.meta.url))
const factory = fileURLToPath(new URL('../test-fixtures/echo-factory.mjs', import.meta.url))
const cli = fileURLToPath(new URL('../dist/conformance-cli.js', import.meta.url))
const prompts = { reply: 'hello', hold: 'hold', request: 'ask' }

async function check(faults = []) {
  const dir = await mkdtemp(join(tmpdir(), 'ade-conformance-reference-'))
  try {
    const report = await runConformance({
      target: {
        command: process.execPath,
        args: [worker],
        env: { REFERENCE_WORKER_DIR: dir, ADE_CONFORMANCE_FAULTS: faults.join(',') },
      },
      fixture: {
        prompts,
        timeoutMs: 3_000,
        nativeSubmissions: async () =>
          (await readFile(join(dir, 'prompts.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).length,
      },
    })
    const failing = report.checks.filter((entry) => entry.status === 'fail').map((entry) => entry.id)
    return { report, failing, text: formatReport(report) }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('a conforming worker passes every check, and the report never claims native evidence', async () => {
  const { report, failing, text } = await check()
  assert.deepEqual(failing, [], text)
  assert.equal(report.counts.not_exercised, 0, text)
  assert.equal(report.passed, true)
  assert.equal(report.evidence, 'deterministic_fixture')
  assert.match(text, /not native, installed or live provider evidence/)
})

// Each fault breaks one documented behaviour; the harness must fail the check that owns it.
const faults = [
  ['descriptor', ['initialize.descriptor'], /requirements\.sdk_version is "0\.1\.0"/],
  ['accepts-v1', ['initialize.version_negotiation'], /got a success result/],
  ['missing-handler', ['operations.available_handled'], /compact is declared available but has no working handler/],
  [
    'unavailable-succeeds',
    ['operations.unavailable_refused'],
    /rewind is declared unsupported but got a success result/,
  ],
  ['resume-new-session', ['open.resume_same_session'], /returned session "ref-/],
  ['double-finished', ['send.turn_events', 'cancel.evidence', 'answer.retry_idempotent'], /the turn finished 2 times/],
  ['anonymous-events', ['send.turn_events'], /no finished event for submission conformance-reply/],
  ['retry-reruns', ['send.retry_idempotent'], /the native peer received 1 more prompt/],
  ['confirmed-cancel', ['cancel.evidence'], /termination is confirmed but the worker reported no terminal event/],
  ['accepts-unoffered', ['answer.unoffered_refused'], /an answer the request did not offer was accepted/],
  ['answer-reapplies', ['answer.retry_idempotent'], /resolved the request a second time/],
  ['invalid-event', ['frames.output_contract'], /event frame \d+ breaks the contract/],
  ['oversized-output', ['frames.output_contract'], /the declared output limit is 65536/],
  ['ignores-malformed', ['frames.input_limits'], /a malformed frame was silently ignored/],
  ['shutdown-settles', ['shutdown.pending_replies'], /shutdown reported the held prompt as finished successfully/],
  ['shutdown-hang', ['shutdown.pending_replies'], /was still running/],
]

describe('each fault fails the check that owns it', { concurrency: 4 }, () => {
  for (const [fault, expected, reason] of faults) {
    test(`a worker with fault ${fault} fails ${expected.join(', ')}`, async () => {
      const { report, failing, text } = await check([fault])
      assert.deepEqual(failing.sort(), [...expected].sort(), text)
      assert.equal(report.passed, false)
      const details = report.checks.filter((entry) => entry.status === 'fail').flatMap((entry) => entry.details)
      assert.ok(
        details.some((detail) => reason.test(detail)),
        text,
      )
    })
  }
})

test('a worker that cannot start fails initialize and exercises nothing else', async () => {
  const report = await runConformance({
    target: { command: join(tmpdir(), 'ade-conformance-no-such-worker') },
    fixture: { prompts, timeoutMs: 1_000 },
  })
  assert.deepEqual(
    report.checks.filter((entry) => entry.status === 'fail').map((entry) => entry.id),
    ['initialize.descriptor'],
  )
  assert.ok(
    report.checks
      .filter((entry) => entry.id !== 'initialize.descriptor')
      .every((entry) => entry.status === 'not_exercised'),
  )
})

test('the descriptor check mirrors the runtime host bounds', () => {
  assert.deepEqual(descriptorProblems({}).includes('required operation open is not declared'), true)
  const problems = descriptorProblems({
    protocol_version: 2,
    compatible_protocol_versions: [2],
    name: 'x',
    capabilities: [],
    permission_modes: ['plan'],
    operations: [{ method: 'send', tier: 'query', availability: 'unsupported', reason: '' }],
    limits: { max_concurrency: 1 },
    requirements: {},
  })
  for (const expected of [
    'operation send declares tier query; the contract tier is effect_command',
    'unavailable operation send gives no reason a person can act on',
    'permission_modes must start with default',
    'limits.max_concurrency must be at least 2',
    'limits.max_input_frame_bytes is undefined; it must be between 1 and 16777216',
  ])
    assert.ok(problems.includes(expected), `${expected} in ${JSON.stringify(problems)}`)
})

test('a ProviderFactory module runs under the SDK runner; undeclared behaviour is not exercised, not passed', async () => {
  const report = await runConformance({
    target: { factoryModule: factory, exportName: 'echoProvider' },
    fixture: { prompts: { reply: 'hello', hold: 'hold', request: 'ask' }, timeoutMs: 3_000 },
  })
  const text = formatReport(report)
  assert.deepEqual(report.counts.fail, 0, text)
  const skipped = report.checks.filter((entry) => entry.status === 'not_exercised').map((entry) => entry.id)
  assert.deepEqual(skipped, ['cancel.evidence', 'answer.unoffered_refused', 'answer.retry_idempotent'], text)
  assert.match(text, /SKIP {2}cancel\.evidence .*\n {6}not exercised: send or cancel is not declared available/)
})

test('the CLI reports per check and exits 1 on a failure, 2 on a usage error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ade-conformance-cli-'))
  try {
    const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
    const base = ['--reply', 'hello', '--hold', 'hold', '--timeout', '3000', '--env', `REFERENCE_WORKER_DIR=${dir}`]
    const passing = run([...base, '--', process.execPath, worker])
    assert.equal(passing.status, 0, passing.stdout + passing.stderr)
    assert.match(passing.stdout, /PASS {2}cancel\.evidence/)
    assert.match(passing.stdout, /SKIP {2}answer\.unoffered_refused/)
    const failing = run([
      ...base,
      '--env',
      'ADE_CONFORMANCE_FAULTS=accepts-unoffered,confirmed-cancel',
      '--json',
      '--',
      process.execPath,
      worker,
    ])
    assert.equal(failing.status, 1, failing.stderr)
    const report = JSON.parse(failing.stdout)
    assert.equal(report.checks.find((entry) => entry.id === 'cancel.evidence').status, 'fail')
    const usage = run(['--hold', 'hold'])
    assert.equal(usage.status, 2)
    assert.match(usage.stderr, /Usage: ade-provider-conformance/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
