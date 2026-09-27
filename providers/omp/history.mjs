import { planItem, phasedTodos } from '../plan.mjs'
import { toolContent } from '../tool.mjs'

// get_entries returns append order across every branch. Only the leaf's ancestry
// belongs to the current transcript; timestamps and matching text are not IDs.
export function activeBranch({ entries, leafId }) {
  if (!Array.isArray(entries)) throw new Error('Invalid Oh My Pi entry list')
  const byId = new Map()
  for (const entry of entries) {
    if (typeof entry.id !== 'string' || !entry.id || byId.has(entry.id))
      throw new Error('Invalid or duplicate Oh My Pi entry ID')
    byId.set(entry.id, entry)
  }
  const branch = [],
    seen = new Set()
  for (let id = leafId; id !== null;) {
    if (seen.has(id)) throw new Error('Oh My Pi session contains an ancestry cycle')
    const entry = byId.get(id)
    if (!entry) throw new Error('Oh My Pi session ancestry is incomplete')
    seen.add(id)
    branch.push(entry)
    id = entry.parentId
  }
  return branch.reverse()
}

// Keep append-history cursors separate from the active leaf. A branch switch can
// change the leaf without appending an entry, and old ancestors remain needed.
export class EntryHistory {
  constructor(transport) {
    this.transport = transport
    this.entries = new Map()
    this.cursor = null
    this.leafId = null
    this.bytes = 0
    this.refreshing = null
  }
  refresh() {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.load().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }
  async load() {
    const result = await this.transport.request('get_entries', this.cursor ? { since: this.cursor } : {})
    if (!Array.isArray(result.entries)) throw new Error('Invalid Oh My Pi entry response')
    const next = new Map(this.entries)
    let bytes = this.bytes
    for (const entry of result.entries) {
      if (typeof entry.id !== 'string' || !entry.id || next.has(entry.id))
        throw new Error('Oh My Pi append-history changed unexpectedly')
      bytes += Buffer.byteLength(JSON.stringify(entry))
      if (next.size >= 50000 || bytes > 32 * 1024 * 1024)
        throw new Error('Oh My Pi session exceeds lux-ade history limits')
      next.set(entry.id, entry)
    }
    const snapshot = { entries: [...next.values()], leafId: result.leafId }
    activeBranch(snapshot) // Validate before advancing the durable-history cursor.
    this.entries = next
    this.bytes = bytes
    this.leafId = result.leafId
    this.cursor = result.entries.at(-1)?.id ?? this.cursor
    return snapshot
  }
}

function textContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) throw new Error('Invalid Oh My Pi message content')
  return content
    .map((block) => {
      if (block.type === 'text' && typeof block.text === 'string') return block.text
      if (block.type === 'image') return `[Image: ${block.mimeType ?? 'image'}]`
      throw new Error(`Unsupported Oh My Pi content block: ${block.type}`)
    })
    .join('\n')
}

export function assistantIdentity(message, turn, fallback) {
  return typeof message.responseId === 'string' && message.responseId.length > 0
    ? `response:${JSON.stringify([turn, message.responseId])}`
    : fallback
}

export function projectHistory(snapshot, identities = new Map()) {
  const items = []
  const positions = new Map()
  const calls = new Map()
  let turn = null,
    bytes = 0
  const add = (id, role, kind, text, status = 'completed', client_id = null, content, itemTurn = turn) => {
    if (typeof text !== 'string' || Buffer.byteLength(text) > (role === 'user' ? 9 : 1) * 1024 * 1024)
      throw new Error('Oh My Pi item exceeds lux-ade content limits')
    const item = { id, client_id, turn: itemTurn, role, kind, text, status, ...(content ? { content } : {}) }
    const position = positions.get(id)
    if (position !== undefined) bytes -= Buffer.byteLength(JSON.stringify(items[position]))
    bytes += Buffer.byteLength(JSON.stringify(item))
    if ((position === undefined && items.length >= 2000) || bytes > 12 * 1024 * 1024)
      throw new Error('Oh My Pi history exceeds lux-ade admission limits')
    if (position === undefined) {
      positions.set(id, items.length)
      items.push(item)
    } else items[position] = item
  }
  const addPlan = (phases) => {
    const item = planItem(`${turn ?? 'session'}:plan`, turn, phasedTodos(phases))
    add(item.id, item.role, item.kind, item.text, item.status, null, item.content)
  }
  for (const entry of activeBranch(snapshot)) {
    if (entry.type === 'reset_boundary') {
      items.length = 0
      positions.clear()
      calls.clear()
      bytes = 0
      turn = null
      continue
    }
    if (entry.type === 'custom' && entry.customType === 'user_todo_edit') {
      addPlan(entry.data?.phases)
      continue
    }
    if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      add(entry.id, 'system', entry.type, entry.summary)
      continue
    }
    if (entry.type !== 'message') continue
    const message = entry.message
    switch (message.role) {
      case 'user': {
        const identity = identities.get(entry.id)
        turn = identity?.turn ?? entry.id
        add(
          identity?.turn ?? entry.id,
          'user',
          'text',
          textContent(message.content),
          'completed',
          identity?.submission ?? null,
        )
        break
      }
      case 'assistant': {
        const id = assistantIdentity(message, turn, entry.id)
        const status =
          message.stopReason === 'error' ? 'failed' : message.stopReason === 'aborted' ? 'interrupted' : 'completed'
        for (const [index, block] of message.content.entries()) {
          if (block.type === 'text') add(`${id}:${index}`, 'assistant', 'text', block.text, status)
          else if (block.type === 'toolCall') {
            const toolId = `${entry.id}:tool:${block.id}`
            add(
              toolId,
              'tool',
              block.name,
              JSON.stringify(block.arguments ?? {}, null, 2),
              status === 'completed' ? 'streaming' : status,
              null,
              toolContent(block.id, block.name, { input: block.arguments ?? {} }),
            )
            calls.set(block.id, toolId)
          } else if (block.type !== 'thinking') throw new Error(`Unsupported Oh My Pi assistant content: ${block.type}`)
        }
        if (message.errorMessage) add(`${entry.id}:error`, 'system', 'error', message.errorMessage, status)
        break
      }
      case 'toolResult':
        if (calls.has(message.toolCallId)) {
          const previous = items[positions.get(calls.get(message.toolCallId))]
          add(
            previous.id,
            previous.role,
            previous.kind,
            previous.text,
            message.isError ? 'failed' : 'completed',
            null,
            { ...previous.content, is_error: !!message.isError },
            previous.turn,
          )
        }
        add(
          entry.id,
          'tool',
          'toolResult',
          textContent(message.content),
          message.isError ? 'failed' : 'completed',
          null,
          toolContent(message.toolCallId, message.toolName ?? 'tool', {
            output: textContent(message.content),
            is_error: !!message.isError,
          }),
        )
        if (
          message.toolName === 'todo' &&
          !message.isError &&
          message.details?.op !== 'view' &&
          Array.isArray(message.details?.phases)
        )
          addPlan(message.details.phases)
        break
      case 'bashExecution':
      case 'pythonExecution':
        add(
          entry.id,
          'tool',
          message.role,
          `${message.command ?? message.code ?? ''}\n${message.output ?? ''}`,
          message.cancelled ? 'interrupted' : message.exitCode === 0 ? 'completed' : 'failed',
        )
        break
      case 'custom':
        if (message.display !== false) add(entry.id, 'system', 'custom', textContent(message.content))
        break
      // Provider context messages are not user-visible transcript messages.
      case 'hookMessage':
      case 'fileMention':
      case 'compactionSummary':
      case 'branchSummary':
        break
      default:
        throw new Error(`Unsupported Oh My Pi message role: ${message.role}`)
    }
  }
  return { items, lastTurn: turn }
}
