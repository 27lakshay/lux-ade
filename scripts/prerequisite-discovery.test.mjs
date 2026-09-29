import assert from 'node:assert/strict'
import { test } from 'node:test'
import { discoveryArguments } from './prerequisite-discovery.mjs'

test('prerequisite discovery preserves selection and replaces every execution reporter', () => {
  assert.deepEqual(
    discoveryArguments([
      'test',
      '--config',
      'a.ts',
      'device',
      '--grep=F098',
      '--project',
      'native',
      '--shard=1/2',
      '--reporter',
      'html',
      '--reporter=line',
    ]),
    [
      'test',
      '--config',
      'a.ts',
      'device',
      '--grep=F098',
      '--project',
      'native',
      '--shard=1/2',
      '--list',
      '--reporter=json',
    ],
  )
  for (const args of [['test', '--last-failed'], ['test', '--ui'], ['merge-reports']])
    assert.throws(() => discoveryArguments(args))
})
