#!/usr/bin/env bun
// Native RPC v2 fixture. ADE runs its real daemon, runtime, account probe and OMP bridge.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

if (process.argv.includes('--version')) {
  const override = join(dirname(fileURLToPath(import.meta.url)), 'version');
  process.stdout.write(existsSync(override) ? readFileSync(override) : 'omp/18.3.0\n');
  process.exit(0);
}
const home = process.env.PI_CODING_AGENT_DIR;
if (!home) throw new Error('Missing native account home');
appendFileSync(join(home, 'launches'), 'launch\n');
const file = process.argv[process.argv.indexOf('--session') + 1];
const rows = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
const header = rows.find(row => row.type === 'session');
const entries = rows.filter(row => row.parentId !== undefined);
const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
let active = false;
send({ type: 'ready', supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  let data = {};
  switch (request.type) {
    case 'negotiate_protocol': data = { protocolVersion: 2 }; break;
    case 'get_state': data = { sessionId: header.id, sessionFile: file,
      model: { provider: 'anthropic', id: 'fixture-model' }, isStreaming: active,
      isCompacting: false, queuedMessageCount: 0 }; break;
    case 'get_entries': data = { entries: entries.slice(request.since ? entries.findIndex(entry => entry.id === request.since) + 1 : 0),
      leafId: entries.at(-1)?.id ?? null }; break;
    case 'set_subagent_subscription': break;
    case 'prompt': {
      active = true;
      appendFileSync(join(home, 'calls.jsonl'), JSON.stringify({ message: request.message,
        home, ambient: Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY),
        config: process.env.PI_CODING_AGENT_DIR, userHome: process.env.HOME,
        managedHome: process.env.ADE_OMP_ACCOUNT_HOME }) + '\n');
      const add = message => {
        const entry = { type: 'message', id: randomUUID(), parentId: entries.at(-1)?.id ?? null,
          timestamp: new Date().toISOString(), message };
        appendFileSync(file, JSON.stringify(entry) + '\n');
        entries.push(entry);
        send({ type: 'message_end', message });
      };
      add({ role: 'user', content: request.message });
      add({ role: 'assistant', content: [{ type: 'text', text: 'Fixture reply' }], stopReason: 'stop' });
      active = false;
      send({ type: 'agent_end', messages: [], messagesOmitted: 2 });
      break;
    }
    case 'abort': active = false; break;
  }
  send({ type: 'response', id: request.id, command: request.type, success: true, data });
}
