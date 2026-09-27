import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskPlans } from './tasks.mjs'

const call = (plans, id, name, input, output, error = false) => {
  plans.start({ id, name, input }, 'turn')
  return plans.result({ tool_use_id: id, is_error: error }, output)
}
const create = (plans, id, subject) => call(plans, `create-${id}`, 'TaskCreate', { subject }, { task: { id, subject } })

test('successful task mutations retain IDs, dependencies, completion and deletion', () => {
  const plans = new TaskPlans()
  create(plans, '1', 'Build')
  create(plans, '2', 'Test')
  let plan = call(plans, 'block', 'TaskUpdate', { taskId: '2', addBlockedBy: ['1'] }, { success: true, taskId: '2' })
  assert.equal(plan.content.steps[1].status, 'blocked')
  plan = call(plans, 'done', 'TaskUpdate', { taskId: '1', status: 'completed' }, { success: true, taskId: '1' })
  assert.equal(plan.content.steps[1].status, 'pending')
  assert.equal(plan.content.steps[0].status, 'completed')
  plan = call(plans, 'delete', 'TaskUpdate', { taskId: '2', status: 'deleted' }, { success: true, taskId: '2' })
  assert.equal(plan.content.steps.length, 1)
})

test('tool-level and application-level failures do not mutate the task plan', () => {
  const plans = new TaskPlans()
  create(plans, '1', 'Build')
  assert.equal(
    call(plans, 'failed', 'TaskUpdate', { taskId: '1', status: 'completed' }, { success: false, taskId: '1' }),
    null,
  )
  assert.equal(call(plans, 'error', 'TaskUpdate', { taskId: '1', status: 'completed' }, null, true), null)
  assert.equal(plans.tasks.get('1').status, 'pending')
})

test('SDK history lacking task metadata replays identically from durable result receipts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ade-claude-tasks-'))
  try {
    const live = new TaskPlans()
    live.open('session', directory)
    create(live, '1', 'Build')
    const final = call(
      live,
      'update',
      'TaskUpdate',
      { taskId: '1', status: 'completed' },
      { success: true, taskId: '1' },
    )
    const replay = new TaskPlans()
    replay.open('session', directory)
    call(replay, 'create-1', 'TaskCreate', { subject: 'Build' })
    const restored = call(replay, 'update', 'TaskUpdate', { taskId: '1', status: 'completed' })
    assert.deepEqual(restored, final)
    const other = new TaskPlans()
    other.open('other-session', directory)
    assert.equal(call(other, 'create-1', 'TaskCreate', { subject: 'Build' }), null)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('empty TaskList clears the plan and TaskGet refreshes a known task', () => {
  const plans = new TaskPlans()
  create(plans, '1', 'Build')
  const refreshed = call(
    plans,
    'get',
    'TaskGet',
    { taskId: '1' },
    { task: { id: '1', subject: 'Build now', status: 'in_progress', blockedBy: [] } },
  )
  assert.equal(refreshed.content.steps[0].status, 'inProgress')
  const removed = call(plans, 'missing', 'TaskGet', { taskId: '1' }, { task: null })
  assert.deepEqual(removed.content.steps, [])
  create(plans, '2', 'Other task')
  const cleared = call(plans, 'list', 'TaskList', {}, { tasks: [] })
  assert.deepEqual(cleared.content.steps, [])
})

test('mismatched task ID and malformed result do not report success', () => {
  const plans = new TaskPlans()
  create(plans, '1', 'Build')
  assert.throws(
    () => call(plans, 'wrong', 'TaskUpdate', { taskId: '1', status: 'completed' }, { success: true, taskId: '2' }),
    /different task ID/,
  )
  assert.throws(
    () => call(plans, 'invalid', 'TaskList', {}, { tasks: [{ id: '3', subject: 'Bad', status: 'unknown' }] }),
    /Invalid Claude task/,
  )
  assert.equal(plans.tasks.get('1').status, 'pending')
})
