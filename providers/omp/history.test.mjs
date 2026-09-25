import { test, expect } from 'bun:test';
import { activeBranch, EntryHistory, projectHistory } from './history.mjs';

const user = (id, parentId, text) => ({ type: 'message', id, parentId, message: { role: 'user', content: text } });
const assistant = (id, parentId, content, extra = {}) => ({ type: 'message', id, parentId, message: { role: 'assistant', content, stopReason: 'stop', ...extra } });

test('phased plan updates preserve blocked and abandoned states, and ignore failed mutations',()=>{
  const phases=status=>[{name:'Build',tasks:[{content:'Compile',status,blocker:status==='blocked'?'Missing SDK':undefined},{content:'Old task',status:'abandoned'}]}];
  const entries=[user('user',null,'build')];
  const todo=(id,status,isError=false,op='block')=>({type:'message',id,parentId:entries.at(-1).id,message:{role:'toolResult',toolCallId:id,toolName:'todo',content:[{type:'text',text:'updated'}],isError,details:{op,phases:phases(status)}}});
  entries.push(todo('first','in_progress'));
  entries.push(todo('second','blocked'));
  entries.push(todo('failed','completed',true));
  entries.push(todo('view','completed',false,'view'));
  let plans=projectHistory({entries,leafId:'view'}).items.filter(i=>i.kind==='plan');
  expect(plans.length).toBe(1);
  expect(plans[0].content.steps).toEqual([{step:'Build: Compile — Missing SDK',status:'blocked'},{step:'Build: Old task',status:'abandoned'}]);
  entries.push({type:'custom',customType:'user_todo_edit',id:'manual',parentId:'view',data:{phases:phases('completed')}});
  plans=projectHistory({entries,leafId:'manual'}).items.filter(i=>i.kind==='plan');
  expect(plans.length).toBe(1);expect(plans[0].content.steps[0].status).toBe('completed');
});

test('follows active ancestry rather than append order or identical user text', () => {
  const entries = [user('a', null, 'same'), assistant('old', 'a', [{ type: 'text', text: 'abandoned' }]), user('b', 'a', 'same')];
  const identities = new Map([['b', { turn: 'turn-b', submission: 'ade-b' }]]);
  const projection = projectHistory({ entries, leafId: 'b' }, identities);
  expect(projection.items.map(item => item.id)).toEqual(['a', 'turn-b']);
  expect(projection.items.map(item => item.client_id)).toEqual([null, 'ade-b']);
  expect(projection.lastTurn).toBe('turn-b');
});

test('rejects incomplete, duplicate and cyclic ancestry', () => {
  expect(() => activeBranch({ entries: [user('a', 'missing', 'x')], leafId: 'a' })).toThrow('incomplete');
  expect(() => activeBranch({ entries: [user('a', null, 'x'), user('a', null, 'x')], leafId: 'a' })).toThrow('duplicate');
  expect(() => activeBranch({ entries: [user('a', 'b', 'x'), user('b', 'a', 'x')], leafId: 'a' })).toThrow('cycle');
});

test('projects tool output and failure without private thinking or image bytes', () => {
  const entries = [user('u', null, [{ type: 'image', mimeType: 'image/png', data: 'SECRET_IMAGE_BYTES' }]),
    assistant('a', 'u', [{ type: 'thinking', thinking: 'PRIVATE' }, { type: 'text', text: 'Visible' }, { type: 'toolCall', id: 'tc', name: 'read', arguments: { path: 'a' } }], { stopReason: 'error', errorMessage: 'Failed' }),
    { type: 'message', id: 'r', parentId: 'a', message: { role: 'toolResult', toolCallId: 'tc', content: [{ type: 'text', text: 'Missing file' }], isError: true } }];
  const { items } = projectHistory({ entries, leafId: 'r' });
  expect(JSON.stringify(items)).not.toContain('PRIVATE');
  expect(JSON.stringify(items)).not.toContain('SECRET_IMAGE_BYTES');
  expect(items.find(item => item.id === 'a:1').status).toBe('failed');
  expect(items.at(-1).text).toBe('Missing file');
  const call=items.find(item=>item.content?.input?.path==='a');
  assertToolFailure(call,items.at(-1));
  expect(projectHistory({ entries, leafId: 'r' }).items).toEqual(items);
});

function assertToolFailure(call,result) {
  expect(call.content.call_id).toBe(result.content.call_id);
  expect(call.status).toBe('failed');expect(result.content.is_error).toBe(true);
}

test('clear boundary does not resurrect old transcript on resume', () => {
  const entries = [user('old', null, 'Before clear'), { type: 'reset_boundary', id: 'reset', parentId: 'old' }, user('new', 'reset', 'After clear')];
  expect(projectHistory({ entries, leafId: 'new' }).items.map(item => item.id)).toEqual(['new']);
});

test('incremental history retains abandoned ancestors and handles leaf-only changes', async () => {
  const responses = [
    { entries: [user('a', null, 'root'), user('old', 'a', 'old branch')], leafId: 'old' },
    { entries: [user('new', 'a', 'new branch')], leafId: 'new' },
    { entries: [], leafId: 'old' },
  ];
  const cursors = [];
  const history = new EntryHistory({ request: async (type, fields) => { cursors.push(fields.since); return responses.shift(); } });
  await history.refresh();
  expect(projectHistory(await history.refresh()).items.map(item => item.id)).toEqual(['a', 'new']);
  expect(projectHistory(await history.refresh()).items.map(item => item.id)).toEqual(['a', 'old']);
  expect(cursors).toEqual([undefined, 'old', 'new']);
});

test('a malformed incremental read cannot advance the history cursor', async () => {
  const responses = [
    { entries: [user('a', null, 'root')], leafId: 'a' },
    { entries: [user('b', 'missing', 'broken')], leafId: 'b' },
    { entries: [user('b', 'a', 'valid')], leafId: 'b' },
  ];
  const history = new EntryHistory({ request: async () => responses.shift() });
  await history.refresh();
  await expect(history.refresh()).rejects.toThrow('incomplete');
  expect(history.cursor).toBe('a');
  expect(projectHistory(await history.refresh()).items.map(item => item.id)).toEqual(['a', 'b']);
});
