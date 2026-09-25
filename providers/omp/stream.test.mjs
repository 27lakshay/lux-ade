import { test, expect } from 'bun:test';
import { TextStream } from './stream.mjs';
import { projectHistory } from './history.mjs';

const frame = (type, text, extra = {}) => ({ type, message: { role: 'assistant', responseId: 'provider-response', content: [{ type: 'text', text }], ...extra } });

test('stream, final snapshot and recovered history use the same text identity', () => {
  const stream = new TextStream();
  const start = stream.consume(frame('message_start', ''), 'turn')[0];
  const delta = stream.consume(frame('message_update', 'Hello'), 'turn')[0];
  expect(delta.type).toBe('delta'); expect(delta.id).toBe(start.item.id);
  expect(stream.consume(frame('message_update', 'Hello'), 'turn')).toEqual([]);
  const endFrame = frame('message_end', 'Hello world', { stopReason: 'stop' });
  const end = stream.consume(endFrame, 'turn')[0];
  const history = projectHistory({ entries: [
    { id: 'user', parentId: null, type: 'message', message: { role: 'user', content: 'prompt' } },
    { id: 'assistant', parentId: 'user', type: 'message', message: endFrame.message },
  ], leafId: 'assistant' }, new Map([['user', { turn: 'turn', submission: 'submission' }]]));
  expect(end.item).toEqual(history.items[1]);
});

test('non-prefix corrections replace text rather than appending it', () => {
  const stream = new TextStream();
  stream.consume(frame('message_update', 'incorrect'), 'turn');
  const correction = stream.consume(frame('message_update', 'corrected'), 'turn')[0];
  expect(correction.type).toBe('item'); expect(correction.item.text).toBe('corrected');
});

test('response identity is turn scoped and absent identity waits for durable history', () => {
  const stream = new TextStream();
  expect(stream.consume(frame('message_update', 'pending', { responseId: undefined }), 'turn')).toEqual([]);
  const first = stream.consume(frame('message_update', 'pending'), 'turn')[0];
  const second = stream.consume(frame('message_update', 'pending'), 'next-turn')[0];
  expect(first.item.id).not.toBe(second.item.id);
  expect(first.item.text).toBe('pending');
});

test('private thinking is excluded and individual streams are bounded', () => {
  const stream = new TextStream();
  expect(stream.consume(frame('message_update', '', { content: [{ type: 'thinking', thinking: 'private' }] }), 'turn')).toEqual([]);
  expect(() => stream.consume(frame('message_update', 'x'.repeat(1048577)), 'turn')).toThrow('content limits');
});
