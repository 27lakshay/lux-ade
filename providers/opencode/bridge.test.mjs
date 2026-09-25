import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Bridge } from './bridge.mjs';

class Provider {
  constructor() {
    this.log = []; this.history = []; this.eventsQueue = []; this.wake = null; this.streams = 0;
    this.state = { inbox: [], permissions: [], forms: [], active: false };
  }
  emit(type, data = {}) { this.eventsQueue.push({ id: `evt_${this.log.length}_${Math.random()}`, type, data: { sessionID: 'ses_test', ...data } }); this.wake?.(); }
  async *events({ signal }) {
    this.streams++;
    yield { type: 'server.connected', data: {} };
    while (!signal.aborted) {
      if (this.eventsQueue.length) {
        const event = this.eventsQueue.shift();
        if (event.type === 'disconnect') throw new Error('Connection lost');
        yield event; continue;
      }
      await new Promise((resolve) => {
        const done = () => { signal.removeEventListener('abort', done); this.wake = null; resolve(); };
        this.wake = done; signal.addEventListener('abort', done, { once: true });
        if (signal.aborted) done();
      });
    }
  }
  async open() { return { id: 'ses_test' }; }
  async *messages(session, { order }) { yield* structuredClone(order === 'desc' ? [...this.history].reverse() : this.history); }
  async pending() { return structuredClone(this.state); }
  async submit(session, input) {
    this.log.push(['submit', input]); this.state.active = true;
    this.history.push({ id: input.id, type: 'user', text: input.text, metadata: { ade_submission: input.submission } });
    return { id: input.id, sessionID: session };
  }
  async permission(session, id, decision) { this.log.push(['permission', id, decision]); this.state.permissions = []; }
  async form(session, id, answers) { this.log.push(['form', id, answers]); this.state.forms = []; }
  async cancelQueued(session, id) { this.log.push(['cancelQueued', id]); this.state.inbox = this.state.inbox.filter((item) => item.id !== id); }
  async interrupt() { this.log.push(['interrupt']); this.state.active = false; return { interrupted: true }; }
  async resumeQueued(session, id) { this.log.push(['resumeQueued', id]); this.state.inbox = []; this.state.active = true; }
  async stop() { this.log.push(['stop']); }
}

async function setup(provider = new Provider()) {
  const output = [];
  const bridge = new Bridge((frame) => output.push(frame.params), { cwd: '/fixture', connect: async () => ({ transport: provider, api: provider }) });
  await bridge.open({ config: {} });
  return { provider, bridge, output };
}
async function wait(check) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) { const value = check(); if (value) return value; await delay(10); }
  throw new Error('Timed out');
}
const send = (bridge) => bridge.send({ session: 'ses_test', submission: 'ade_one', message_id: 'msg_one', text: 'hello' });

test('bridge projects live text and finishes only after durable idle', async () => {
  const { provider, bridge, output } = await setup();
  try {
    await send(bridge);
    const data = { assistantMessageID: 'msg_answer', ordinal: 0 };
    provider.emit('session.text.started', data);
    provider.emit('session.text.delta', { ...data, delta: 'hello' });
    provider.emit('session.text.ended', { ...data, text: 'hello' });
    provider.history.push({ id: 'msg_answer', type: 'assistant', time: { completed: 1 }, content: [{ type: 'text', text: 'hello' }] });
    await wait(() => output.some((event) => event.type === 'delta'));
    await bridge.refresh();
    assert.equal(output.some((event) => event.type === 'finished'), false);
    provider.history.push({ id: 'msg_idle', type: 'idle', outcome: 'succeeded' }); provider.state.active = false;
    await bridge.refresh();
    assert.equal(output.filter((event) => event.type === 'finished').length, 1);
    assert.equal(output.find((event) => event.type === 'finished').turn, 'msg_one');
    assert.equal(output.find((event) => event.type === 'item' && event.item.role === 'user').item.client_id, 'ade_one');
  } finally { await bridge.close(); }
});

test('permissions and questions are answered once and stale answers fail', async () => {
  const { provider, bridge, output } = await setup();
  try {
    await send(bridge);
    provider.state.permissions = [{ id: 'per_one', action: 'bash', resources: ['echo hello'] }];
    provider.state.forms = [{ id: 'frm_one', title: 'Choose', fields: [{ key: 'name', type: 'string', title: 'Name' }] }];
    await bridge.refresh(); await bridge.refresh();
    assert.equal(output.filter((event) => event.type === 'request').length, 2);
    await bridge.answer({ id: 'per_one', decision: 'decline' });
    await bridge.answer({ id: 'frm_one', decision: 'answer', answers: { name: 'Alice' } });
    await assert.rejects(bridge.answer({ id: 'per_one', decision: 'accept' }), /stale/);
    assert.equal(provider.log.filter((entry) => entry[0] === 'permission').length, 1);
    assert.deepEqual(provider.log.find((entry) => entry[0] === 'form')[2], { name: 'Alice' });
  } finally { await bridge.close(); }
});

for (const decision of ['accept', 'decline']) {
  test(`recovered admission waits for explicit ${decision} and never resubmits`, async () => {
    const provider = new Provider();
    provider.state.inbox = [{ id: 'msg_parked', type: 'user', payload: { text: 'parked', metadata: { ade_submission: 'ade_parked' } } }];
    const { bridge, output } = await setup(provider);
    try {
      const request = output.find((event) => event.type === 'request');
      assert.equal(request.method, 'opencode/recover');
      assert.equal(provider.log.length, 0);
      await assert.rejects(send(bridge), /active turn/);
      await bridge.answer({ id: request.id, decision });
      assert.equal(provider.log.some((entry) => entry[0] === 'submit'), false);
      assert.equal(provider.log.some((entry) => entry[0] === (decision === 'accept' ? 'resumeQueued' : 'cancelQueued')), true);
    } finally { await bridge.close(); }
  });
}

test('reconnect reloads durable completion without replaying submission', async () => {
  const { provider, bridge, output } = await setup();
  try {
    await send(bridge);
    provider.emit('disconnect');
    await wait(() => bridge.epoch === 1);
    provider.history.push({ id: 'msg_idle', type: 'idle', outcome: 'failed' }); provider.state.active = false;
    await wait(() => provider.streams === 2);
    await wait(() => output.some((event) => event.type === 'finished'));
    assert.equal(output.find((event) => event.type === 'finished').status, 'failed');
    assert.equal(provider.log.filter((entry) => entry[0] === 'submit').length, 1);
  } finally { await bridge.close(); }
});

test('simultaneous submissions cannot pass the active-turn guard', async () => {
  const { provider, bridge } = await setup();
  try {
    const first = send(bridge);
    await assert.rejects(send(bridge), /active turn/);
    await first;
    assert.equal(provider.log.filter((entry) => entry[0] === 'submit').length, 1);
  } finally { await bridge.close(); }
});

test('cancellation cannot report success while work remains active', async () => {
  const { provider, bridge, output } = await setup();
  try {
    await send(bridge);
    provider.interrupt = async () => ({ interrupted: false });
    await assert.rejects(bridge.cancel({ session: 'ses_test', turn: 'msg_one' }), /confirm cancellation/);
    assert.equal(output.some((event) => event.type === 'finished'), false);
    assert.ok(bridge.active);
  } finally { await bridge.close(); }
});

test('a turn that already completed is not relabelled as interrupted by a late cancel', async () => {
  const { provider, bridge, output } = await setup();
  try {
    await send(bridge);
    provider.history.push({ id: 'msg_idle', type: 'idle', outcome: 'succeeded' });
    provider.state.active = false;
    await bridge.cancel({ session: 'ses_test', turn: 'msg_one' });
    assert.equal(output.find((event) => event.type === 'finished').status, 'completed');
  } finally { await bridge.close(); }
});


test('attached TUI turns are observed while GUI is idle, including approvals and completion', async () => {
  const { provider, bridge, output } = await setup();
  try {
    provider.history.push({ id: 'msg_native', type: 'user', text: 'from the TUI' });
    provider.state.active = true;
    provider.state.permissions = [{ id: 'per_native', action: 'bash', resources: ['echo native'] }];
    await bridge.refresh();
    assert.equal(output.filter(e => e.type === 'started' && e.turn === 'msg_native').length, 1);
    assert.equal(output.find(e => e.type === 'item' && e.item.id === 'msg_native').item.text, 'from the TUI');
    assert.equal(output.find(e => e.type === 'request').turn, 'msg_native');
    await bridge.answer({ id: 'per_native', decision: 'accept' });
    provider.history.push({ id: 'msg_answer_native', type: 'assistant', time: { completed: 1 }, content: [{ type: 'text', text: 'native response' }] }, { id: 'msg_idle_native', type: 'idle', outcome: 'succeeded' });
    provider.state.active = false;
    await bridge.refresh(); await bridge.refresh();
    assert.equal(output.filter(e => e.type === 'finished' && e.turn === 'msg_native').length, 1);
    assert.equal(provider.log.some(e => e[0] === 'submit'), false);
  } finally { await bridge.close(); }
});

test('fast completed TUI turns are reconciled once after an idle gap', async () => {
  const { provider, bridge, output } = await setup();
  try {
    for (const suffix of ['one', 'two']) provider.history.push(
      { id: `msg_native_${suffix}`, type: 'user', text: suffix },
      { id: `msg_idle_${suffix}`, type: 'idle', outcome: 'succeeded' });
    await bridge.refresh(); await bridge.refresh();
    assert.deepEqual(output.filter(e => e.type === 'finished').map(e => e.turn), ['msg_native_one', 'msg_native_two']);
  } finally { await bridge.close(); }
});


test('GUI submission racing native admission does not stop the shared server', async () => {
  const { provider, bridge, output } = await setup();
  try {
    provider.history.push({ id: 'msg_native_race', type: 'user', text: 'native first' });
    provider.state.active = true;
    await assert.rejects(send(bridge), /another view/);
    assert.equal(provider.log.some(e => e[0] === 'stop'), false);
    assert.equal(output.some(e => e.type === 'exited'), false);
    await bridge.refresh();
    assert.equal(output.find(e => e.type === 'started').turn, 'msg_native_race');
  } finally { await bridge.close(); }
});
