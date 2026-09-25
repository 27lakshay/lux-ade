import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Subagents } from './subagents.mjs';
import { Bridge } from './bridge.mjs';
const start = { type: 'system', subtype: 'task_started', task_id: 'child', task_type: 'local_agent', tool_use_id: 'call', subagent_type: 'research', description: 'Inspect source' };
const end = { type: 'system', subtype: 'task_notification', task_id: 'child', tool_use_id: 'call', status: 'completed', summary: 'Inspected' };

test('Claude child completion survives parent turn ending without migrating to the next turn', () => {
  const tasks = new Subagents();
  const first = tasks.consume(start, 'first');
  assert.equal(first.content.agents[0].state, 'running');
  assert.equal(tasks.consume(start, 'first'), null);
  assert.equal(tasks.consume({ ...end, tool_use_id: 'unrelated' }, 'second'), null);
  const last = tasks.consume(end, 'second');
  assert.equal(last.id, first.id);
  assert.equal(last.turn, 'first');
  assert.equal(last.content.agents[0].summary, 'Inspected');
  assert.equal(tasks.consume(start, 'second'), null);
});

test('non-agent tasks and unknown notifications cannot become child agents', () => {
  const tasks = new Subagents();
  for (const task_type of ['local_bash', 'mcp_task', 'local_workflow', undefined]) assert.equal(tasks.consume({ ...start, task_type }, 'turn'), null);
  assert.equal(tasks.consume(end, 'turn'), null);
  tasks.consume(start, 'turn');
  assert.equal(tasks.consume({ ...end, status: 'stopped' }, null).content.agents[0].state, 'interrupted');
});

test('child messages cannot overwrite parent plans or enter its pending tool registry', () => {
  const bridge = new Bridge({}, () => {});
  assert.deepEqual(bridge.content({ type: 'assistant', parent_tool_use_id: 'spawn', message: { content: [
    { type: 'text', text: 'Child response' }, { type: 'tool_use', id: 'child-call', name: 'TodoWrite', input: { todos: [] } },
  ] } }, 'parent'), []);
  assert.equal(bridge.toolCalls.size, 0);
  assert.equal(bridge.todoCalls.size, 0);
});

test('child reader is paginated, parent scoped and excludes private thinking and image bytes', async () => {
  const calls = [];
  const sdk = {
    listSubagents: async session => { assert.equal(session, 'parent'); return ['child']; },
    getSubagentMessages: async (session, child, options) => {
      calls.push({ session, child, options });
      return Array.from({ length: 51 }, (_, i) => ({ uuid: `m${i}`, type: 'assistant', message: { content: [
        { type: 'text', text: `answer ${i}` }, { type: 'thinking', thinking: 'PRIVATE' }, { type: 'image', source: { data: 'SECRET' } },
      ] } }));
    },
  };
  const bridge = new Bridge(sdk, () => {});
  bridge.session = 'parent'; bridge.query = {};
  const page = await bridge.child_transcript({ session: 'parent', child: 'child', offset: 50 });
  assert.equal(page.next_offset, 100);
  assert.equal(page.items.length, 100);
  assert.equal(calls[0].options.limit, 51);
  assert.equal(calls[0].options.offset, 50);
  assert.ok(!JSON.stringify(page).includes('PRIVATE'));
  assert.ok(!JSON.stringify(page).includes('SECRET'));
  assert.equal(bridge.toolCalls.size, 0);
  await assert.rejects(bridge.child_transcript({ session: 'other', child: 'child' }), /parent/);
  await assert.rejects(bridge.child_transcript({ session: 'parent', child: '../child' }), /selector/);
  await assert.rejects(bridge.child_transcript({ session: 'parent', child: 'unknown' }), /not available/);
  assert.equal(calls.length, 1);
});


test('resumed Claude child keeps its identity and accepts the new invocation lifecycle', () => {
  const tasks = new Subagents();
  const first = tasks.consume(start, 'first');
  tasks.consume(end, 'first');
  const resumed = tasks.consume({ ...start, tool_use_id: 'resume-call', description: 'Continue inspecting' }, 'second');
  assert.equal(resumed?.content.agents[0].state, 'running');
  assert.equal(resumed.id, first.id);
  assert.equal(resumed.turn, first.turn);
  assert.equal(resumed.content.agents[0].id, 'child');
  assert.equal(resumed.content.agents[0].summary, 'Continue inspecting');
  assert.equal(tasks.consume(end, null), null, 'old invocation cannot finish the resumed child');
  const completed = tasks.consume({ ...end, tool_use_id: undefined, summary: 'Finished again' }, null);
  assert.equal(completed.id, first.id);
  assert.equal(completed.content.agents[0].state, 'completed');
  assert.equal(completed.content.agents[0].summary, 'Finished again');
  assert.equal(tasks.consume({ ...start, tool_use_id: 'resume-call' }, 'third'), null);
});

test('unrelated or unowned starts cannot reopen a completed Claude child', () => {
  const tasks = new Subagents();
  tasks.consume(start, 'first'); tasks.consume(end, 'first');
  for (const fields of [{ task_type: 'local_bash' }, { ambient: true }, { skip_transcript: true }, { tool_use_id: undefined }]) {
    assert.equal(tasks.consume({ ...start, tool_use_id: 'new-call', ...fields }, 'second'), null);
  }
  assert.equal(tasks.consume({ ...start, tool_use_id: 'new-call' }, null), null);
});
