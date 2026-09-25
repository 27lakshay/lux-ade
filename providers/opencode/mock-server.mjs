#!/usr/bin/env node
// HTTP/SSE provider fixture: the real lux-ade bridge and Rust adapter stay in use.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spec } from './protocol-fixture.mjs';

const directory = process.env.ADE_MOCK_OPENCODE_DIR;
if (!directory) throw new Error('Missing fixture directory');
mkdirSync(directory, { recursive: true });
const auth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString('base64')}`;
const sessions = new Map(); const subscribers = new Set();
const file = (id) => join(directory, `${id}.json`);
const save = (session) => writeFileSync(file(session.id), JSON.stringify(session));
const load = (id) => {
  if (!sessions.has(id) && existsSync(file(id))) sessions.set(id, JSON.parse(readFileSync(file(id), 'utf8')));
  return sessions.get(id);
};
const event = (session, type, data = {}) => {
  const value = { id: `evt_${randomUUID()}`, type, data: { sessionID: session.id, ...data } };
  for (const response of subscribers) response.write(`data: ${JSON.stringify(value)}\n\n`);
};
const finish = (session, outcome = 'succeeded') => {
  if (!session.active) return;
  session.active = false; session.permissions = []; session.forms = [];
  if (outcome === 'succeeded') {
    const assistant = { id: `msg_${randomUUID()}`, type: 'assistant', time: { created: Date.now(), completed: Date.now() }, content: [{ type: 'text', text: 'Hello OpenCode' }] };
    if (session.messages.findLast(message => message.type === 'user')?.text === 'typed-subagents') {
      const child = { id: 'ses_fixture_child', parentID: session.id, location: session.location, messages: [
        { id: 'msg_child_answer', type: 'assistant', time: { completed: 1 }, content: [{ type: 'text', text: 'Child OpenCode transcript' }] },
        ...Array.from({length:54},(_,i)=>({id:`msg_child_${i}`,type:'assistant',time:{completed:1},content:[{type:'text',text:`Child page message ${i}`}]})),
      ], inbox: [], permissions: [], forms: [], active: false };
      sessions.set(child.id, child); save(child);
      assistant.content.push({ type: 'tool', id: 'spawn_fixture', name: 'subagent', state: { status: 'completed', input: { agent: 'research' },
        metadata: { sessionID: 'ses_fixture_child', status: 'running' }, content: [{ type: 'text', text: 'Working in the background' }] } });
    }
    session.messages.push(assistant);
    event(session, 'session.text.started', { assistantMessageID: assistant.id, ordinal: 0 });
    event(session, 'session.text.delta', { assistantMessageID: assistant.id, ordinal: 0, delta: 'Hello ' });
    event(session, 'session.text.delta', { assistantMessageID: assistant.id, ordinal: 0, delta: 'OpenCode' });
    event(session, 'session.text.ended', { assistantMessageID: assistant.id, ordinal: 0, text: 'Hello OpenCode' });
  }
  session.messages.push({ id: `msg_${randomUUID()}`, type: 'idle', outcome }); save(session);
  event(session, `session.execution.${outcome}`);
};

const server = createServer(async (request, response) => {
  const json = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(value === undefined ? undefined : JSON.stringify(value)); };
  try {
    if (request.headers.authorization !== auth) return json(401, {});
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (url.pathname === '/openapi.json') return json(200, spec(false));
    if (url.pathname === '/api/info') return json(404, {});
    if (url.pathname === '/api/health') return json(200, { healthy: true, version: '2.0.3', pid: process.pid });
    if (url.pathname === '/api/event') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"type":"server.connected","data":{}}\n\n');
      subscribers.add(response); request.on('close', () => subscribers.delete(response)); return;
    }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (url.pathname === '/api/session/active') return json(200, { data: Object.fromEntries([...sessions.values()].filter((s) => s.active).map((s) => [s.id, { type: 'running' }])) });
    if (url.pathname === '/api/session' && request.method === 'POST') {
      const session = { id: `ses_${randomUUID()}`, location: body.location, messages: [], inbox: [], permissions: [], forms: [], active: false };
      sessions.set(session.id, session); save(session); return json(200, { data: session });
    }
    const session = load(path[2]); if (!session) return json(404, {});
    if (path.length === 3) return json(200, { data: session });
    if (request.method === 'GET' && path[3] === 'message') {
      if (path[4]) { const message = session.messages.find((m) => m.id === path[4]); return json(message ? 200 : 404, { data: message }); }
      const start = Number((url.searchParams.get('cursor')??'fixture:0').split(':')[1]);
      const limit = Number(url.searchParams.get('limit')??200);
      const ordered = url.searchParams.get('order') === 'desc' ? [...session.messages].reverse() : session.messages;
      return json(200, { data: ordered.slice(start,start+limit), cursor: start+limit<ordered.length?{next:`fixture:${start+limit}`} : {} });
    }
    if (path[3] === 'inbox' && request.method === 'DELETE') { session.inbox = session.inbox.filter((entry) => entry.id !== path[4]); save(session); return json(204); }
    if (request.method === 'GET') {
      const key = { inbox: 'inbox', permission: 'permissions', form: 'forms' }[path[3]];
      if (key) return json(200, { data: session[key] });
    }
    if (path[3] === 'prompt') {
      const existing = session.inbox.find((entry) => entry.id === body.id);
      const entry = existing ?? { id: body.id, sessionID: session.id, type: 'user', delivery: body.delivery, payload: { text: body.text, metadata: body.metadata } };
      if (body.resume === false) { if (!existing) session.inbox.push(entry); save(session); return json(200, { data: entry }); }
      session.inbox = session.inbox.filter((item) => item.id !== entry.id);
      session.messages.push({ id: body.id, type: 'user', text: body.text, metadata: body.metadata }); session.active = true;
      if (body.text === 'approval') session.permissions = [{ id: 'per_fixture', action: 'bash', resources: ['echo fixture'] }];
      if (body.text === 'questions') session.forms = [{ id: 'frm_fixture', title: 'Fixture', fields: [{ type: 'string', key: 'choice', title: 'Choose a value' }] }];
      save(session); json(200, { data: entry }); event(session, 'session.inbox.delivered', { inboxID: body.id });
      if (!['approval', 'questions', 'hold'].includes(body.text)) setTimeout(() => finish(session), 40);
      return;
    }
    if (path[3] === 'interrupt') { finish(session, 'interrupted'); return json(200, { interrupted: true }); }
    if (path[3] === 'permission' || path[3] === 'form') { json(204); finish(session); return; }
    json(404, {});
  } catch { json(500, {}); }
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` })));
process.stdin.resume();
process.stdin.on('end', () => { server.closeAllConnections(); server.close(); });
