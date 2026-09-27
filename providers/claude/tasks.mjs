import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { planItem } from '../plan.mjs';

const tools = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);
const states = new Set(['pending', 'in_progress', 'completed']);
const string = value => typeof value === 'string' && value.trim() && value.length <= 4096;
function task(value) {
  if (!value || !string(value.id) || !string(value.subject) || !states.has(value.status ?? 'pending')) throw new Error('Invalid Claude task');
  const blockedBy = value.blockedBy ?? [];
  if (!Array.isArray(blockedBy) || blockedBy.length > 256 || !blockedBy.every(string)) throw new Error('Invalid Claude task dependencies');
  return { id: value.id, subject: value.subject, status: value.status ?? 'pending', blockedBy };
}

// This index holds SDK result metadata omitted by getSessionMessages. Task inputs
// and transcript order still come from the SDK, so it is not a second task store.
export class TaskPlans {
  constructor() { this.pending = new Map(); this.tasks = new Map(); this.receipts = new Map(); }
  open(session, directory) {
    if (!directory) return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, createHash('sha256').update(session).digest('hex') + '.json');
    try {
      const data = readFileSync(this.file);
      if (data.length > 1024 * 1024) throw new Error('Claude task index exceeds 1 MiB');
      const parsed = JSON.parse(data);
      if (parsed.version !== 1 || !Array.isArray(parsed.receipts) || parsed.receipts.length > 2000) throw new Error('Invalid Claude task index');
      this.receipts = new Map(parsed.receipts);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  remember(id, receipt) {
    const previous = this.receipts.get(id);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(receipt)) throw new Error('Claude task result changed identity');
      return;
    }
    const next = new Map(this.receipts); next.set(id, receipt);
    const data = JSON.stringify({ version: 1, receipts: [...next] });
    if (next.size > 2000 || Buffer.byteLength(data) > 1024 * 1024) throw new Error('Claude task index exceeds admission limits');
    if (this.file) {
      const temporary = this.file + '.' + randomUUID();
      let fd;
      try {
        writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' });
        fd = openSync(temporary, 'r'); fsyncSync(fd); closeSync(fd); fd = undefined;
        renameSync(temporary, this.file);
      // oxlint-disable-next-line no-unsafe-finally -- a cleanup failure other than a missing file must surface
      } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    }
    this.receipts = next;
  }
  start(block, turn) {
    if (!tools.has(block.name)) return;
    if (this.pending.size >= 256) throw new Error('Too many pending Claude task calls');
    this.pending.set(block.id, { name: block.name, input: block.input ?? {}, turn });
  }
  result(block, metadata) {
    const call = this.pending.get(block.tool_use_id);
    if (!call) return null;
    this.pending.delete(block.tool_use_id);
    if (block.is_error) return null;
    let receipt;
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      if (call.name === 'TaskCreate' || call.name === 'TaskGet') {
        receipt = { task: metadata.task === null ? null : task(metadata.task) };
      } else if (call.name === 'TaskList') {
        if (!Array.isArray(metadata.tasks) || metadata.tasks.length > 256) throw new Error('Invalid Claude task list');
        receipt = { tasks: metadata.tasks.map(task) };
      } else {
        if (typeof metadata.success !== 'boolean' || !string(metadata.taskId)) throw new Error('Invalid Claude task update');
        receipt = { success: metadata.success, taskId: metadata.taskId };
      }
      this.remember(block.tool_use_id, receipt);
    } else receipt = this.receipts.get(block.tool_use_id);
    // Sessions created outside lux-ade may not have this index. Keep their tool
    // transcript, but do not invent task IDs from prose or report guessed state.
    if (!receipt) return null;
    if (call.name === 'TaskList') this.tasks = new Map(receipt.tasks.map(item => [item.id, item]));
    else if (call.name === 'TaskCreate' || call.name === 'TaskGet') {
      if (!receipt.task) {
        if (call.name !== 'TaskGet') return null;
        this.tasks.delete(call.input.taskId);
      } else {
        if (call.name === 'TaskGet' && receipt.task.id !== call.input.taskId) throw new Error('Claude returned a different task ID');
        this.tasks.set(receipt.task.id, task(receipt.task));
      }
    } else {
      if (!receipt.success) return null;
      const id = call.input.taskId;
      if (id !== receipt.taskId) throw new Error('Claude task update returned a different task ID');
      if (call.input.status === 'deleted') this.tasks.delete(id);
      else {
        const current = this.tasks.get(id);
        if (!current) return null;
        const blockedBy = [...new Set([...current.blockedBy, ...(call.input.addBlockedBy ?? [])])];
        this.tasks.set(id, task({ ...current, subject: call.input.subject ?? current.subject, status: call.input.status ?? current.status, blockedBy }));
        for (const target of call.input.addBlocks ?? []) {
          const blocked = this.tasks.get(target);
          if (blocked) this.tasks.set(target, task({ ...blocked, blockedBy: [...new Set([...blocked.blockedBy, id])] }));
        }
      }
    }
    if (this.tasks.size > 256) throw new Error('Claude task plan exceeds 256 tasks');
    const todos = [...this.tasks.values()].map(value => {
      const unresolved = value.blockedBy.filter(id => this.tasks.get(id)?.status !== 'completed');
      return { content: `#${value.id} ${value.subject}${unresolved.length ? ' (blocked by #' + unresolved.join(', #') + ')' : ''}`, status: value.status === 'pending' && unresolved.length ? 'blocked' : value.status };
    });
    return planItem(`${call.turn ?? 'session'}:tasks`, call.turn, todos);
  }
}
