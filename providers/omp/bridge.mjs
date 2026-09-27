import { join, resolve } from 'node:path';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { OmpTransport } from './transport.mjs';
import { sessionIdentity, verifySession } from './session.mjs';
import { EntryHistory, activeBranch, projectHistory } from './history.mjs';
import { SubmissionLedger } from './submissions.mjs';
import { admit } from './admission.mjs';
import { TextStream } from './stream.mjs';
import { Subagents } from './subagents.mjs';
import { ChildTranscripts } from './child-transcripts.mjs';

export class Bridge {
  constructor(emit, { cwd = process.cwd(), directory = process.env.ADE_DATA_DIR && join(process.env.ADE_DATA_DIR, 'omp'), connect = options => OmpTransport.start(options), command } = {}) {
    if (process.env.ADE_OMP_ACCOUNT_HOME) directory = join(process.env.ADE_OMP_ACCOUNT_HOME, 'ade-sessions');
    this.emit = emit; this.cwd = cwd; this.directory = directory; this.connect = connect;
    this.command = command ?? (process.env.ADE_OMP_BIN ? [process.env.ADE_OMP_BIN] : [process.execPath,
      ...(process.env.ADE_OMP_ACCOUNT_HOME ? ['--no-env-file'] : []),
      new URL('./node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js', import.meta.url).pathname]);
    this.events = Promise.resolve(); this.requests = new Map(); this.visible = new Map(); this.closed = false;
    this.subagents = new Subagents();
  }
  event(params) { this.emit({ method: 'event', params }); }
  async open({ resume, config = {}, mcp_servers: mcpServers = null }) {
    if (this.opening || this.transport || this.closed) throw new Error('Oh My Pi bridge cannot be opened again');
    this.opening = true;
    try {
      if (!this.directory) throw new Error('Missing lux-ade data directory for Oh My Pi');
      if ((config.permission_mode ?? 'default') !== 'default') throw new Error('Unsupported Oh My Pi permission mode');
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      this.identity = await sessionIdentity({ resume, cwd: this.cwd, directory: join(this.directory, 'sessions') });
      this.session = resume ?? JSON.stringify(this.identity);
      const extension = await this.mcpExtension(mcpServers);
      this.ledger = new SubmissionLedger(join(this.directory, 'submissions.sqlite'));
      this.childTranscripts = new ChildTranscripts(this.ledger.db);
      this.transport = await this.connect({ command: this.command, cwd: this.cwd,
        env: process.env.ADE_OMP_ACCOUNT_HOME ? { ...process.env, HOME: process.env.ADE_OMP_ACCOUNT_HOME,
          PI_CODING_AGENT_DIR: process.env.ADE_OMP_ACCOUNT_HOME } : process.env,
        args: ['--session', this.identity.file, ...(config.model ? ['--model', config.model] : []),
          ...(extension ? ['--extension', extension] : [])],
        onFrame: frame => { this.events = this.events.then(() => this.consume(frame)).catch(error => this.fail(error)); },
      });
      const state = await this.transport.request('get_state');
      if (process.env.ADE_OMP_EXPECTED_PROVIDER && state.model?.provider !== process.env.ADE_OMP_EXPECTED_PROVIDER) {
        throw new Error('Oh My Pi selected model belongs to another account provider');
      }
      await verifySession(this.identity, state);
      if (state.isStreaming || state.isCompacting || state.queuedMessageCount) throw new Error('Oh My Pi has active work; ownership transfer is required');
      await this.transport.request('set_subagent_subscription', { level: 'progress' });
      this.history = new EntryHistory(this.transport);
      const snapshot = await this.history.refresh();
      const history = this.project(snapshot);
      for (const item of history.items) this.visible.set(item.id, JSON.stringify(item));
      const pending = this.ledger.pending(this.identity.id);
      if (pending) {
        this.active = { turn: pending.turn, submission: pending.submission, recovery: true };
        this.event({ type: 'started', session: this.session, turn: pending.turn });
        this.request(`recover:${pending.turn}`, 'omp/recover', { reason: 'The previous Oh My Pi process ended before lux-ade recorded completion. Review the recovered transcript, then mark the turn interrupted. The prompt will not be resent.' }, 'recover');
      }
      this.ready = true;
      return { session: this.session, history: history.items };
    } catch (error) { await this.close(); throw error; }
  }
  // The profile MCP catalog (F131). Oh My Pi reads the sibling `.mcp.json`
  // of an extension package named with `--extension` (docs/extension-loading.md,
  // docs/mcp-config.md "OMP extension packages"), with the same `${VAR}`
  // expansion and pre-connect env/header resolution as its native mcp.json.
  // The package is ADE's own directory per native session, holding only that
  // file, so the user's `mcp.json` is never written and their native entries
  // keep precedence. Each launch rewrites it, so a resume reads the current
  // catalog; a launch with no servers removes it.
  async mcpExtension(servers) {
    // The session ID comes from a resume token; hash it so it is always one path segment.
    const directory = join(this.directory, 'mcp', createHash('sha256').update(this.identity.id).digest('hex').slice(0, 32));
    if (!servers || typeof servers !== 'object' || !Object.keys(servers).length) {
      await rm(directory, { recursive: true, force: true });
      return null;
    }
    const mcpServers = {};
    for (const [name, server] of Object.entries(servers)) {
      // Oh My Pi roots a path-like package command at the package directory; a
      // native mcp.json roots it at the session cwd, which is what ADE's entry means.
      mcpServers[name] = typeof server.command === 'string' && /^\.\.?[/\\]/.test(server.command)
        ? { ...server, command: resolve(this.cwd, server.command) } : server;
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, '.mcp.json'), partial = `${file}.${process.pid}.tmp`;
    await writeFile(partial, JSON.stringify({ mcpServers }, null, 2) + '\n', { mode: 0o600 });
    await rename(partial, file);
    return directory;
  }
  project(snapshot) {
    return projectHistory(snapshot, this.ledger.identities(this.identity.id, snapshot.entries.filter(e => e.type === 'message' && e.message.role === 'user').map(e => e.id)));
  }
  async reconcile() {
    const snapshot = await this.history.refresh();
    const active = this.active;
    if (active && !active.recovery) {
      const receipt = this.ledger.get(this.identity.id, active.submission);
      if (receipt && !receipt.entry_id && !receipt.outcome) {
        const baseline = receipt.baseline === null ? -1 : snapshot.entries.findIndex(e => e.id === receipt.baseline);
        if (receipt.baseline !== null && baseline < 0) throw new Error('Oh My Pi submission history baseline disappeared');
        const branchIds = new Set(activeBranch(snapshot).map(e => e.id));
        const users = snapshot.entries.slice(baseline + 1).filter(e => branchIds.has(e.id) && e.type === 'message' && e.message.role === 'user');
        // Binding is permitted only while this owned RPC process is executing
        // the admitted prompt, never by matching text after a process restart.
        if (users.length === 1) this.ledger.bind(this.identity.id, active.submission, users[0].id);
        else if (users.length > 1) throw new Error('Oh My Pi emitted multiple user entries; submission identity is ambiguous');
      }
    }
    const projection = this.project(snapshot);
    for (const item of projection.items) {
      const encoded = JSON.stringify(item);
      if (this.visible.get(item.id) !== encoded) {
        this.visible.set(item.id, encoded); this.event({ type: 'item', session: this.session, item });
      }
    }
    return snapshot;
  }
  async send({ session, submission, message_id, text, attachments = [] }) {
    if (!this.ready || this.closed || session !== this.session || this.active) throw new Error('Oh My Pi is not ready for a new turn');
    if (process.env.ADE_OMP_EXPECTED_PROVIDER) {
      const state = await this.transport.request('get_state');
      if (state.model?.provider !== process.env.ADE_OMP_EXPECTED_PROVIDER) {
        throw new Error('Oh My Pi selected model belongs to another account provider');
      }
    }
    this.active = { turn: message_id, submission, admitting: true };
    this.text = new TextStream();
    try {
      const result = await admit({ transport: this.transport, history: this.history, ledger: this.ledger,
        session: this.identity.id, submission, turn: message_id, prompt: { text, attachments },
        onDispatch: () => this.event({ type: 'started', session, turn: message_id }),
      });
      if (!result.fresh) throw new Error('Oh My Pi submission was already attempted; reconnect to reconcile its outcome');
      if (this.active?.turn === message_id) this.active.admitting = false;
      if (result.acknowledgement?.agentInvoked === false) await this.finish('completed');
      return { turn: message_id };
    } catch (error) { await this.fail(error); throw error; }
  }
  async consume(frame) {
    if (this.closed) return;
    if (frame.type === 'process_exit') throw new Error(frame.error);
    if (frame.type === 'extension_ui_request') return this.ui(frame);
    const child = this.subagents.consume(frame, this.active?.recovery ? null : this.active?.turn);
    if (child) {
      this.childTranscripts.remember(this.identity.id, frame.payload);
      this.event({ type: 'item', session: this.session, item: child });
    }
    if (!this.active || this.active.recovery || !this.history) return;
    for (const update of this.text?.consume(frame, this.active.turn) ?? []) {
      const id = update.item?.id ?? update.id;
      const saved = this.visible.get(id);
      // A history read can overtake queued stream events. Never replace a
      // durable completed answer with an older partial snapshot.
      if (saved && JSON.parse(saved).status !== 'streaming') continue;
      this.event({ ...update, session: this.session });
    }
    if (frame.type === 'message_end') {
      if (frame.message?.role === 'assistant') {
        this.active.lastAssistant = { stopReason: frame.message.stopReason, errorMessage: frame.message.errorMessage };
        // One model call's figures as Oh My Pi reported them; the daemon sums
        // a turn's calls and marks figures a call left out as unavailable.
        this.event({ type: 'usage', session: this.session, turn: this.active.turn, source: 'message_end',
          report: { usage: frame.message.usage ?? null, model: frame.message.model ?? null } });
      }
      await this.reconcile();
    }
    else if (frame.type === 'agent_end') {
      // RPC v2 may omit messages already delivered by message_end.
      const last = [...(frame.messages ?? [])].reverse().find(message => message.role === 'assistant') ?? this.active.lastAssistant;
      await this.finish(this.active.cancelled || last?.stopReason === 'aborted' ? 'interrupted' : last?.stopReason === 'error' ? 'failed' : 'completed', last?.errorMessage ?? null);
    } else if (frame.type === 'prompt_result' && frame.id === this.active.turn && frame.agentInvoked === false) await this.finish('completed');
    else if (frame.type === 'response' && frame.command === 'prompt' && frame.id === this.active.turn && !frame.success) await this.finish('failed', frame.error);
  }
  async finish(status, error = null) {
    const active = this.active;
    if (!active || active.finishing) return;
    active.finishing = true;
    await this.reconcile();
    this.ledger.finish(this.identity.id, active.submission, status);
    this.active = null;
    this.text = null;
    for (const id of this.requests.keys()) this.resolve(id);
    this.event({ type: 'finished', session: this.session, turn: active.turn, status, error });
  }
  async child_transcript({ session, child, offset = 0, cursor = null }) {
    if (!this.ready || this.closed || session !== this.session) throw new Error('Oh My Pi parent session is not connected');
    if (cursor !== null) throw new Error('Oh My Pi child reader uses item offsets');
    return this.childTranscripts.read(this.identity.id, child, offset);
  }
  request(id, method, params, kind) {
    if (this.requests.has(id)) return;
    this.requests.set(id, { kind, turn: this.active.turn });
    this.event({ type: 'request', session: this.session, turn: this.active.turn, id, method, params, supported: true });
  }
  resolve(id) { if (this.requests.delete(id)) this.event({ type: 'resolved', id }); }
  ui(frame) {
    if (frame.method === 'cancel') { this.resolve(frame.targetId); return; }
    if (['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text'].includes(frame.method)) return;
    if (!this.active || this.active.recovery) { this.transport.write({ type: 'extension_ui_response', id: frame.id, cancelled: true }); return; }
    if (frame.method === 'confirm') this.request(frame.id, 'omp/toolApproval', { reason: frame.message, tool: frame.title }, 'confirm');
    else if (['select', 'input', 'editor'].includes(frame.method)) this.request(frame.id, 'omp/questions', {
      questions: [{ id: 'value', question: frame.title, options: frame.options?.map(label => ({ label })) }],
    }, frame.method);
    else this.transport.write({ type: 'extension_ui_response', id: frame.id, cancelled: true });
  }
  async answer({ id, decision, answers }) {
    const request = this.requests.get(id);
    if (!request || request.turn !== this.active?.turn) throw new Error('Oh My Pi request is stale');
    if (request.kind === 'recover') {
      if (!['accept', 'decline'].includes(decision)) throw new Error('Acknowledge the interrupted turn');
      await this.finish('interrupted', 'Previous process ended before completion was recorded'); return {};
    }
    let response = { type: 'extension_ui_response', id };
    if (decision === 'decline') response.cancelled = true;
    else if (request.kind === 'confirm' && decision === 'accept') response.confirmed = true;
    else if (request.kind !== 'confirm' && decision === 'answer' && typeof answers?.value === 'string' && answers.value.length <= 16384) response.value = answers.value;
    else throw new Error('Invalid Oh My Pi response');
    this.transport.write(response); this.resolve(id); return {};
  }
  async cancel({ session, turn }) {
    if (session !== this.session || turn !== this.active?.turn) throw new Error('Oh My Pi turn is no longer active');
    if (this.active.admitting) throw new Error('Oh My Pi prompt admission is still in progress');
    this.active.cancelled = true;
    await this.transport.request('abort');
    const state = await this.transport.request('get_state');
    if (state.isStreaming || state.isCompacting || state.queuedMessageCount) throw new Error('Oh My Pi has not confirmed cancellation');
    await this.finish('interrupted'); return {};
  }
  async fail(error) { if (!this.closed) this.event({ type: 'exited', error: error.message }); await this.close(); }
  async close() {
    if (this.closed) return;
    this.closed = true; this.ready = false;
    await this.transport?.stop(); this.ledger?.close();
  }
}

export function serve() {
  const emit = value => {
    const line = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(line) > 16 * 1024 * 1024) throw new Error('Oh My Pi bridge frame exceeds 16 MiB');
    if (!process.stdout.write(line) && process.stdout.writableLength > 16 * 1024 * 1024) throw new Error('lux-ade is not consuming Oh My Pi output');
  };
  const bridge = new Bridge(emit);
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let buffered = 0;
  process.stdin.on('data', chunk => {
    buffered += chunk.length;
    if (buffered > 16 * 1024 * 1024) void bridge.close().finally(() => process.exit(1));
  });
  reader.on('line', line => {
    buffered = 0;
    let frame;
    try { frame = JSON.parse(line); }
    catch { void bridge.close().finally(() => process.exit(1)); return; }
    Promise.resolve().then(() => {
      if (!['open', 'send', 'cancel', 'answer', 'child_transcript'].includes(frame.method)) throw new Error('Unknown lux-ade bridge method');
      return bridge[frame.method](frame.params ?? {});
    }).then(result => emit({ id: frame.id, result }), error => emit({ id: frame.id, error: { message: error.message } }));
  });
  const stop = () => void bridge.close().finally(() => process.exit(0));
  reader.on('close', stop); process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) serve();
