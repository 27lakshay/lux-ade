import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { RpcFrameDecoder, MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES } from '@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame';

export class OmpCommandError extends Error {
  constructor(frame) {
    super(frame.error ?? 'Oh My Pi command failed');
    this.command = frame.command; this.code = frame.code;
  }
}

// The SDK owns chunk validation. lux-ade owns deadlines and correlation because
// prompt acknowledgements can be followed by scheduling failures with the same ID.
export class OmpTransport {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.pending = new Map(); this.decoder = new RpcFrameDecoder();
    this.parts = []; this.bytes = 0; this.protocol = 1; this.closed = false; this.stderr = "";
  }

  static async start({ command = [process.env.ADE_OMP_BIN ?? fileURLToPath(new URL('./node_modules/.bin/omp', import.meta.url))], cwd = process.cwd(), env = process.env, args = [], onFrame = () => {}, readyTimeout = 20_000 } = {}) {
    const transport = new OmpTransport(onFrame);
    let readyResolve, readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    transport.readyResolve = readyResolve; transport.readyReject = readyReject;
    const timer = setTimeout(() => transport.fail(new Error('Oh My Pi startup timed out')), readyTimeout);
    const child = spawn(command[0], [...command.slice(1), '--mode', 'rpc-ui', ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    transport.child = child;
    transport.exited = new Promise((resolve) => {
      child.once('close', (code) => { transport.fail(new Error(transport.exitMessage(code))); resolve(); });
      child.once('error', () => { transport.fail(new Error('Could not launch Oh My Pi; check its installation')); resolve(); });
    });
    child.stdin.on('error', () => transport.fail(new Error('Oh My Pi input closed')));
    child.stderr.on('data', chunk => { transport.stderr = (transport.stderr + chunk.toString('utf8')).slice(-4096); });
    child.stdout.on('data', (chunk) => {
      try { transport.read(chunk); } catch (error) { transport.fail(error); }
    });
    try {
      const capabilities = await ready;
      if (!capabilities.supportedProtocolVersions?.includes(2) || capabilities.maxFrameBytes !== MAX_RPC_FRAME_BYTES || capabilities.maxReassembledFrameBytes !== MAX_RPC_REASSEMBLED_BYTES) {
        throw new Error('Oh My Pi must support the lossless RPC v2 transport');
      }
      const result = await transport.request('negotiate_protocol', { protocolVersion: 2 });
      if (result?.protocolVersion !== 2) throw new Error('Oh My Pi refused RPC v2');
      return transport;
    } catch (error) { await transport.stop(); throw error; }
    finally { clearTimeout(timer); }
  }

  exitMessage(code) {
    // Classify known diagnostics without forwarding potentially sensitive stderr.
    const text = this.stderr.replace(/\x1b\[[0-9;]*m/g, '');
    if (/no models available|no api key|api key.*required|missing.*api key/i.test(text)) {
      return 'Oh My Pi has no configured model or credential. Configure a provider in Oh My Pi, or supply its API-key environment variable, then retry connection.';
    }
    if (/cannot find module|module not found|cannot find package/i.test(text)) {
      return 'Oh My Pi installation is incomplete. Repair the installed package and retry connection.';
    }
    if (/unknown option|unknown mode|invalid mode/i.test(text)) {
      return 'Oh My Pi does not support the requested RPC mode. Install a compatible version and retry connection.';
    }
    return `Oh My Pi exited${Number.isInteger(code) ? ` (code ${code})` : ''}. Check its model, credentials, configuration and extensions, then retry connection.`;
  }

  read(chunk) {
    if (this.closed) return;
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const piece = chunk.subarray(start, end);
      this.bytes += piece.length;
      if (this.bytes + 1 > MAX_RPC_FRAME_BYTES) throw new Error('Oh My Pi physical frame exceeds 1 MiB');
      this.parts.push(piece);
      if (newline < 0) break;
      const line = Buffer.concat(this.parts, this.bytes);
      this.parts = []; this.bytes = 0;
      if (line.length) {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
        if (value.type === 'rpc_chunk' && this.protocol !== 2) throw new Error('Oh My Pi sent chunks before negotiation');
        const frame = this.decoder.push(value);
        if (frame) this.dispatch(frame);
      }
      start = newline + 1;
    }
  }

  dispatch(frame) {
    if (frame.type === 'ready') {
      if (!this.readyResolve) throw new Error('Oh My Pi sent a second ready frame');
      this.readyResolve(frame); this.readyResolve = null; return;
    }
    if (frame.type === 'rpc_frame_error') throw new Error('Oh My Pi could not deliver a complete frame');
    if (frame.type === 'response' && this.pending.has(frame.id)) {
      const request = this.pending.get(frame.id);
      if (frame.command !== request.type || typeof frame.success !== 'boolean') throw new Error('Oh My Pi response does not match its command');
      this.pending.delete(frame.id); clearTimeout(request.timer);
      if (frame.success && request.type === 'negotiate_protocol' && frame.data?.protocolVersion === 2) this.protocol = 2;
      if (frame.success) request.resolve(frame.data); else request.reject(new OmpCommandError(frame));
      return;
    }
    // Includes a later failure response for an already acknowledged prompt.
    this.onFrame(frame);
  }

  request(type, fields = {}, { id = randomUUID(), timeout = 30_000 } = {}) {
    if (this.closed) return Promise.reject(new Error('Oh My Pi transport is closed'));
    if (this.pending.size >= 64 || this.pending.has(id)) return Promise.reject(new Error('Oh My Pi request limit or duplicate ID'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`${type} timed out; outcome is uncertain, reconnect before retrying`)), timeout);
      this.pending.set(id, { type, timer, resolve, reject });
      try { this.write({ ...fields, type, id }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  write(frame) {
    if (this.closed) throw new Error('Oh My Pi transport is closed');
    const line = JSON.stringify(frame) + '\n';
    if (Buffer.byteLength(line) > MAX_RPC_FRAME_BYTES) throw new Error('Oh My Pi command exceeds its 1 MiB input limit');
    if (this.child.stdin.writableLength + Buffer.byteLength(line) > 2 * MAX_RPC_FRAME_BYTES) throw new Error('Oh My Pi is not consuming commands');
    this.child.stdin.write(line);
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.parts = []; this.bytes = 0;
    this.readyReject?.(error); this.readyReject = null;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    this.child?.kill('SIGKILL');
    try { this.onFrame({ type: 'process_exit', error: error.message }); } catch {}
  }

  async stop() {
    if (!this.closed) {
      this.closed = true;
      const error = new Error('Oh My Pi transport stopped');
      this.readyReject?.(error);
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
      this.pending.clear(); this.child.stdin.end();
    }
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    try { await this.exited; } finally { clearTimeout(timer); }
  }
}
