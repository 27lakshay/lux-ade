// Pure-core tests for the API parity decision (AGENTS.md test policy).
// node --test scripts/api-parity.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeParity, sdkIndependence } from './api-parity.mjs'

const operations = {
  'thing.list': { domain: 'things', tier: 'query', request: 'ThingListRequest', response: 'ThingList' },
  'thing.remove': { domain: 'things', tier: 'effect_command', request: 'ThingRemoveRequest', response: 'Ack' },
  'owner.register': { domain: 'things', tier: 'idempotent_command', request: 'OwnerRegisterRequest', response: 'Ack' },
}
const validators = new Set(['ThingListRequest', 'ThingList', 'ThingRemoveRequest', 'OwnerRegisterRequest', 'Ack'])
const exemptions = { 'owner.register': 'Only the owner process calls it' }
const generic = 'cli/request.ts'

function parity(cliSources, overrides = {}) {
  return computeParity({ operations, validators, exemptions, genericModule: generic, cliSources, ...overrides })
}

test('every operation exposed or exempt passes, with one row per operation', () => {
  const { rows, failures } = parity({
    'cli/things.ts': "call(socketPath, 'thing.list', {})\nconst op = flag ? 'thing.remove' : 'thing.list'",
  })
  assert.deepEqual(failures, [])
  assert.deepEqual(rows.map((row) => [row.name, row.cli, row.exemption, row.sdk]), [
    ['owner.register', [], 'Only the owner process calls it', true],
    ['thing.list', ['cli/things.ts'], null, true],
    ['thing.remove', ['cli/things.ts'], null, true],
  ])
})

test('a new operation without a CLI command fails', () => {
  const { failures } = parity({ 'cli/things.ts': "call(socketPath, 'thing.list', {})" })
  assert.equal(failures.length, 1)
  assert.match(failures[0], /^thing\.remove: no CLI command/)
})

test('the generic request command does not count as a named command', () => {
  const { failures } = parity({ [generic]: "'thing.list' 'thing.remove'" })
  assert.equal(failures.filter((failure) => failure.includes('no CLI command')).length, 2)
})

test('an operation without generated validators is not SDK-callable', () => {
  const { rows, failures } = parity({ 'cli/things.ts': "'thing.list' 'thing.remove'" },
    { validators: new Set(['ThingListRequest', 'ThingList', 'OwnerRegisterRequest', 'Ack']) })
  assert.equal(rows.find((row) => row.name === 'thing.remove').sdk, false)
  assert.match(failures.join('\n'), /thing\.remove: no generated validator/)
})

test('dynamic operation names, unknown operation literals and stale exemptions fail', () => {
  const { failures } = parity({
    'cli/things.ts': "'thing.list' 'thing.remove' 'owner.register'\nrequestDaemon(socketPath, `thing.${action}`, {})\n" +
      "dailyUseCommand(socketPath, { op: 'thing.lsit' })",
  }, { exemptions: { ...exemptions, 'no.such': 'gone' } })
  assert.equal(failures.length, 4)
  assert.match(failures.join('\n'), /builds an operation name dynamically/)
  assert.match(failures.join('\n'), /'thing\.lsit' is not an operation/)
  assert.match(failures.join('\n'), /exemption owner\.register is stale/)
  assert.match(failures.join('\n'), /exemption no\.such names no operation/)
})

test('the SDK must not depend on React or Electron', () => {
  assert.deepEqual(sdkIndependence({ dependencies: { '@ade/contracts': '1' } },
    { 'src/a.ts': "import { x } from './b.js'\nimport type { Y } from '@ade/contracts'" }), [])
  assert.equal(sdkIndependence({ dependencies: { react: '19' }, devDependencies: { electron: '38' } },
    { 'src/a.ts': "import { app } from 'electron/main'\nconst r = await import('react-dom')" }).length, 4)
})
