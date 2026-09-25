import { test, expect } from 'bun:test';
import { OmpTransport } from './transport.mjs';

const command = [process.execPath, new URL('./transport-fixture.mjs', import.meta.url).pathname];
const start = (options = {}) => OmpTransport.start({ command, ...options });

test('negotiates v2 and correlates concurrent commands', async () => {
  const transport = await start();
  try {
    expect(transport.protocol).toBe(2);
    expect(await Promise.all([transport.request('echo', { value: 'a' }), transport.request('echo', { value: 'b' })])).toEqual(['a', 'b']);
  } finally { await transport.stop(); }
});

test('retains scheduling failure after prompt acknowledgement', async () => {
  const frames = [];
  const transport = await start({ onFrame: frame => frames.push(frame) });
  try {
    await transport.request('prompt', {}, { id: 'submission-1' });
    for (let i = 0; i < 100 && !frames.length; i++) await Bun.sleep(10);
    expect(frames).toContainEqual({ type: 'response', id: 'submission-1', command: 'prompt', success: false, error: 'Scheduling failed' });
  } finally { await transport.stop(); }
});

test('reassembles large multibyte frames without truncation', async () => {
  const transport = await start();
  try { expect((await transport.request('large')).text).toBe('界'.repeat(500000)); }
  finally { await transport.stop(); }
});

test('rejects lossy v1', async () => {
  await expect(start({ args: ['--v1'] })).rejects.toThrow('lossless RPC v2');
});

test('correlation mismatch closes the transport', async () => {
  const transport = await start();
  try {
    await expect(transport.request('mismatch')).rejects.toThrow('does not match');
    expect(transport.closed).toBe(true);
  } finally { await transport.stop(); }
});

test('timeout reports uncertain outcome and prevents retries on the same process', async () => {
  const transport = await start();
  try {
    await expect(transport.request('hang', {}, { timeout: 30 })).rejects.toThrow('outcome is uncertain');
    await expect(transport.request('echo')).rejects.toThrow('closed');
  } finally { await transport.stop(); }
});

test('oversized input is rejected before dispatch and leaves transport usable', async () => {
  const transport = await start();
  try {
    await expect(transport.request('echo', { value: 'x'.repeat(1048576) })).rejects.toThrow('1 MiB input limit');
    expect(await transport.request('echo', { value: 'still usable' })).toBe('still usable');
  } finally { await transport.stop(); }
});
