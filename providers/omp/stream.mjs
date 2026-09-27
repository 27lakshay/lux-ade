import { assistantIdentity } from './history.mjs'

export class TextStream {
  constructor() {
    this.parts = new Map()
    this.bytes = 0
  }
  consume(frame, turn) {
    if (!['message_start', 'message_update', 'message_end'].includes(frame.type) || frame.message?.role !== 'assistant')
      return []
    const message = frame.message
    const base = assistantIdentity(message, turn, null)
    // Some model backends do not expose a response ID. Their completed text is
    // delivered from durable entries; inventing a temporary ID would duplicate
    // it on recovery. A later update with an ID catches up from its full snapshot.
    if (!base) return []
    const result = []
    const status =
      frame.type !== 'message_end'
        ? 'streaming'
        : message.stopReason === 'error'
          ? 'failed'
          : message.stopReason === 'aborted'
            ? 'interrupted'
            : 'completed'
    for (const [index, block] of message.content.entries()) {
      if (block.type !== 'text') continue
      const id = `${base}:${index}`,
        previous = this.parts.get(id)
      if (typeof block.text !== 'string') throw new Error('Invalid Oh My Pi streaming text')
      const bytes = Buffer.byteLength(block.text)
      if (
        bytes > 1024 * 1024 ||
        (!previous && this.parts.size >= 2000) ||
        this.bytes - (previous?.bytes ?? 0) + bytes > 12 * 1024 * 1024
      )
        throw new Error('Oh My Pi stream exceeds lux-ade content limits')
      if (previous?.text === block.text && previous.status === status) continue
      if (
        previous &&
        status === 'streaming' &&
        previous.status === 'streaming' &&
        block.text.startsWith(previous.text)
      ) {
        result.push({
          type: 'delta',
          turn,
          id,
          role: 'assistant',
          kind: 'text',
          text: block.text.slice(previous.text.length),
        })
      } else {
        result.push({
          type: 'item',
          item: { id, client_id: null, turn, role: 'assistant', kind: 'text', text: block.text, status },
        })
      }
      this.bytes += bytes - (previous?.bytes ?? 0)
      this.parts.set(id, { text: block.text, status, bytes })
    }
    return result
  }
}
