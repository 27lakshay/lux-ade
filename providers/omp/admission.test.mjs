import { test, expect } from 'bun:test';
import { admit, promptPayload } from './admission.mjs';
import { SubmissionLedger } from './submissions.mjs';

function harness() {
  const ledger = new SubmissionLedger(':memory:');
  const calls = [];
  let failure = false;
  const transport = { request: async (type, payload, options) => {
    calls.push({ type, payload, options });
    if (type === 'get_state') return { sessionId: 's', isStreaming: false, isCompacting: false, queuedMessageCount: 0 };
    expect(ledger.pending('s').turn).toBe('t');
    if (failure) throw new Error('connection lost');
    return {};
  } };
  const input = { ledger, transport, history: { refresh: async () => ({ entries: [{ id: 'before' }], leafId: 'before' }) }, session: 's', submission: 'a', turn: 't', prompt: { text: 'hello' } };
  return { ledger, calls, input, fail: () => { failure = true; } };
}

test('prompt dispatch follows durable receipt and a repeat dispatches nothing', async () => {
  const h = harness();
  try {
    expect((await admit(h.input)).fresh).toBe(true);
    expect(h.ledger.pending('s').baseline).toBe('before');
    expect((await admit(h.input)).fresh).toBe(false);
    expect(h.calls.map(c => c.type)).toEqual(['get_state', 'prompt']);
    await expect(admit({ ...h.input, prompt: { text: 'changed' } })).rejects.toThrow('different content');
  } finally { h.ledger.close(); }
});

test('connection loss after dispatch leaves uncertainty and never resends', async () => {
  const h = harness(); h.fail();
  try {
    await expect(admit(h.input)).rejects.toThrow('connection lost');
    expect((await admit(h.input)).fresh).toBe(false);
    expect(h.calls.filter(c => c.type === 'prompt').length).toBe(1);
    expect(h.ledger.pending('s').outcome).toBeNull();
  } finally { h.ledger.close(); }
});

test('oversized attachments fail before receipt or provider request', async () => {
  const h = harness();
  try {
    await expect(admit({ ...h.input, prompt: { text: 'x'.repeat(1048576) } })).rejects.toThrow('1 MiB');
    expect(h.calls).toEqual([]); expect(h.ledger.pending('s')).toBeNull();
  } finally { h.ledger.close(); }
});

test('admission refuses a replaced session or provider-owned pending work', async () => {
  const h = harness();
  try {
    await expect(admit({ ...h.input, transport: { request: async () => ({ sessionId: 'different' }) } })).rejects.toThrow('identity changed');
    await expect(admit({ ...h.input, transport: { request: async () => ({ sessionId: 's', queuedMessageCount: 1 }) } })).rejects.toThrow('active work');
    expect(h.ledger.pending('s')).toBeNull();
  } finally { h.ledger.close(); }
});

test('attachments use native image blocks and UTF-8 text', () => {
  const payload = promptPayload({ text: '', attachments: [
    { attachment: { name: 'a.png', media_type: 'image/png' }, data: 'YWJj' },
    { attachment: { name: 'notes.txt', media_type: 'text/plain' }, data: Buffer.from('你好').toString('base64') },
  ] });
  expect(payload.images).toEqual([{ type: 'image', mimeType: 'image/png', data: 'YWJj' }]);
  expect(payload.message).toContain('你好');
});
