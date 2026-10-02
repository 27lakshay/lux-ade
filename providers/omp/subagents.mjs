import { createHash } from 'node:crypto'

const states = { started: 'running', completed: 'completed', failed: 'failed', aborted: 'interrupted' }
const bounded = (value, limit) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= limit

// Lifecycle records belong to the turn that started the child, even when a
// detached child finishes after its parent turn. lux-ade persists emitted Items.
export class Subagents {
  constructor() {
    this.children = new Map()
  }
  consume(frame, turn) {
    if (frame.type !== 'subagent_lifecycle') return null
    const p = frame.payload
    if (
      !p ||
      !bounded(p.id, 4096) ||
      !bounded(p.agent, 256) ||
      !states[p.status] ||
      (p.parentToolCallId !== undefined && !bounded(p.parentToolCallId, 4096))
    )
      throw new Error('Invalid Oh My Pi child lifecycle')
    const key = JSON.stringify([p.parentToolCallId ?? null, p.id])
    const before = this.children.get(key)
    if (!before && p.status !== 'started') return null
    // Native parked-agent wakes reuse the same child and parent tool call.
    // Their ordered start event is a new run, even without a live parent turn.
    if (before?.terminal && p.status !== 'started') return null
    if (!before && this.children.size >= 256) {
      const retired = [...this.children].find(([, child]) => child.terminal)
      if (!retired) throw new Error('Oh My Pi exceeds 256 active child agents')
      this.children.delete(retired[0])
    }
    const owner = before?.turn ?? turn
    const summary = bounded(p.description, 16384) ? p.description : (before?.summary ?? null)
    const id =
      before?.id ??
      `subagent:${createHash('sha256')
        .update(JSON.stringify([owner, key]))
        .digest('hex')}`
    const state = states[p.status]
    const item = {
      id,
      client_id: null,
      turn: owner,
      role: 'tool',
      kind: 'subagent',
      text: `${p.agent}: ${state}`,
      status: 'completed',
      content: {
        type: 'subagents',
        operation: 'task',
        agents: [{ id: p.id, session_id: null, name: p.agent, state, summary }],
      },
    }
    const encoded = JSON.stringify(item)
    this.children.set(key, { id, turn: owner, summary, terminal: p.status !== 'started', encoded })
    return before?.encoded === encoded ? null : item
  }
}
