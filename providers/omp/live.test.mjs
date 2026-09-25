import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OmpTransport } from './transport.mjs';
import { EntryHistory, projectHistory } from './history.mjs';
import { Bridge } from './bridge.mjs';

test.skipIf(process.env.ADE_OMP_LIVE !== '1')('published CLI negotiates and reads an isolated empty session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ade-omp-test-'));
  let transport, bridge;
  try {
    const home = join(root, 'home');
    const cwd = join(root, 'project');
    await mkdir(home); await mkdir(cwd);
    // Only explicitly allowed environment values enter the isolated CLI.
    // Startup requires a configured model even though this test never prompts it.
    const env = { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir(), TERM: 'dumb', ANTHROPIC_API_KEY: 'ade-test-placeholder-not-a-real-key',
      PI_CODING_AGENT_DIR: join(home, '.omp', 'agent'),
      XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_CACHE_HOME: join(home, '.cache') };
    transport = await OmpTransport.start({
      command: [process.execPath, new URL('./node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js', import.meta.url).pathname],
      cwd, env, args: ['--no-session', '--no-extensions', '--no-skills', '--no-rules', '--no-tools'],
    });
    const state = await transport.request('get_state');
    expect(state.isStreaming).toBe(false);
    const page = await transport.request('get_messages_page', { limit: 10 });
    expect(page.messages).toEqual([]);
    const history = new EntryHistory(transport);
    expect(projectHistory(await history.refresh()).items).toEqual([]);
    expect(projectHistory(await history.refresh()).items).toEqual([]);
    await transport.stop(); transport = null;
    const options = { cwd, directory: join(root, 'ade'), connect: options => OmpTransport.start({ ...options, env,
      args: [...options.args, '--no-extensions', '--no-skills', '--no-rules', '--no-tools'],
    }) };
    bridge = new Bridge(() => {}, options);
    const opened = await bridge.open({});
    expect(opened.history).toEqual([]);
    await bridge.close();
    bridge = new Bridge(() => {}, options);
    const resumed = await bridge.open({ resume: opened.session });
    expect(resumed.session).toBe(opened.session);
    expect(resumed.history).toEqual([]);
  } finally { await bridge?.close(); await transport?.stop(); await rm(root, { recursive: true, force: true }); }
}, 30000);

test.skipIf(process.env.ADE_OMP_LIVE !== '1')('unconfigured published CLI explains startup failure instead of output closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ade-omp-unconfigured-'));
  let transport;
  try {
    const env = { PATH: process.env.PATH, HOME: root, TMPDIR: tmpdir(), TERM: 'dumb',
      PI_CODING_AGENT_DIR: join(root, 'agent'), XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache') };
    let failure;
    try { transport = await OmpTransport.start({
      command: [process.execPath, new URL('./node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js', import.meta.url).pathname],
      cwd: root, env, args: ['--no-session', '--no-extensions', '--no-skills', '--no-rules', '--no-tools'],
    }); } catch (error) { failure = error.message; }
    expect(failure).toMatch(/model|authentication|credential|API key/i);
    expect(failure).not.toBe('Oh My Pi output closed');
  } finally { await transport?.stop(); await rm(root, { recursive: true, force: true }); }
}, 30000);
