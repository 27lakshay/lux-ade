import { join } from 'node:path'
import { planItem } from '../plan.mjs'
import { toolContent, toolOutput } from '../tool.mjs'
import { TaskPlans } from './tasks.mjs'

export class Transcript {
  constructor(session, aliases = new Map()) {
    this.session = session
    this.aliases = aliases
    this.calls = new Map()
    this.callBytes = 0
    this.plans = new TaskPlans()
    this.plans.open(session, process.env.ADE_DATA_DIR ? join(process.env.ADE_DATA_DIR, 'claude-task-results') : null)
  }
  *project(message, sent = null) {
    if (message.parent_tool_use_id) return
    const role = message.type
    const body = message.message ?? {}
    const blocks = Array.isArray(body.content)
      ? body.content
      : typeof body.content === 'string'
        ? [{ type: 'text', text: body.content }]
        : []
    const native_message =
      typeof message.uuid === 'string'
        ? { provider: 'claude', session: this.session, message_id: message.uuid }
        : undefined
    const row = (id, role, kind, text, status = 'completed', client_id = null) => ({
      id,
      role,
      kind,
      text,
      status,
      client_id,
      turn: null,
      ...(native_message ? { native_message } : {}),
    })
    const event = (item, owner = sent) => ({
      type: 'item',
      session: this.session,
      submission: owner?.submission ?? null,
      item,
    })
    if (role === 'user' && blocks.some((block) => ['text', 'image', 'document'].includes(block.type)))
      yield event(
        row(
          this.aliases.get(message.uuid) ?? message.uuid,
          'user',
          'text',
          blocks
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n'),
          'completed',
          sent?.messageId ?? null,
        ),
      )
    for (const [index, block] of blocks.entries()) {
      if (block.type === 'text' && role === 'assistant')
        yield event(
          row(
            (body.id ?? this.aliases.get(message.uuid) ?? message.uuid) + ':' + index,
            role,
            'text',
            block.text ?? '',
          ),
        )
      else if (block.type === 'tool_use') {
        this.plans.start(block, null)
        const call = {
          ...row(block.id, 'tool', block.name ?? 'tool', JSON.stringify(block.input ?? {}, null, 2), 'streaming'),
          content: toolContent(block.id, block.name ?? 'tool', { input: block.input ?? {} }),
        }
        const bytes = Buffer.byteLength(JSON.stringify(call))
        const previous = this.calls.get(block.id)
        if ((!previous && this.calls.size >= 256) || this.callBytes - (previous?.bytes ?? 0) + bytes > 12 * 1024 * 1024)
          throw { code: 'resource_limit', message: 'Claude tool calls exceed admission limits' }
        this.callBytes += bytes - (previous?.bytes ?? 0)
        this.calls.set(block.id, { item: call, sent, bytes })
        yield event(call)
      } else if (block.type === 'tool_result') {
        const call = this.calls.get(block.tool_use_id)
        const owner = call?.sent ?? sent
        const status = block.is_error ? 'failed' : 'completed'
        if (call) {
          this.calls.delete(block.tool_use_id)
          this.callBytes -= call.bytes
          yield event({ ...call.item, status, content: { ...call.item.content, is_error: !!block.is_error } }, owner)
        }
        const output = toolOutput(block.content)
        yield event(
          {
            ...row(block.tool_use_id + ':result', 'tool', 'toolResult', output, status),
            content: toolContent(block.tool_use_id, call?.item.content.name ?? 'tool', {
              output,
              is_error: !!block.is_error,
            }),
          },
          owner,
        )
        const plan = this.plans.result(block, message.tool_use_result)
        if (plan) yield event({ ...plan, ...(native_message ? { native_message } : {}) }, owner)
        if (call?.item.content.name === 'TodoWrite' && !block.is_error)
          yield event(
            {
              ...planItem(block.tool_use_id + ':plan', null, call.item.content.input?.todos),
              ...(native_message ? { native_message } : {}),
            },
            owner,
          )
      }
    }
  }
}
