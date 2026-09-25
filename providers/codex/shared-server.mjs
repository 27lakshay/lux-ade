// Bun's native Unix WebSocket transport lets both lux-ade and Codex's native TUI
// attach to one private app-server. JSON-RPC remains Codex's own protocol.
import { spawn } from 'node:child_process';
import { mkdtemp, chmod, rm, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { StringDecoder } from 'node:string_decoder';

const LIMIT = 16 * 1024 * 1024;
const provided = process.env.ADE_CODEX_SOCKET_DIR;
if (provided && !/^\/tmp\/ade-codex-[a-zA-Z0-9]{1,32}$/.test(provided)) throw new Error('Invalid owned Codex socket directory');
const directory = provided || await mkdtemp('/tmp/ade-codex-');
const attributes = await stat(directory);
if (!attributes.isDirectory() || attributes.uid !== process.getuid()) throw new Error('Codex socket directory is not owned');
await chmod(directory, 0o700);
const socketPath = `${directory}/control.sock`;
const endpoint = `unix://${socketPath}`;
const child = spawn(process.env.ADE_CODEX_BIN || 'codex', ['app-server', '--listen', endpoint], {
  stdio: ['ignore', 'pipe', 'pipe'], // Same process group as the supervisor-owned relay.
});
child.stdout.resume(); child.stderr.resume();
let childExited = false;
const exited = new Promise(resolve => {
  child.once('exit', () => { childExited = true; resolve(); });
  child.once('error', () => { childExited = true; resolve(); });
});
let websocket;
let closing;
async function close(code = 0) {
  if (closing) return closing;
  closing = (async () => {
    websocket?.terminate();
    if (!childExited) {
      child.kill('SIGTERM');
      await Promise.race([exited, delay(2000)]);
      if (!childExited) { child.kill('SIGKILL'); await exited; }
    }
    await rm(directory, { recursive: true, force: true });
    process.exit(code);
  })();
  return closing;
}
function output(value) {
  const line = JSON.stringify(value)+'\n';
  if (Buffer.byteLength(line) > LIMIT || process.stdout.writableLength > LIMIT) throw new Error('Codex relay output exceeds its bound');
  process.stdout.write(line);
}
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
process.stdout.on('error', () => void close(1));
try {
  const deadline = Date.now()+10000;
  while (true) {
    if (childExited) throw new Error('Codex app-server exited before opening its socket');
    if (await stat(socketPath).then(value => value.isSocket(), () => false)) break;
    if (Date.now() > deadline) throw new Error('Codex app-server socket startup timed out');
    await delay(20);
  }
  await new Promise((resolve, reject) => {
    // Codex's Unix transport does not negotiate compression. Suppress Bun's
    // default extension offer; otherwise Codex rejects the Upgrade request.
    websocket = new WebSocket(`ws+unix://${socketPath}`, { perMessageDeflate: false });
    const timer = setTimeout(() => reject(new Error('Codex WebSocket startup timed out')), 5000);
    websocket.onopen = () => { clearTimeout(timer); resolve(); };
    websocket.onerror = () => { clearTimeout(timer); reject(new Error('Codex WebSocket connection failed')); };
  });
  websocket.binaryType = "arraybuffer";
  websocket.onmessage = event => {
    try {
      const data = typeof event.data === 'string' ? event.data : new TextDecoder('utf-8', { fatal: true }).decode(event.data);
      if (Buffer.byteLength(data) > LIMIT) throw new Error('Invalid Codex frame');
      output(JSON.parse(data));
    } catch { void close(1); }
  };
  websocket.onclose = () => { if (!closing) void close(1); };
  websocket.onerror = () => void close(1);
  exited.then(() => { if (!closing) void close(1); });
  let pending = '';
  const decoder = new StringDecoder('utf8');
  for await (const chunk of process.stdin) {
    pending += decoder.write(chunk);
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end); pending = pending.slice(end+1);
      if (Buffer.byteLength(line) > LIMIT) throw new Error('Codex input frame exceeds its bound');
      const frame = JSON.parse(line);
        if (websocket.bufferedAmount + Buffer.byteLength(line) > LIMIT) throw new Error('Codex input queue exceeds its bound');
        websocket.send(line);
    }
    if (Buffer.byteLength(pending) > LIMIT) throw new Error('Codex input frame exceeds its bound');
  }
  await close();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  await close(1);
}
