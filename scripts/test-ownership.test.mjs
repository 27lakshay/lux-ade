import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateOwnership } from './test-ownership.mjs'

const base = () => ({ files: ['a.test.mjs'], suites: [{ name: 'node', files: ['a.test.mjs'] }] })

test('a new test outside runner discovery fails ownership', () => {
  const input = base()
  input.files.push('new.test.ts')
  assert.deepEqual(validateOwnership(input), ['Unassigned test file: new.test.ts'])
})
test('missing discovery entries and empty required suites fail', () => {
  assert.deepEqual(validateOwnership({ files: [], suites: base().suites }), [
    'node: discovered missing test file a.test.mjs',
  ])
  assert.deepEqual(validateOwnership({ files: [], suites: [{ name: 'node', files: [] }] }), [
    'Empty required suite: node',
  ])
})
test('an exclusion must still exist, be unowned and explain its scope', () => {
  assert.deepEqual(
    validateOwnership({
      files: ['old.py'],
      suites: [],
      exclusions: [
        {
          file: 'old.py',
          reason: 'Retained compatibility check for the previous native UI; not current desktop evidence.',
        },
      ],
    }),
    [],
  )
  assert.ok(
    validateOwnership({ ...base(), exclusions: [{ file: 'gone.py', reason: 'old' }] }).includes(
      'Stale exclusion: gone.py',
    ),
  )
  assert.ok(
    validateOwnership({ ...base(), exclusions: [{ file: 'a.test.mjs', reason: '' }] }).includes(
      'Exclusion needs a reason: a.test.mjs',
    ),
  )
  assert.ok(
    validateOwnership({ ...base(), exclusions: [{ file: 'a.test.mjs', reason: 'old' }] }).includes(
      'Excluded file is also owned: a.test.mjs',
    ),
  )
})
test('only documented intentional overlaps are accepted', () => {
  const input = base()
  input.suites.push({ name: 'faults', files: ['a.test.mjs'] })
  assert.deepEqual(validateOwnership(input), ['Conflicting ownership: a.test.mjs (node, faults)'])
  assert.deepEqual(
    validateOwnership({
      ...input,
      overlaps: [{ suites: ['node', 'faults'], reason: 'Faults are an intentional subset.' }],
    }),
    [],
  )
  assert.ok(
    validateOwnership({ ...base(), overlaps: [{ suites: ['node', 'missing'], reason: 'old subset' }] }).includes(
      'Overlap names missing suite: missing',
    ),
  )
})
test('stale overlap rules and duplicate suite definitions fail', () => {
  const input = {
    files: ['a', 'b'],
    suites: [
      { name: 'a', files: ['a'] },
      { name: 'b', files: ['b'] },
    ],
  }
  assert.deepEqual(validateOwnership({ ...input, overlaps: [{ suites: ['a', 'b'], reason: 'obsolete' }] }), [
    'Stale overlap: a, b',
  ])
  assert.ok(
    validateOwnership({ ...base(), suites: [...base().suites, ...base().suites] }).includes('Duplicate suite: node'),
  )
})
