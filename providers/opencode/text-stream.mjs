import { projectMessage, updates } from './transcript.mjs';

// Text deltas are volatile in OpenCode. A delta can be appended only after its
// start was observed on this connection. After a gap, wait for the full ended
// value; otherwise the first resumed delta could duplicate or omit a prefix.
export class TextStream {
  constructor(session, previous = new Map()) {
    this.session = session;
    this.previous = previous;
    this.parts = new Map();
    this.seen = new Set();
    this.bytes = [...previous.values()].reduce((total, entry) => total + Buffer.byteLength(entry.text), 0);
  }

  disconnected() {
    this.parts.clear();
    this.seen.clear();
  }

  consume(event, turn) {
    if (!['session.text.started', 'session.text.delta', 'session.text.ended'].includes(event.type)) return [];
    const data = event.data;
    if (data?.sessionID !== this.session || !turn) return [];
    if (typeof data.assistantMessageID !== 'string' || !data.assistantMessageID.startsWith('msg_') ||
        !Number.isSafeInteger(data.ordinal) || data.ordinal < 0 || data.ordinal > 2000) {
      throw new Error('Invalid OpenCode text event identity');
    }
    if (typeof event.id !== 'string') throw new Error('OpenCode text event omitted its identity');
    if (this.seen.has(event.id)) return [];
    this.seen.add(event.id);
    if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value);
    const id = `${data.assistantMessageID}:${data.ordinal}`;
    if (this.previous.has(id) && this.previous.get(id).turn !== turn) return [];
    if (event.type === 'session.text.started') {
      // A repeated start must not erase a prefix already displayed.
      if (this.parts.has(id)) return [];
      if (this.parts.size >= 2000) throw new Error('Too many OpenCode text fragments');
      const before = this.previous.get(id);
      if (before?.text || before?.status === 'completed') return [];
      this.parts.set(id, { text: '', bytes: 0, turn });
      return this.#publish(data, '', turn, false);
    }
    if (event.type === 'session.text.delta') {
      const part = this.parts.get(id);
      if (!part || part.turn !== turn) return [];
      if (typeof data.delta !== 'string') throw new Error('Invalid OpenCode text delta');
      const size = Buffer.byteLength(data.delta);
      if (part.bytes + size > 1024 * 1024 || this.bytes + size > 12 * 1024 * 1024) throw new Error('OpenCode streaming text exceeds the content limit');
      part.text += data.delta;
      part.bytes += size;
      this.bytes += size;
      const before = this.previous.get(id);
      this.previous.set(id, { ...before, text: part.text });
      return data.delta ? [{ type: 'delta', turn, id, role: 'assistant', kind: 'text', text: data.delta }] : [];
    }
    this.parts.delete(id);
    if (typeof data.text !== 'string') throw new Error('Invalid OpenCode completed text');
    return this.#publish(data, data.text, turn, true);
  }

  #publish(data, text, turn, complete) {
    // Preserve the ordinal used by history without allocating sparse content
    // arrays or manufacturing unused blocks for earlier reasoning/tool parts.
    const entry = projectMessage({ id: data.assistantMessageID, type: 'assistant', time: complete ? { completed: 0 } : {}, content: [{ type: 'text', text }] }, turn)[0];
    entry.id = `${data.assistantMessageID}:${data.ordinal}`;
    this.#account([entry]);
    return updates(this.previous, [entry]);
  }

  #account(items) {
    let total = this.bytes;
    let count = this.previous.size;
    for (const entry of items) {
      const before = this.previous.get(entry.id);
      if (!before) count++;
      total += Buffer.byteLength(entry.text) - Buffer.byteLength(before?.text ?? '');
    }
    if (total > 12 * 1024 * 1024 || count > 2000) throw new Error('OpenCode streaming transcript exceeds lux-ade limits');
    this.bytes = total;
  }

  reconcile(items) {
    const canonical = items.filter((entry) => {
      const before = this.previous.get(entry.id);
      // Durable storage contains empty text until Text.Ended. Do not replace a
      // live prefix with that empty placeholder during unrelated tool events.
      return !(entry.role === 'assistant' && entry.kind === 'text' && entry.status === 'streaming' &&
        entry.text === '' && before?.text);
    });
    for (const entry of canonical) {
      if (entry.status === 'completed' || entry.status === 'failed' ||
          (entry.role === 'assistant' && entry.kind === 'text' && entry.text !== '')) this.parts.delete(entry.id);
    }
    this.#account(canonical);
    return updates(this.previous, canonical);
  }
}
