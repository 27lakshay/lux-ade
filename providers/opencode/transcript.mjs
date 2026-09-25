import { toolContent } from '../tool.mjs';

// OpenCode messages become lux-ade Items at this boundary. Keep provider storage,
// reasoning blocks and file bytes out of the visible transcript projection.
const outcome = { succeeded: 'completed', failed: 'failed', interrupted: 'interrupted' };

function item(id, turn, role, kind, text, status = 'completed', client_id = null) {
  if (typeof text !== 'string') throw new Error('Invalid OpenCode transcript text');
  if (Buffer.byteLength(text) > (role === 'user' ? 9 : 1) * 1024 * 1024) {
    throw new Error('OpenCode transcript item exceeds the content limit');
  }
  return { id, client_id, turn, role, kind, text, status };
}

export function projectMessage(message, turn) {
  if (typeof message.id !== 'string' || !message.id.startsWith('msg_')) throw new Error('Invalid OpenCode message identity');
  if (message.type === 'user') {
    return [item(message.id, message.id, 'user', 'text', message.text, 'completed', message.metadata?.ade_submission ?? null)];
  }
  if (message.type === 'assistant') {
    const result = [];
    const completed = message.time?.completed !== undefined;
    for (const [ordinal, part] of message.content.entries()) {
      if (part.type === 'text') {
        result.push(item(`${message.id}:${ordinal}`, turn, 'assistant', 'text', part.text, completed ? 'completed' : 'streaming'));
      } else if (part.type === 'tool') {
        const id = `${message.id}:tool:${part.id}`;
        const state = part.state;
        const status = state.status === 'error' ? 'failed' : state.status === 'completed' ? 'completed' : 'streaming';
        result.push({ ...item(id, turn, 'tool', part.name, JSON.stringify(state.input ?? {}, null, 2), status), content: toolContent(part.id, part.name, { input: state.input ?? {}, is_error: status === 'failed' }) });
        const content = (state.content ?? []).map((entry) => {
          if (entry.type === 'text') return entry.text;
          if (entry.type === 'file') return `File: ${entry.name ?? 'attachment'} (${entry.mime})`;
          throw new Error('Unsupported OpenCode tool result content');
        });
        if (state.error) content.push(state.error.message);
        if (content.length) result.push({ ...item(`${id}:result`, turn, 'tool', 'toolResult', content.join('\n'), status), content: toolContent(part.id, part.name, { output: content.join('\n'), is_error: status === 'failed' }) });
        // The native subagent tool publishes child identity/state as metadata.
        // Its completed operation may have only started a background child.
        // Never recover identity by parsing model-visible result text.
        const child = state.metadata;
        if (part.name === 'subagent' && state.status === 'completed' &&
            typeof child?.sessionID === 'string' && child.sessionID.length > 0 &&
            Buffer.byteLength(child.sessionID) <= 4096 && ['running', 'completed'].includes(child.status)) {
          const name = typeof state.input?.agent === 'string' && Buffer.byteLength(state.input.agent) <= 256 ? state.input.agent : null;
          result.push({ ...item(`${id}:subagent`, turn, 'tool', 'subagent', `${name ?? child.sessionID}: ${child.status}`, status),
            content: { type: 'subagents', operation: 'subagent', agents: [{ id: child.sessionID, session_id: child.sessionID, name, state: child.status, summary: null }] } });
        }
      } else if (part.type !== 'reasoning') {
        throw new Error(`Unsupported OpenCode content type: ${part.type}`);
      }
    }
    if (message.error) result.push(item(`${message.id}:error`, turn, 'system', 'error', message.error.message, 'failed'));
    return result;
  }
  if (message.type === 'shell') {
    return [item(message.id, turn, 'tool', 'shell', `${message.command}\n${message.output?.output ?? ''}`, message.status === 'running' ? 'streaming' : message.status === 'exited' && message.exit === 0 ? 'completed' : 'failed')];
  }
  if (message.type === 'compaction') {
    return [item(message.id, turn, 'system', 'compaction', 'Context compaction', message.status === 'completed' ? 'completed' : message.status === 'failed' ? 'failed' : 'streaming')];
  }
  if (['idle', 'system', 'synthetic', 'skill', 'agent-switched', 'model-switched', 'location-switched', 'agent-selected', 'model-selected'].includes(message.type)) return [];
  throw new Error(`Unsupported OpenCode message type: ${message.type}`);
}

export function projectHistory(messages) {
  const items = [];
  const completions = new Map();
  let turn = null;
  let lastError = null;
  let bytes = 0;
  for (const message of messages) {
    if (message.type === 'user') { turn = message.id; lastError = null; }
    if (message.type === 'assistant' && message.error) lastError = message.error.message;
    if (message.type === 'idle' && turn) {
      if (!outcome[message.outcome]) throw new Error('Unknown OpenCode execution outcome');
      completions.set(turn, { turn, status: outcome[message.outcome], error: message.outcome === 'failed' ? lastError ?? 'OpenCode execution failed' : null });
    }
    for (const entry of projectMessage(message, turn)) {
      bytes += Buffer.byteLength(JSON.stringify(entry));
      if (bytes > 12 * 1024 * 1024 || items.length >= 2000) throw new Error('OpenCode history exceeds lux-ade admission limits');
      items.push(entry);
    }
  }
  return { items, completions, lastTurn: turn };
}

// Compare canonical Items, not arrival order. A replay or reconnect may replace
// a streaming prefix with a complete value, but must never append it twice.
export function updates(previous, next) {
  const result = [];
  for (const entry of next) {
    const before = previous.get(entry.id);
    if (before && JSON.stringify(before) === JSON.stringify(entry)) continue;
    if (before && entry.role === 'assistant' && entry.kind === 'text' &&
        before.status === 'streaming' && entry.status === 'streaming' &&
        before.turn === entry.turn && entry.text.startsWith(before.text)) {
      result.push({ type: 'delta', turn: entry.turn, id: entry.id, role: entry.role, kind: entry.kind, text: entry.text.slice(before.text.length) });
    } else {
      result.push({ type: 'item', item: entry });
    }
    previous.set(entry.id, entry);
  }
  return result;
}
