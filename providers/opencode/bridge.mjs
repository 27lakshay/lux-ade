import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenCodeTransport } from './transport.mjs';
import { SessionApi } from './session-api.mjs';
import { projectHistory, projectMessage } from './transcript.mjs';
import { TextStream } from './text-stream.mjs';

export class Bridge {
  constructor(emit, { cwd = process.cwd(), connect = async () => {
    const transport = await OpenCodeTransport.start({ cwd });
    try { return { transport, api: await SessionApi.connect(transport) }; }
    catch (error) { await transport.stop(); throw error; }
  } } = {}) {
    this.emit = emit; this.cwd = cwd; this.connect = connect;
    this.closed = new AbortController(); this.requests = new Map();
    this.session = null; this.active = null; this.epoch = 0; this.ready = false;
  }
  event(value) { this.emit({ method: 'event', params: value }); }
  async open({ resume, config = {} }) {
    if (this.opening || this.transport) throw new Error('OpenCode session already opened');
    this.opening = true;
    if (!['default'].includes(config.permission_mode ?? 'default')) throw new Error('Unsupported OpenCode permission mode');
    let model;
    if (config.model) {
      const slash = config.model.indexOf('/');
      if (slash <= 0 || slash === config.model.length - 1) throw new Error('Use provider/model for an OpenCode model');
      model = { providerID: config.model.slice(0, slash), id: config.model.slice(slash + 1) };
    }
    ({ transport: this.transport, api: this.api } = await this.connect());
    try {
      const info = await this.api.open({ resume, cwd: this.cwd, model });
      this.session = info.id;
      this.text = new TextStream(this.session);
      let connected;
      const firstConnection = new Promise((resolve) => { connected = resolve; });
      this.pump = this.consume(connected).catch((error) => this.fail(error));
      await Promise.race([firstConnection, delay(10_000, null, { signal: this.closed.signal }).then(() => { throw new Error('OpenCode event subscription timed out'); })]);
      const history = projectHistory(await this.history());
      this.text.reconcile(history.items);
      this.knownTurns = new Set(history.items.filter(item => item.role === 'user').map(item => item.turn));
      const pending = await this.api.pending(this.session);
      if (pending.active) throw new Error('OpenCode session is already executing; ownership transfer is required');
      if (pending.inbox.length) {
        if (pending.inbox.length !== 1 || pending.inbox[0].type !== 'user' || !pending.inbox[0].payload.metadata?.ade_submission) {
          throw new Error('OpenCode has pending work that lux-ade cannot claim');
        }
        const entry = pending.inbox[0];
        this.active = { turn: entry.id, submission: entry.payload.metadata.ade_submission, recovery: true };
        this.knownTurns.add(entry.id);
        this.event({ type: 'started', session: this.session, turn: entry.id });
        this.request(`recover:${entry.id}`, 'opencode/recover', { reason: 'Resume the pending OpenCode prompt, or decline to cancel it.', prompt: entry.payload.text }, 'recover');
      }
      this.ready = true;
      this.fallback = setInterval(() => { this.schedule(); }, 5000);
      this.schedule();
      return { session: this.session, history: history.items };
    } catch (error) { await this.close(); throw error; }
  }
  async history(turn = null) {
    const messages = [];
    let bytes = 0;
    for await (const message of this.api.messages(this.session, { order: turn ? 'desc' : 'asc', signal: this.closed.signal })) {
      bytes += Buffer.byteLength(JSON.stringify(message));
      if (messages.length >= 2000 || bytes > 16 * 1024 * 1024) throw new Error('OpenCode history exceeds lux-ade admission limits');
      messages.push(message);
      if (turn && message.id === turn) break;
    }
    return turn ? messages.reverse() : messages;
  }
  async child_transcript({ session, child, offset = 0, cursor = null }) {
    if (!this.ready || this.closed.signal.aborted || session !== this.session) throw new Error('OpenCode parent session is not connected');
    if (typeof child !== 'string' || !/^ses[a-zA-Z0-9_-]{1,256}$/.test(child)) throw new Error('Invalid OpenCode child identity');
    if (offset !== 0) throw new Error('OpenCode child reader requires a continuation cursor');
    const page = await this.api.childMessages(session, child, cursor, this.closed.signal);
    const items = [];
    let bytes = 0;
    for (const message of page.messages) {
      for (const item of projectMessage(message, null)) {
        bytes += Buffer.byteLength(JSON.stringify(item));
        if (bytes > 2 * 1024 * 1024 || items.length >= 1000) throw new Error('OpenCode child page exceeds display limits');
        items.push(item);
      }
    }
    return { type: 'child_transcript', child_id: child, items, next_cursor: page.next_cursor };
  }
  async consume(connected) {
    let failures = 0;
    while (!this.closed.signal.aborted) {
      try {
        for await (const event of this.transport.events({ signal: this.closed.signal })) {
          failures = 0;
          if (event.type === 'server.connected') { connected(); this.schedule(); continue; }
          if (event.data?.sessionID !== this.session || !this.ready) continue;
          try {
            for (const update of this.text.consume(event, this.active?.turn)) this.event({ ...update, session: this.session });
          } catch (error) { await this.fail(error); return; }
          if (!['session.text.delta', 'session.reasoning.delta', 'session.tool.input.delta'].includes(event.type)) this.schedule();
        }
      } catch {
        if (this.closed.signal.aborted) return;
        this.epoch++; this.text.disconnected();
        if (++failures > 5) throw new Error('OpenCode event connection could not recover');
        await delay(Math.min(100 * 2 ** failures, 2000), undefined, { signal: this.closed.signal });
      }
    }
  }
  schedule() {
    this.dirty = true;
    if (!this.ready || this.timer || this.refreshing || this.closed.signal.aborted) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refreshing = this.refresh().then(() => { this.refreshFailures = 0; }).catch(async (error) => {
        if ((error instanceof TypeError || error.status >= 500) && (this.refreshFailures = (this.refreshFailures ?? 0) + 1) <= 5) {
          this.dirty = true;
          await delay(250 * this.refreshFailures, undefined, { signal: this.closed.signal }).catch(() => {});
        } else await this.fail(error);
      }).finally(() => {
        this.refreshing = null;
        if (this.dirty) this.schedule();
      });
    }, 30);
  }
  async refresh() {
    this.dirty = false;
    let active = this.active;
    if (active?.sending || active?.recovery || active?.cancelling) return;
    if (!active) {
      const epoch = this.epoch;
      const projection = projectHistory(await this.history());
      if (epoch !== this.epoch || this.active || this.closed.signal.aborted) return;
      // The attached native TUI admits work directly to the same server. A
      // durable user message, not a volatile delta, establishes turn identity.
      for (const user of projection.items.filter(item => item.role === 'user')) {
        if (this.knownTurns.has(user.turn)) continue;
        this.knownTurns.add(user.turn);
        active = this.active = { turn: user.turn, external: true };
        this.event({ type: 'started', session: this.session, turn: user.turn });
        for (const update of this.text.reconcile(projection.items.filter(item => item.turn === user.turn))) this.event({ ...update, session: this.session });
        const completion = projection.completions.get(user.turn);
        if (!completion) break;
        this.active = active = null;
        this.event({ type: 'finished', session: this.session, ...completion });
      }
      if (!active) return;
    }
    const epoch = this.epoch;
    const [messages, pending] = await Promise.all([this.history(active.turn), this.api.pending(this.session)]);
    if (epoch !== this.epoch || active !== this.active || active.cancelling || this.closed.signal.aborted) return;
    const projection = projectHistory(messages);
    for (const update of this.text.reconcile(projection.items.filter(item => item.turn === active.turn))) this.event({ ...update, session: this.session });
    const completion = projection.completions.get(active.turn);
    if (completion) {
      this.active = null;
      this.resolveAll();
      this.event({ type: 'finished', session: this.session, ...completion });
      this.schedule();
      return;
    }
    const seen = new Set();
    for (const permission of pending.permissions) {
      seen.add(permission.id);
      this.request(permission.id, 'opencode/toolApproval', { tool: permission.action, reason: permission.message, resources: permission.resources }, 'permission');
    }
    for (const form of pending.forms) {
      seen.add(form.id);
      const supported = form.fields.every((field) => field.type === 'string' && !field.when?.length);
      this.request(form.id, 'opencode/questions', { reason: form.title, questions: form.fields.map((field) => ({ id: field.key, question: field.title ?? field.key, header: field.description, options: field.options?.map((option) => ({ label: option.value, description: option.label })) })) }, 'form', supported);
    }
    for (const [id, request] of this.requests) {
      if (request.kind !== 'recover' && !seen.has(id)) this.resolve(id);
    }
  }
  request(id, method, params, kind, supported = true) {
    if (this.requests.has(id)) return;
    this.requests.set(id, { kind, turn: this.active.turn, responding: false });
    this.event({ type: 'request', session: this.session, turn: this.active.turn, id, method, params, supported });
  }
  resolve(id) { if (this.requests.delete(id)) this.event({ type: 'resolved', id }); }
  resolveAll() { for (const id of this.requests.keys()) this.resolve(id); }
  async send({ session, submission, message_id, text, attachments = [] }) {
    if (!this.ready || session !== this.session || this.closed.signal.aborted) throw new Error('OpenCode session is not connected');
    if (this.active) throw new Error('OpenCode already has an active turn');
    if (typeof message_id !== 'string' || !message_id.startsWith('msg_')) throw new Error('Missing durable OpenCode message identity');
    // Reserve synchronously before the admission await so event refresh cannot
    // interpret a not-yet-admitted message as a completed turn.
    const active = { turn: message_id, submission, sending: true };
    this.active = active;
    this.knownTurns.add(message_id);
    try {
      const pending = await this.api.pending(session);
      if (pending.active || pending.inbox.length) {
        this.active = null;
        this.knownTurns.delete(message_id);
        this.schedule();
        throw Object.assign(new Error('OpenCode has work from another view; wait for it before submitting'), { admissionConflict: true });
      }
      this.event({ type: 'started', session, turn: message_id });
      await this.api.submit(session, { id: message_id, submission, text, attachments });
      active.sending = false;
      this.schedule();
      return { turn: message_id };
    } catch (error) { if (!error.admissionConflict) await this.fail(error); throw error; }
  }
  async cancel({ session, turn }) {
    if (session !== this.session || this.active?.turn !== turn) throw new Error('OpenCode turn is no longer active');
    if (this.active.sending) throw new Error('OpenCode prompt admission is still in progress');
    if (this.active.cancelling) throw new Error('OpenCode cancellation is already in progress');
    const active = this.active;
    active.cancelling = true;
    try {
    const pending = await this.api.pending(session);
    if (pending.inbox.some((entry) => entry.id === turn)) {
      try { await this.api.cancelQueued(session, turn); }
      catch (error) { if (error.status !== 409) throw error; }
    }
    await this.api.interrupt(session);
    const after = await this.api.pending(session);
    if (after.active || after.inbox.some((entry) => entry.id === turn)) throw new Error('OpenCode could not confirm cancellation');
    const projection = projectHistory(await this.history(turn));
    for (const update of this.text.reconcile(projection.items)) this.event({ ...update, session });
    const completion = projection.completions.get(turn) ?? { turn, status: 'interrupted', error: null };
    this.active = null; this.resolveAll();
    this.event({ type: 'finished', session, ...completion });
    return {};
    } finally { active.cancelling = false; }
  }
  async answer({ id, decision, answers }) {
    const request = this.requests.get(id);
    if (!request || request.turn !== this.active?.turn || request.responding || this.active.cancelling) throw new Error('OpenCode request is stale');
    if (!['accept', 'decline', 'answer'].includes(decision)) throw new Error('Unknown decision');
    request.responding = true;
    try {
      if (request.kind === 'recover') {
        if (decision === 'decline') return await this.cancel({ session: this.session, turn: request.turn });
        if (decision !== 'accept') throw new Error('Choose resume or cancel');
        await this.api.resumeQueued(this.session, request.turn);
        this.active.recovery = false;
      } else if (request.kind === 'permission') {
        await this.api.permission(this.session, id, decision);
      } else {
        if (decision !== 'decline' && decision !== 'answer') throw new Error('Answer the questions or decline');
        if (decision === 'answer' && (!answers || typeof answers !== 'object' || Array.isArray(answers))) throw new Error('Answers are required');
        await this.api.form(this.session, id, decision === 'decline' ? null : answers);
      }
      this.resolve(id); this.schedule();
      return {};
    } finally { request.responding = false; }
  }
  async fail(error) {
    if (this.closed.signal.aborted) return;
    this.event({ type: 'exited', error: error.message });
    await this.close();
  }
  async close() {
    this.closed.abort(); this.ready = false;
    clearInterval(this.fallback); clearTimeout(this.timer);
    await this.transport?.stop();
  }
}

export function serve() {
  const emit = (value) => {
    const line = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(line) > 16 * 1024 * 1024) throw new Error('OpenCode bridge frame exceeds 16 MiB');
    if (!process.stdout.write(line) && process.stdout.writableLength > 16 * 1024 * 1024) throw new Error('lux-ade is not consuming OpenCode output');
  };
  const bridge = new Bridge(emit);
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let buffered = 0;
  process.stdin.on('data', (chunk) => { buffered += chunk.length; if (buffered > 16 * 1024 * 1024) void bridge.close().finally(() => process.exit(1)); });
  reader.on('line', (line) => {
    buffered = 0;
    let frame;
    try { frame = JSON.parse(line); } catch { void bridge.close().finally(() => process.exit(1)); return; }
    Promise.resolve().then(() => {
      if (!['open', 'send', 'cancel', 'answer', 'child_transcript'].includes(frame.method)) throw new Error('Unknown lux-ade bridge method');
      return bridge[frame.method](frame.params ?? {});
    }).then((result) => emit({ id: frame.id, result }), (error) => emit({ id: frame.id, error: { message: error.message } }));
  });
  const stop = () => void bridge.close().finally(() => process.exit(0));
  reader.on('close', stop); process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) serve();
