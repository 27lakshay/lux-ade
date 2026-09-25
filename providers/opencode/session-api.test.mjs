import { test } from 'node:test';
import assert from 'node:assert/strict';
import { protocol, SessionApi } from './session-api.mjs';

import { spec } from './protocol-fixture.mjs';

test('child pages verify native parent ownership before fetching any messages', async () => {
  const calls = [];
  let parentID = 'ses_parent';
  const api = new SessionApi({ request: async (method, path) => {
    calls.push([method, path]);
    if (!path.includes('/message')) return { data: { id: 'ses_child', parentID } };
    assert.equal(new URL(path,'http://fixture').searchParams.get('cursor'),'native-cursor');
    assert.equal(new URL(path,'http://fixture').searchParams.has('order'),false);
    return { data: Array.from({ length: 50 }, (_, i) => ({ id: `msg_${i+5000}`, type: 'user', text: String(i+5000) })), cursor: { next: 'following-cursor' } };
  } }, {});
  const page = await api.childMessages('ses_parent', 'ses_child', 'native-cursor');
  assert.equal(page.messages[0].text, '5000');
  assert.equal(page.messages.at(-1).text, '5049');
  assert.equal(page.next_cursor, 'following-cursor');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([method]) => method === 'GET'));
  calls.length = 0; parentID = 'ses_other';
  await assert.rejects(api.childMessages('ses_parent', 'ses_child', null), /does not belong/);
  assert.equal(calls.length, 1);
  await assert.rejects(api.childMessages('ses_parent', 'ses_child', 'x'.repeat(4097)), /cursor/);
  assert.equal(calls.length, 1);
});

for (const current of [false, true]) {
  test(`schema chooses explicit permission, interrupt and form operations (${current ? 'clone' : 'installed'})`, async () => {
    const calls = [];
    const api = new SessionApi({ request: async (...args) => { calls.push(args); } }, protocol(spec(current)));
    await api.permission('ses_test', 'per_test', 'accept');
    await api.permission('ses_test', 'per_test', 'decline');
    await api.interrupt('ses_test');
    await api.form('ses_test', 'frm_test', null);
    await api.form('ses_test', 'frm_test', { name: 'answer', choice: ['a'] });
    assert.deepEqual(calls[0][2], { [current ? 'decision' : 'reply']: 'once' });
    assert.deepEqual(calls[1][2], { [current ? 'decision' : 'reply']: 'reject' });
    assert.equal(calls[2][1], `/api/session/ses_test/interrupt?${current ? 'resume' : 'continue'}=false`);
    assert.equal(calls[3][0], current ? 'DELETE' : 'POST');
    assert.equal(calls[3][1], `/api/session/ses_test/form/frm_test${current ? '' : '/cancel'}`);
    assert.deepEqual(calls[4][2], { answer: { name: 'answer', choice: ['a'] } });
  });
}

test('unknown protocol is rejected before a mutation', () => {
  const unknown = spec(true);
  unknown.components.schemas['Permission.Reply'].enum = ['allow', 'deny'];
  assert.throws(() => protocol(unknown), /permission reply contract/);
  delete unknown.paths['/api/session/{sessionID}/permission/{requestID}/reply'];
  assert.throws(() => protocol(unknown), /lacks required/);
});

test('history follows opaque cursors without combining cursor and order', async () => {
  const urls = [];
  const api = new SessionApi({ request: async (method, path) => {
    urls.push(new URL(path, 'http://localhost'));
    return urls.length === 1 ? { data: [{ id: 'msg_a' }], cursor: { next: '+opaque/=' } } : { data: [{ id: 'msg_b' }], cursor: {} };
  } }, {});
  assert.deepEqual(await Array.fromAsync(api.messages('ses_test')), [{ id: 'msg_a' }, { id: 'msg_b' }]);
  assert.equal(urls[0].searchParams.get('order'), 'asc');
  assert.equal(urls[1].searchParams.has('order'), false);
  assert.equal(urls[1].searchParams.get('cursor'), '+opaque/=');
});

test('history rejects repeated cursors rather than spinning forever', async () => {
  const api = new SessionApi({ request: async () => ({ data: [], cursor: { next: 'same' } }) }, {});
  await assert.rejects(Array.fromAsync(api.messages('ses_test')), /repeated/);
});

test('uncertain or cancelled admission cannot be silently recreated', async () => {
  const calls = [];
  const api = new SessionApi({ request: async (method, path) => {
    calls.push(method);
    if (path.endsWith('/inbox')) return { data: [] };
    throw Object.assign(new Error('Not found'), { status: 404 });
  } }, {});
  await assert.rejects(api.submit('ses_test', { id: 'msg_test', submission: 'ade_test', text: 'hello', retry: true }), /refusing to replay/);
  assert.deepEqual(calls, ['GET', 'GET']);
});

test('a lost admission response is reconciled by immutable identity, not a new prompt', async () => {
  let admitted;
  let delivered = false;
  let posts = 0;
  const api = new SessionApi({ request: async (method, path, body) => {
    if (method === 'POST') {
      posts++;
      admitted = { id: body.id, sessionID: 'ses_test', payload: { text: body.text, metadata: body.metadata } };
      throw new Error('Response lost');
    }
    if (path.endsWith('/inbox')) return { data: admitted && !delivered ? [admitted] : [] };
    if (delivered) return { data: { id: admitted.id, ...admitted.payload } };
    throw Object.assign(new Error('Not found'), { status: 404 });
  } }, {});
  const input = { id: 'msg_test', submission: 'ade_test', text: 'hello' };
  await assert.rejects(api.submit('ses_test', input), /Response lost/);
  assert.equal((await api.submit('ses_test', { ...input, retry: true })).id, input.id);
  await assert.rejects(api.submit('ses_test', { ...input, text: 'changed', retry: true }), /different payload/);
  assert.equal(posts, 1);
  delivered = true;
  assert.equal((await api.submit('ses_test', { ...input, retry: true })).delivered, true);
  assert.equal(posts, 1);
});

test('resume errors never create a replacement session', async () => {
  const methods = [];
  const api = new SessionApi({ request: async (method) => {
    methods.push(method);
    throw Object.assign(new Error('Not found'), { status: 404 });
  } }, {});
  await assert.rejects(api.open({ resume: 'ses_missing', cwd: '/project' }), /Not found/);
  assert.deepEqual(methods, ['GET']);
});
