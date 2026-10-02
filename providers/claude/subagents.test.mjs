import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BackgroundTasks, Subagents } from './subagents.mjs'
import { Transcript } from './transcript.mjs'
const start = {
  type: 'system',
  subtype: 'task_started',
  task_id: 'child',
  task_type: 'local_agent',
  tool_use_id: 'call',
  subagent_type: 'research',
  description: 'Inspect source',
}
const end = {
  type: 'system',
  subtype: 'task_notification',
  task_id: 'child',
  tool_use_id: 'call',
  status: 'completed',
  summary: 'Inspected',
}

test('Claude child completion survives parent turn ending without migrating to the next turn', () => {
  const tasks = new Subagents()
  const first = tasks.consume(start, { session: 'parent', turn: 'first' })
  assert.equal(first.content.agents[0].state, 'running')
  assert.equal(tasks.consume(start, { session: 'parent', turn: 'first' }), null)
  assert.equal(tasks.consume({ ...end, tool_use_id: 'unrelated' }, { session: 'parent', turn: 'second' }), null)
  const last = tasks.consume(end, { session: 'parent', turn: 'second' })
  assert.equal(last.id, first.id)
  assert.equal(last.turn, 'first')
  assert.equal(last.content.agents[0].summary, 'Inspected')
  assert.equal(tasks.consume(start, { session: 'parent', turn: 'second' }), null)
})

test('non-agent tasks and unknown notifications cannot become child agents', () => {
  const tasks = new Subagents()
  for (const task_type of ['local_bash', 'mcp_task', 'local_workflow', undefined])
    assert.equal(tasks.consume({ ...start, task_type }, { session: 'parent', turn: 'turn' }), null)
  assert.equal(tasks.consume(end, { session: 'parent', turn: 'turn' }), null)
  tasks.consume(start, { session: 'parent', turn: 'turn' })
  assert.equal(tasks.consume({ ...end, status: 'stopped' }, null).content.agents[0].state, 'interrupted')
})

test('child messages cannot overwrite parent plans or enter its pending tool registry', () => {
  const transcript = new Transcript('parent')
  const message = {
    type: 'assistant',
    parent_tool_use_id: 'spawn',
    message: {
      content: [
        { type: 'text', text: 'Child response' },
        { type: 'tool_use', id: 'child-call', name: 'TodoWrite', input: { todos: [] } },
      ],
    },
  }
  assert.deepEqual([...transcript.project(message)], [])
  assert.equal(transcript.calls.size, 0)
})

test('resumed Claude child keeps its identity and accepts the new invocation lifecycle', () => {
  const tasks = new Subagents()
  const first = tasks.consume(start, { session: 'parent', turn: 'first' })
  tasks.consume(end, { session: 'parent', turn: 'first' })
  const resumed = tasks.consume(
    { ...start, tool_use_id: 'resume-call', description: 'Continue inspecting' },
    { session: 'parent', turn: 'second' },
  )
  assert.equal(resumed?.content.agents[0].state, 'running')
  assert.equal(resumed.id, first.id)
  assert.equal(resumed.turn, first.turn)
  assert.equal(resumed.content.agents[0].id, 'child')
  assert.equal(resumed.content.agents[0].summary, 'Continue inspecting')
  assert.equal(tasks.consume(end, null), null, 'old invocation cannot finish the resumed child')
  const completed = tasks.consume({ ...end, tool_use_id: undefined, summary: 'Finished again' }, null)
  assert.equal(completed.id, first.id)
  assert.equal(completed.content.agents[0].state, 'completed')
  assert.equal(completed.content.agents[0].summary, 'Finished again')
  assert.equal(tasks.consume({ ...start, tool_use_id: 'resume-call' }, { session: 'parent', turn: 'third' }), null)
})

test('unrelated or unowned starts cannot reopen a completed Claude child', () => {
  const tasks = new Subagents()
  tasks.consume(start, { session: 'parent', turn: 'first' })
  tasks.consume(end, { session: 'parent', turn: 'first' })
  for (const fields of [
    { task_type: 'local_bash' },
    { ambient: true },
    { skip_transcript: true },
    { tool_use_id: undefined },
  ]) {
    assert.equal(
      tasks.consume({ ...start, tool_use_id: 'new-call', ...fields }, { session: 'parent', turn: 'second' }),
      null,
    )
  }
  assert.equal(tasks.consume({ ...start, tool_use_id: 'new-call' }, null), null)
})

test('background tasks count every native task type and report only changes', () => {
  const tasks = new BackgroundTasks()
  const system = (subtype, task_id, extra = {}) => ({ type: 'system', subtype, task_id, ...extra })
  assert.equal(tasks.observe(system('task_started', 'bash-1', { task_type: 'local_bash' })), 1)
  assert.equal(tasks.observe(system('task_started', 'agent-1', { task_type: 'local_agent' })), 2)
  assert.equal(tasks.observe(system('task_progress', 'bash-1')), null)
  assert.equal(tasks.observe(system('task_started', 'bash-1')), null)
  assert.equal(tasks.observe(system('task_notification', 'bash-1', { status: 'completed' })), 1)
  assert.equal(tasks.observe(system('task_notification', 'agent-1', { status: 'failed' })), 0)
  assert.equal(tasks.observe({ type: 'assistant' }), null)
})
