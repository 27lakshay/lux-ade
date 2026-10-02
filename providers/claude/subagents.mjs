import { createHash } from 'node:crypto'

const bounded = (value, max) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max
const terminal = { completed: 'completed', failed: 'failed', stopped: 'interrupted' }

export class Subagents {
  constructor() {
    this.tasks = new Map()
  }
  consume(message, context) {
    if (message.type !== 'system' || !['task_started', 'task_progress', 'task_notification'].includes(message.subtype))
      return null
    if (!bounded(message.task_id, 4096)) throw new Error('Invalid Claude task identity')
    const before = this.tasks.get(message.task_id)
    const startsAgent =
      message.subtype === 'task_started' &&
      message.task_type === 'local_agent' &&
      context?.session &&
      !message.skip_transcript &&
      !message.ambient
    // A resumed native task keeps its identity but gets a new Agent tool call.
    // Notifications can omit that call ID; retain the latest one to fence old
    // explicit outcomes without moving the child card into a different turn.
    const resumed = before && startsAgent && bounded(message.tool_use_id, 4096) && message.tool_use_id !== before.tool
    if (!before) {
      // Claude also emits these events for Bash, MCP and workflow tasks.
      if (!startsAgent) return null
      if (this.tasks.size >= 256) {
        const retired = [...this.tasks].find(([, task]) => task.terminal)
        if (!retired) throw new Error('Claude exceeds 256 active child agents')
        this.tasks.delete(retired[0])
      }
    }
    if (before?.terminal && !resumed) return null
    if (!resumed && before?.tool && message.tool_use_id && before.tool !== message.tool_use_id) return null
    const state = message.subtype === 'task_notification' ? terminal[message.status] : 'running'
    if (!state) throw new Error('Unknown Claude child outcome')
    const owner = before?.owner ?? context
    const name = bounded(message.subagent_type, 256) ? message.subagent_type : (before?.name ?? null)
    const summary = bounded(message.summary, 16384)
      ? message.summary
      : bounded(message.description, 16384)
        ? message.description
        : (before?.summary ?? null)
    const id =
      before?.id ??
      `subagent:${createHash('sha256')
        .update(JSON.stringify([owner.session, message.task_id]))
        .digest('hex')}`
    const item = {
      id,
      client_id: null,
      turn: owner.turn ?? null,
      role: 'tool',
      kind: 'subagent',
      text: `${name ?? message.task_id}: ${state}`,
      status: 'completed',
      content: {
        type: 'subagents',
        operation: 'Agent',
        agents: [{ id: message.task_id, session_id: null, name, state, summary }],
      },
    }
    const encoded = JSON.stringify(item)
    this.tasks.set(message.task_id, {
      id,
      owner,
      tool: resumed ? message.tool_use_id : (before?.tool ?? message.tool_use_id),
      name,
      summary,
      terminal: state !== 'running',
      encoded,
    })
    return before?.encoded === encoded ? null : item
  }
}
