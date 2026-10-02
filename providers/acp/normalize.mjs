// Pure Agent Client Protocol (ACP) v1 mapping for the ACP provider worker. No I/O.
//
// - `negotiate` reads the agent's `initialize` reply into the worker descriptor. Capabilities and
//   operations come only from what the agent declared; configuration cannot add any.
// - `TurnMapper` folds one live prompt turn's `session/update` notifications into ADE events.
// - `ReplayCapture` keeps a bounded `session/load` replay and yields history merged by native
//   identity only.
// - `permissionRequest` and `permissionOutcome` keep the agent's option IDs as the answer values.
import { DEFAULT_LIMITS, MAX_OUTPUT_FRAME_BYTES, SDK_REQUIREMENTS } from '@ade/provider-sdk'

/** The only ACP major version this worker speaks; the SDK's stable entry point is v1. */
export const ACP_VERSION = 1
export const PERMISSION_METHOD = 'session/request_permission'
const TEXT_LIMIT = 1024 * 1024
const TURN_BYTES = 4 * 1024 * 1024
const TOOL_LIMIT = 1024
const OPTION_LIMIT = 32
const ID_LIMIT = 256
/** A replay is retained up to this many entries and text bytes; the rest becomes a declared gap. */
export const REPLAY_ENTRIES = 512
export const REPLAY_BYTES = 2 * 1024 * 1024
const OPTION_KINDS = new Set(['allow_once', 'allow_always', 'reject_once', 'reject_always'])

export const failure = (code, message) => ({ code, message })

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const flag = (value) => value === true
const present = (value) => isRecord(value)
export const bounded = (value, limit) =>
  typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= limit && !value.includes('\0')
    ? value
    : null
const printable = (value, limit) =>
  bounded(value, limit) !== null && !/[\u0000-\u001f\u007f]/.test(value) ? value : null

const OPERATIONS = [
  ['initialize', 'query'],
  ['open', 'effect_command'],
  ['send', 'effect_command'],
  ['steer', 'effect_command'],
  ['cancel', 'idempotent_command'],
  ['answer', 'effect_command'],
  ['history', 'query'],
  ['configure_mcp', 'idempotent_command'],
  ['compact', 'effect_command'],
  ['rewind', 'effect_command'],
  ['child_transcript', 'query'],
]

const UNSUPPORTED = {
  steer: 'ACP v1 has no method to steer a running prompt turn',
  history: 'ACP v1 has no read-only history query; session/load replays history only while opening a session',
  configure_mcp:
    "ADE's ACP worker opens sessions without MCP servers; the profile MCP catalog does not reach ACP agents yet",
  compact: 'ACP v1 has no compaction method',
  rewind: 'ACP v1 cannot resume a session at an earlier message',
  child_transcript: 'ACP v1 has no child session transcripts',
}

/**
 * The worker descriptor for one negotiation. `init` is the agent's `initialize` result, or null
 * with `problem` set when negotiation failed; then open and send are unavailable with that reason,
 * so the failure is visible at probe and before any session exists.
 */
export function negotiate({ name, init, problem }) {
  let reason = problem ?? null
  let peer = { protocol: 'acp', features: [], auth_methods: [] }
  let features = new Set()
  if (!reason && !isRecord(init)) reason = 'The ACP agent returned a malformed initialize response'
  if (!reason) {
    const version = init.protocolVersion
    if (Number.isSafeInteger(version) && version >= 0 && version <= 65535) peer.protocol_version = version
    const caps = isRecord(init.agentCapabilities) ? init.agentCapabilities : {}
    const prompt = isRecord(caps.promptCapabilities) ? caps.promptCapabilities : {}
    const session = isRecord(caps.sessionCapabilities) ? caps.sessionCapabilities : {}
    const mcp = isRecord(caps.mcpCapabilities) ? caps.mcpCapabilities : {}
    const declared = [
      ['load_session', flag(caps.loadSession)],
      ['resume_session', present(session.resume)],
      ['close_session', present(session.close)],
      ['list_sessions', present(session.list)],
      ['prompt_image', flag(prompt.image)],
      ['prompt_audio', flag(prompt.audio)],
      ['prompt_embedded_context', flag(prompt.embeddedContext)],
      ['mcp_http', flag(mcp.http)],
      ['mcp_sse', flag(mcp.sse)],
    ]
    features = new Set(declared.filter(([, on]) => on).map(([feature]) => feature))
    const info = isRecord(init.agentInfo) ? init.agentInfo : {}
    peer = {
      protocol: 'acp',
      ...(peer.protocol_version === undefined ? {} : { protocol_version: peer.protocol_version }),
      ...(printable(info.name, 128) ? { name: info.name } : {}),
      ...(printable(info.version, 64) ? { version: info.version } : {}),
      features: [...features],
      auth_methods: (Array.isArray(init.authMethods) ? init.authMethods : [])
        .map((method) => (isRecord(method) ? printable(method.id, 128) : null))
        .filter(Boolean)
        .slice(0, 16),
    }
    if (version !== ACP_VERSION)
      reason = `The ACP agent speaks protocol version ${String(version)}; ADE's ACP client speaks version ${ACP_VERSION} only`
  }
  const ok = !reason
  const capability = (capabilityName, supported, why) => ({
    name: capabilityName,
    support: supported ? 'supported' : 'unsupported',
    available: ok && supported,
    reason: supported ? (ok ? '' : reason) : why,
  })
  const resumable = features.has('load_session') || features.has('resume_session')
  const capabilities = [
    capability('streaming', true),
    capability('cancel', true),
    capability('tool_approval', true),
    capability('images', features.has('prompt_image'), 'The agent did not declare image prompts'),
    capability(
      'text_attachments',
      features.has('prompt_embedded_context'),
      'The agent did not declare embedded context in prompts',
    ),
    capability('resume', resumable, 'The agent declared neither session/load nor session/resume'),
    capability('steering', false, UNSUPPORTED.steer),
    capability('questions', false, 'ADE offers ACP agents no elicitation service'),
    capability('child_transcript', false, 'ACP v1 has no child session transcripts'),
  ]
  const operations = OPERATIONS.map(([method, tier]) => {
    if (UNSUPPORTED[method]) return { method, tier, availability: 'unsupported', reason: UNSUPPORTED[method] }
    if (!ok && method !== 'initialize') return { method, tier, availability: 'unavailable', reason }
    return { method, tier, availability: 'available', reason: '' }
  })
  return {
    descriptor: {
      compatible_protocol_versions: [2],
      name,
      capabilities,
      permission_modes: ['default'],
      operations,
      limits: { ...DEFAULT_LIMITS, max_output_frame_bytes: MAX_OUTPUT_FRAME_BYTES },
      requirements: SDK_REQUIREMENTS,
      native_peer: peer,
    },
    features,
    problem: reason,
  }
}

/** The `initialize` request. ADE offers the agent no file system, terminal or elicitation service. */
export const initializeRequest = (version) => ({
  protocolVersion: ACP_VERSION,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: 'ade', title: 'ADE', version },
})

/** `session/prompt` content blocks; an attachment kind the agent did not declare is refused, never degraded. */
export function promptBlocks(text, attachments, features) {
  const blocks = [{ type: 'text', text }]
  for (const content of attachments ?? []) {
    const media = content.attachment?.media_type ?? ''
    if (media.startsWith('image/')) {
      if (!features.has('prompt_image'))
        throw failure('unsupported', 'This ACP agent did not declare image prompts. Nothing was sent.')
      blocks.push({ type: 'image', mimeType: media, data: content.data })
    } else {
      if (!features.has('prompt_embedded_context'))
        throw failure('unsupported', 'This ACP agent did not declare embedded file context. Nothing was sent.')
      let decoded
      try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(content.data, 'base64'))
      } catch {
        throw failure('invalid_request', `Attachment ${content.attachment?.name ?? ''} is not UTF-8 text`)
      }
      blocks.push({
        type: 'resource',
        resource: { uri: `attachment:${content.attachment?.name ?? 'file'}`, mimeType: media || null, text: decoded },
      })
    }
  }
  return blocks
}

/** How a `session/prompt` reply ends a turn. An unrecognised reason stays unknown, not completed. */
export function stopStatus(result) {
  const reason = isRecord(result) ? result.stopReason : undefined
  switch (reason) {
    case 'end_turn':
      return { status: 'completed', error: null }
    case 'cancelled':
      return { status: 'interrupted', error: null }
    case 'max_tokens':
      return { status: 'failed', error: 'The agent stopped at its token limit' }
    case 'max_turn_requests':
      return { status: 'failed', error: 'The agent stopped at its limit of model requests for one turn' }
    case 'refusal':
      return { status: 'failed', error: 'The agent refused to continue this turn' }
    default:
      return { status: 'unknown', error: 'The agent ended the turn without a recognised stop reason' }
  }
}

/**
 * Native JSON carried inside an ADE event must fit the worker's output frame policy: at most 32
 * entries per array or object, bounded depth and nodes. Anything larger is kept as readable,
 * truncated JSON text rather than failing the worker or being dropped silently.
 */
export function fit(value, { entries = 32, nodes = 1024, depth = 16, text = 64 * 1024 } = {}) {
  let count = 0
  const fits = (node, level) => {
    if (++count > nodes || level > depth) return false
    if (Array.isArray(node)) return node.length <= entries && node.every((child) => fits(child, level + 1))
    if (isRecord(node)) {
      const keys = Object.keys(node)
      return keys.length <= entries && keys.every((key) => fits(node[key], level + 1))
    }
    return typeof node !== 'string' || node.length <= TEXT_LIMIT
  }
  if (value === undefined) return null
  if (fits(value, 0)) return value
  const json = JSON.stringify(value) ?? 'null'
  return json.length > text ? `${json.slice(0, text)}… [truncated by ADE]` : json
}

function toolOutput(content) {
  if (!Array.isArray(content)) return null
  let output = ''
  for (const block of content) {
    if (block?.type === 'content' && block.content?.type === 'text' && typeof block.content.text === 'string')
      output += block.content.text
    else if (block?.type === 'diff' && typeof block.path === 'string') output += `Diff: ${block.path}\n`
    else if (block?.type === 'terminal' && typeof block.terminalId === 'string')
      output += `Terminal: ${block.terminalId}\n`
  }
  return output
}

/** Tool state by native `toolCallId`, shared by live turns and replay, bounded in entries. */
export class Tools {
  #tools = new Map()
  update(update, create) {
    const id = bounded(update.toolCallId, ID_LIMIT)
    if (!id) throw failure('invalid_request', 'ACP tool call has no ID')
    let tool = this.#tools.get(id)
    if (!tool) {
      if (this.#tools.size >= TOOL_LIMIT) {
        const settled = [...this.#tools].find(([, entry]) => entry.status === 'completed' || entry.status === 'failed')
        if (!settled) throw failure('resource_limit', 'The ACP agent reported more than 1024 open tool calls')
        this.#tools.delete(settled[0])
      }
      tool = { title: 'tool', kind: 'other', status: 'pending', input: null, output: null }
      this.#tools.set(id, tool)
    }
    const title = printable(update.title, 256)
    if (title) tool.title = title
    const kind = typeof update.kind === 'string' && /^[a-z_]{1,32}$/.test(update.kind) ? update.kind : null
    if (kind) tool.kind = kind
    if (['pending', 'in_progress', 'completed', 'failed'].includes(update.status)) tool.status = update.status
    if (update.rawInput !== undefined && update.rawInput !== null) tool.input = fit(update.rawInput)
    const output = toolOutput(update.content)
    if (create || output !== null) tool.output = output && output.length > 0 ? output.slice(0, TEXT_LIMIT) : null
    if (update.rawOutput !== undefined && update.rawOutput !== null && !tool.output) {
      const raw = typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput)
      tool.output = raw.slice(0, TEXT_LIMIT)
    }
    return toolItem(id, tool)
  }
}

function toolItem(id, tool) {
  const status = tool.status === 'completed' ? 'completed' : tool.status === 'failed' ? 'failed' : 'streaming'
  return {
    id: `tool:${id}`,
    client_id: null,
    turn: null,
    role: 'tool',
    kind: 'tool',
    text: tool.title,
    status,
    content: {
      type: 'tool',
      call_id: id,
      name: tool.title,
      input: tool.input,
      output: tool.output,
      is_error: tool.status === 'failed',
    },
  }
}

/** A usage report as an object within the output frame policy. */
function usageReport(report) {
  const fitted = fit(report)
  return isRecord(fitted) ? fitted : { truncated: fitted }
}

function planItem(id, update) {
  if (!Array.isArray(update.entries)) throw failure('invalid_request', 'ACP plan has no entries')
  const steps = update.entries
    .slice(0, 32)
    .map((entry) => ({
      step: typeof entry?.content === 'string' ? entry.content.slice(0, 4096) : '',
      status: entry?.status === 'completed' ? 'completed' : entry?.status === 'in_progress' ? 'inProgress' : 'pending',
    }))
    .filter((step) => step.step.trim().length > 0)
  return {
    id,
    client_id: null,
    turn: null,
    role: 'assistant',
    kind: 'plan',
    text: steps.map((step) => `- ${step.step}`).join('\n'),
    status: 'streaming',
    content: { type: 'plan', explanation: null, steps },
  }
}

/** The ADE item ID for a native message, or null when the agent gave the chunk no message ID. */
const messageItemId = (prefix, messageId) => {
  const id = bounded(messageId, ID_LIMIT - 16)
  return id ? `${prefix}:${id}` : null
}

/**
 * One live prompt turn. Every update the worker attributes to this turn arrived on the wire
 * after its `session/prompt` request was written and before that request's reply.
 */
export class TurnMapper {
  constructor({ session, submission, tools }) {
    this.session = session
    this.submission = submission
    this.tools = tools
    this.segments = []
    this.current = null
    this.counter = 0
    this.bytes = 0
  }

  #charge(bytes) {
    this.bytes += bytes
    if (this.bytes > TURN_BYTES)
      throw failure('resource_limit', 'The ACP agent sent more than 4 MiB of text in one turn')
  }

  #chunk(role, kind, update) {
    const content = update.content
    if (content?.type !== 'text' || typeof content.text !== 'string') return []
    this.#charge(Buffer.byteLength(content.text))
    const prefix = kind === 'reasoning' ? 'thought' : 'msg'
    const native = messageItemId(prefix, update.messageId)
    let segment =
      this.current && this.current.kind === kind && (native === null || this.current.id === native)
        ? this.current
        : null
    if (!segment && native) segment = this.segments.find((entry) => entry.id === native) ?? null
    if (!segment) {
      segment = {
        id: native ?? `${prefix}:${this.submission}:${++this.counter}`,
        role,
        kind,
        text: '',
      }
      this.segments.push(segment)
    }
    this.current = segment
    if (segment.text.length + content.text.length > TEXT_LIMIT) return []
    segment.text += content.text
    return [
      {
        type: 'delta',
        session: this.session,
        submission: this.submission,
        turn: null,
        id: segment.id,
        role,
        kind,
        text: content.text,
      },
    ]
  }

  /** Events for one update; `null` for an update this turn does not render. */
  update(update) {
    switch (update?.sessionUpdate) {
      case 'agent_message_chunk':
        return this.#chunk('assistant', 'text', update)
      case 'agent_thought_chunk':
        return this.#chunk('assistant', 'reasoning', update)
      case 'tool_call':
      case 'tool_call_update': {
        this.current = null
        const item = this.tools.update(update, update.sessionUpdate === 'tool_call')
        return [{ type: 'item', session: this.session, submission: this.submission, item }]
      }
      case 'plan':
        return [
          {
            type: 'item',
            session: this.session,
            submission: this.submission,
            item: planItem(`plan:${this.submission}`, update),
          },
        ]
      case 'usage_update':
        return [
          {
            type: 'usage',
            session: this.session,
            submission: this.submission,
            turn: null,
            source: 'acp/usage_update',
            report: usageReport(update),
          },
        ]
      // A user chunk echoes the prompt ADE already recorded; mode, command, configuration and
      // session information updates have no ADE surface yet.
      default:
        return []
    }
  }

  /** Completes the streamed messages, then ends the turn with its native stop evidence. */
  finish({ result, error, interruptRequested }) {
    const outcome = error ? { status: 'failed', error } : stopStatus(result)
    const itemStatus =
      outcome.status === 'completed' ? 'completed' : outcome.status === 'interrupted' ? 'interrupted' : 'failed'
    const events = this.segments
      .filter((segment) => segment.text.length > 0)
      .map((segment) => ({
        type: 'item',
        session: this.session,
        submission: this.submission,
        item: {
          id: segment.id,
          client_id: null,
          turn: null,
          role: segment.role,
          kind: segment.kind,
          text: segment.text,
          status: itemStatus,
        },
      }))
    if (isRecord(result?.usage))
      events.push({
        type: 'usage',
        session: this.session,
        submission: this.submission,
        turn: null,
        source: 'acp/prompt_response',
        report: usageReport(result.usage),
      })
    events.push({
      type: 'finished',
      session: this.session,
      submission: this.submission,
      turn: null,
      status: outcome.status,
      error: outcome.error,
      native_terminal: {
        stop_reason: isRecord(result) && typeof result.stopReason === 'string' ? result.stopReason : null,
        is_error: Boolean(error),
      },
      interrupt_requested: interruptRequested,
    })
    return events
  }
}

/**
 * Captures one `session/load` replay. Capture is cheap and bounded; entries past the bound are
 * counted, not kept. Only entries with native identity become history: a message with a native
 * message ID and a tool call by its ID merge with what ADE recorded live. User messages are never
 * imported, because ACP does not correlate a replayed user message with the prompt ADE admitted.
 */
export class ReplayCapture {
  constructor(session) {
    this.session = session
    this.entries = []
    this.bytes = 0
    this.overflow = 0
    this.unidentified = 0
    this.messages = new Map()
    this.tools = new Tools()
  }

  capture(update) {
    const size = Buffer.byteLength(JSON.stringify(update ?? null))
    if (this.entries.length >= REPLAY_ENTRIES || this.bytes + size > REPLAY_BYTES) {
      this.overflow++
      return
    }
    this.bytes += size
    this.entries.push(update)
  }

  /** History for `open`, at most `maxItems` and `maxBytes`, oldest first, with any gap declared. */
  history({ maxItems, maxBytes }) {
    const items = new Map()
    for (const update of this.entries) {
      const kind = update?.sessionUpdate
      if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
        if (update.content?.type !== 'text' || typeof update.content.text !== 'string') continue
        const id = messageItemId(kind === 'agent_thought_chunk' ? 'thought' : 'msg', update.messageId)
        if (!id) {
          this.unidentified++
          continue
        }
        const existing = items.get(id)
        const text = (existing?.text ?? '') + update.content.text
        items.delete(id)
        items.set(id, {
          id,
          client_id: null,
          turn: null,
          role: 'assistant',
          kind: kind === 'agent_thought_chunk' ? 'reasoning' : 'text',
          text: text.slice(0, TEXT_LIMIT),
          status: 'completed',
        })
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        try {
          const item = this.tools.update(update, kind === 'tool_call')
          items.set(item.id, item)
        } catch {
          this.unidentified++
        }
      }
    }
    const all = [...items.values()]
    const omittedReasons = []
    let kept = []
    let bytes = 0
    // One entry and 1 KiB stay reserved for the gap notice.
    for (const item of all.reverse()) {
      const size = Buffer.byteLength(JSON.stringify(item))
      if (kept.length + 1 >= maxItems || bytes + size > maxBytes - 1024) break
      kept.push(item)
      bytes += size
    }
    kept = kept.reverse()
    const omitted = all.length - kept.length
    if (omitted) omittedReasons.push(`${omitted} older replayed items exceed the history page`)
    if (this.overflow) omittedReasons.push(`${this.overflow} replayed updates exceeded the replay capture bound`)
    if (this.unidentified)
      omittedReasons.push(`${this.unidentified} replayed updates had no native message ID and were not merged`)
    if (omittedReasons.length)
      kept.unshift({
        id: `notice:replay:${this.session}`.slice(0, ID_LIMIT),
        client_id: null,
        turn: null,
        role: 'system',
        kind: 'notice',
        text: `ACP session/load replay is incomplete in ADE: ${omittedReasons.join('; ')}. ADE's recorded transcript is kept.`,
        status: 'completed',
      })
    return kept
  }
}

/** Validates a permission request's options; null when they are malformed. */
export function permissionOptions(options) {
  if (!Array.isArray(options) || options.length === 0 || options.length > OPTION_LIMIT) return null
  const ids = new Set()
  for (const option of options) {
    const id = bounded(option?.optionId, ID_LIMIT)
    if (!id || ids.has(id) || !OPTION_KINDS.has(option.kind)) return null
    ids.add(id)
  }
  return options
}

/** The ADE request for one native permission request; each choice value is the agent's option ID. */
export function permissionRequest({ id, session, submission, params }) {
  const options = permissionOptions(params.options)
  const toolCall = isRecord(params.toolCall) ? params.toolCall : {}
  return {
    type: 'request',
    session,
    submission,
    turn: null,
    id,
    method: PERMISSION_METHOD,
    params: { toolCall: fit(toolCall), options },
    supported: true,
    metadata: {
      schema_version: 1,
      summary: printable(toolCall.title, 512) ?? 'Permission request',
      schema: {
        kind: 'choices',
        choices: options.map((option) => ({
          value: option.optionId,
          label: printable(option.name, 256) ?? option.optionId,
          scope: option.kind.endsWith('_always') ? 'persistent' : 'once',
        })),
      },
      blocking: true,
      native_request_id: id,
      native_session_id: session,
      native_turn_id: null,
      native_item_id: bounded(toolCall.toolCallId, ID_LIMIT),
    },
  }
}

/** The ACP reply to an ADE answer: the selected native option, unchanged. */
export function permissionOutcome(options, answer) {
  if (answer?.kind !== 'choice' || typeof answer.value !== 'string')
    throw failure('invalid_request', 'An ACP permission is answered by choosing one of the agent options')
  if (!options.some((option) => option.optionId === answer.value))
    throw failure('invalid_request', 'The ACP agent did not offer that option')
  return { outcome: { outcome: 'selected', optionId: answer.value } }
}

export const cancelledOutcome = () => ({ outcome: { outcome: 'cancelled' } })
