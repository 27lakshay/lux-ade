import assert from 'node:assert/strict'
import test from 'node:test'
import { expectedStaticStages, selectStaticStages, staticStageGroups } from './static-stage-groups.mjs'

const stages = Object.keys(staticStageGroups).map((name) => [name, ['echo', name], { reports: [`${name}.json`] }])

test('CI groups partition the complete local gate and retain each stage contract', () => {
  const javascript = selectStaticStages(stages, 'javascript')
  const native = selectStaticStages(stages, 'native')
  assert.deepEqual(selectStaticStages(stages), stages)
  assert.deepEqual(new Set([...javascript, ...native]), new Set(stages))
  assert.equal(
    javascript.some((stage) => native.includes(stage)),
    false,
  )
  for (const stage of [...javascript, ...native]) assert.ok(stages.includes(stage))
  assert.ok(expectedStaticStages('native').includes('rust doctests'))
  assert.ok(expectedStaticStages('javascript').includes('provider tests'))
  assert.ok(expectedStaticStages('javascript').includes('renderer tests'))
})

test('an unassigned, missing or duplicate stage fails every selection', () => {
  for (const group of ['all', 'javascript', 'native']) {
    assert.throws(() => selectStaticStages([...stages, ['new check', ['true']]], group), /Unassigned/)
    assert.throws(() => selectStaticStages(stages.slice(1), group), /Missing/)
    assert.throws(() => selectStaticStages([...stages, stages[0]], group), /Duplicate/)
  }
  assert.throws(() => selectStaticStages(stages, 'typo'), /Unknown/)
})
