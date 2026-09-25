import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Bridge } from './bridge.mjs';
import { OpenCodeTransport } from './transport.mjs';
import { SessionApi } from './session-api.mjs';

// The installed OpenCode v2 binary and lux-ade bridge run unchanged. Only the model endpoint
// is deterministic. Isolated config and placeholder credentials prevent use of user accounts.
// The endpoint returns text only and never requests a tool.
test('installed OpenCode v2 streams two structured turns and resumes their exact history', { skip: !process.env.ADE_OPENCODE_LOOPBACK_BIN, timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ade-opencode-loopback-'));
  const calls = [], events = [];
  const isTitle = payload => JSON.stringify(payload.system ?? '').includes('You are a title generator.');
  const modelCalls = () => calls.filter(payload => !isTitle(payload));
  let bridge;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (new URL(req.url, 'http://127.0.0.1').pathname !== '/v1/messages') { res.writeHead(404); res.end(); return; }
    const payload = JSON.parse(body); calls.push(payload);
    const text = isTitle(payload) ? 'Local protocol test' : `Loopback answer ${modelCalls().length}`;
    const message = { id: `msg_loopback_${calls.length}`, type: 'message', role: 'assistant', model: 'ade-loopback', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    send({ type: 'message_start', message });
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, 9) } });
    await new Promise(resolve => setTimeout(resolve, 40));
    send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(9) } });
    send({ type: 'content_block_stop', index: 0 });
    send({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
    send({ type: 'message_stop' }); res.end();
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const cwd = join(root, 'project');
    await mkdir(cwd);
    // Installed v2.0.3 uses its bundled aisdk runtime; newer cloned versions use
    // @opencode/ai/providers packages. Config shape verified against source and
    // https://opencode.ai/v2/docs/providers (V1 uses different field names).
    const config = { providers: { 'ade-loopback': {
      package: 'aisdk:@ai-sdk/anthropic',
      settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'ade-local-placeholder' },
      models: { 'ade-loopback': { name: 'lux-ade loopback', limit: { context: 32000, output: 1024 } } },
    } } };
    const env = { PATH: process.env.PATH, HOME: root, TMPDIR: tmpdir(), TERM: 'dumb',
      XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
      OPENCODE_CONFIG_DIR: join(root, 'config/opencode'), OPENCODE_TEST_HOME: root,
      OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_FFF: '1', OPENCODE_DISABLE_FILEWATCHER: '1',
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    };
    const options = { cwd, connect: async () => {
      const transport = await OpenCodeTransport.start({ command: process.env.ADE_OPENCODE_LOOPBACK_BIN, cwd, env });
      try {
        return { transport, api: await SessionApi.connect(transport) };
      }
      catch (error) { await transport.stop(); throw error; }
    } };
    bridge = new Bridge(frame => events.push(frame.params), options);
    const opened = await bridge.open({ config: { model: 'ade-loopback/ade-loopback' } });
    assert.deepEqual(opened.history, []);
    const waitFor = async predicate => {
      const deadline = Date.now() + 15000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(events)}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    for (let i = 1; i <= 2; i++) {
      await bridge.send({ session: opened.session, submission: `submission-${i}`, message_id: `msg_turn${i}`, text: `Local prompt ${i}` });
      await waitFor(() => events.some(e => e.type === 'finished' && e.turn === `msg_turn${i}`));
      assert.equal(events.find(e => e.type === 'finished' && e.turn === `msg_turn${i}`).status, 'completed', JSON.stringify({ events, history: await bridge.history(), modelRequests: modelCalls().length }));
    }
    assert.equal(modelCalls().length, 2);
    assert.ok(JSON.stringify(modelCalls()[1].messages).includes('Local prompt 1'));
    assert.ok(JSON.stringify(modelCalls()[1].messages).includes('Loopback answer 1'));
    assert.ok(events.some(e => e.type === 'delta' || e.item?.status === 'streaming'));
    await bridge.close();
    bridge = new Bridge(frame => events.push(frame.params), options);
    const resumed = await bridge.open({ resume: opened.session, config: { model: 'ade-loopback/ade-loopback' } });
    assert.equal(resumed.session, opened.session);
    const answers = resumed.history.filter(item => item.role === 'assistant' && item.kind === 'text');
    assert.deepEqual(answers.map(item => item.text), ['Loopback answer 1', 'Loopback answer 2']);
    assert.equal(new Set(answers.map(item => item.id)).size, 2);
    assert.deepEqual(resumed.history.filter(item => item.role === 'user').map(item => item.text), ['Local prompt 1', 'Local prompt 2']);
    assert.equal(modelCalls().length, 2); // Reopening never resubmits either prompt.
  } finally {
    await bridge?.close();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
