import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { Cause, Effect, Layer, Queue, Stream } from 'effect'
import { runProviderWorker } from '@ade/provider-sdk/node'
import { EntryHistory, projectHistory } from './history.mjs'
import { OmpTransport } from './transport.mjs'
import { sessionIdentity, verifySession } from './session.mjs'
import { promptPayload } from './admission.mjs'
import { TextStream } from './stream.mjs'
import { Subagents } from './subagents.mjs'
import { readChildTranscript } from './child-transcripts.mjs'
const descriptor = JSON.parse(process.env.ADE_OMP_WORKER_DESCRIPTOR ?? 'null')
if (!descriptor) throw new Error('The owning ADE runtime must provide OMP worker metadata')
const failure = (code, message) => ({ code, message })
const nativeStateIsIdle = (state) =>
  state &&
  typeof state.isStreaming === 'boolean' &&
  typeof state.isCompacting === 'boolean' &&
  Number.isSafeInteger(state.queuedMessageCount) &&
  !state.isStreaming &&
  !state.isCompacting &&
  state.queuedMessageCount === 0
runProviderWorker({
  descriptor,
  dependencies: Layer.empty,
  acquire: Effect.gen(function* () {
    const capacity = Math.min(32, descriptor.limits.max_output_entries)
    const events = yield* Queue.dropping(capacity)
    const frameLimit = descriptor.limits.max_output_frame_bytes
    const queueLimit = frameLimit * capacity
    let queuedBytes = 0
    let active = true
    let opened = false
    let transport
    let history
    let identity
    let session
    let nativeState
    let mcpServers = null
    let currentAttempt = null
    const promptAttempts = new Map()
    let lastAssistant = null
    let stream = new TextStream()
    const subagents = new Subagents()
    const requests = new Map()
    const childTranscripts = new Map()
    let reconciledItems = new Map()
    const emit = (event) => {
      if (!active) return
      const bytes = Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: event })) + 1
      if (bytes > frameLimit || queuedBytes + bytes > queueLimit || !Queue.offerUnsafe(events, { event, bytes })) {
        active = false
        Queue.failCauseUnsafe(
          events,
          Cause.fail(failure('resource_limit', 'OMP worker event exceeds its declared output byte or entry budget')),
        )
        void transport?.stop()
        return
      }
      queuedBytes += bytes
    }
    const pump = async (frame) => {
      if (!active || !opened) return
      if (frame.type === 'process_exit') throw new Error(frame.error)
      if (frame.type === 'extension_ui_request') return onNativeRequest(frame)
      const child = subagents.consume(frame, null)
      if (child) {
        if (frame.type === 'subagent_lifecycle' && frame.payload?.sessionFile !== undefined) {
          const { id, sessionFile } = frame.payload
          if (
            typeof id !== 'string' ||
            !id ||
            Buffer.byteLength(id) > 4096 ||
            typeof sessionFile !== 'string' ||
            !isAbsolute(sessionFile) ||
            Buffer.byteLength(sessionFile) > 4096
          )
            throw new Error('Invalid Oh My Pi child transcript identity')
          const existing = childTranscripts.get(id)
          if (existing && existing.file !== sessionFile) throw new Error('Oh My Pi child transcript path changed')
          if (!existing && childTranscripts.size >= 256) {
            const retired = [...childTranscripts].find(([, record]) => record.terminal)
            if (!retired) throw new Error('Oh My Pi exceeds 256 active child transcripts')
            childTranscripts.delete(retired[0])
          }
          if (existing) existing.terminal = frame.payload.status !== 'started'
          else
            childTranscripts.set(id, {
              file: sessionFile,
              headerId: null,
              terminal: frame.payload.status !== 'started',
            })
        }
        emit({ type: 'item', session, submission: null, item: { ...child, turn: null } })
      }
      if (frame.type === 'message_start' || frame.type === 'message_update' || frame.type === 'message_end') {
        if (frame.message?.role === 'assistant' && frame.type === 'message_end') {
          lastAssistant = frame.message
          if (frame.message.usage || frame.message.model)
            emit({
              type: 'usage',
              session,
              turn: null,
              source: 'message_end',
              report: { usage: frame.message.usage ?? null, model: frame.message.model ?? null },
            })
        }
        for (const event of stream.consume(frame, null))
          emit({
            ...event,
            ...(event.type === 'item' ? { item: { ...event.item, turn: null } } : {}),
            session,
            submission: null,
          })
        if (frame.type === 'message_end') await reconcile()
      } else if (frame.type === 'agent_end') {
        // agent_end has no native RPC correlation; it must not clear a newer attempt.
        const last =
          [...(frame.messages ?? [])].reverse().find((message) => message.role === 'assistant') ?? lastAssistant
        emit({
          type: 'finished',
          session,
          submission: null,
          turn: null,
          interrupt_requested: false,
          status:
            last?.stopReason === 'error'
              ? 'failed'
              : last?.stopReason === 'aborted'
                ? 'interrupted'
                : last?.stopReason === 'stop'
                  ? 'completed'
                  : 'unknown',
          error: last?.errorMessage ?? null,
          native_terminal: { stop_reason: last?.stopReason ?? null, is_error: last?.stopReason === 'error' },
        })
        lastAssistant = null
        stream = new TextStream()
      } else if (frame.type === 'prompt_result') {
        const submitted = promptAttempts.get(frame.id)
        if (submitted && frame.agentInvoked === false) {
          promptAttempts.delete(frame.id)
          emit({
            type: 'finished',
            session,
            submission: submitted.submission,
            turn: null,
            interrupt_requested: false,
            status: 'completed',
            error: null,
            native_terminal: { terminal_reason: 'local_prompt_complete', is_error: false },
          })
          submitted.localComplete = true
          if (submitted.acknowledged && currentAttempt === submitted) currentAttempt = null
        }
      } else if (frame.type === 'response' && frame.command === 'prompt' && !frame.success) {
        const submitted = promptAttempts.get(frame.id)
        promptAttempts.delete(frame.id)
        emit({
          type: 'operation_failed',
          submission: submitted?.submission ?? null,
          error: String(frame.error ?? 'OMP prompt failed'),
        })
        if (submitted && currentAttempt === submitted) currentAttempt = null
      }
    }
    const reconcile = async () => {
      const snapshot = await history.refresh()
      const next = new Map()
      for (const item of projectHistory(snapshot).items) {
        const projected = { ...item, turn: null, client_id: null }
        const encoded = JSON.stringify(projected)
        next.set(projected.id, encoded)
        if (reconciledItems.get(projected.id) !== encoded)
          emit({ type: 'item', session, submission: null, item: projected })
      }
      reconciledItems = next
    }
    const onNativeRequest = (frame) => {
      if (frame.method === 'cancel') {
        const target = requests.get(frame.targetId)
        if (target) {
          requests.delete(frame.targetId)
          emit({ type: 'resolved', id: frame.targetId, session, submission: null, resolution: 'withdrawn' })
        }
        return
      }
      if (['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text'].includes(frame.method)) return
      if (frame.method === 'confirm') {
        requests.set(frame.id, { kind: 'confirm', session })
        emit({
          type: 'request',
          session,
          turn: null,
          submission: null,
          id: frame.id,
          method: 'omp/toolApproval',
          params: { reason: frame.message ?? '', tool: frame.title ?? '' },
          supported: true,
          metadata: {
            blocking: true,
            native_request_id: frame.id,
            schema_version: 1,
            schema: {
              kind: 'choices',
              choices: [
                { value: true, label: 'Allow' },
                { value: false, label: 'Deny' },
              ],
            },
            summary: 'Oh My Pi requests confirmation',
          },
        })
      } else if (['select', 'input', 'editor'].includes(frame.method)) {
        requests.set(frame.id, { kind: frame.method, session, options: frame.options ?? [] })
        emit({
          type: 'request',
          session,
          turn: null,
          submission: null,
          id: frame.id,
          method: 'omp/questions',
          params: { title: frame.title ?? '', options: frame.options ?? [] },
          supported: true,
          metadata: {
            blocking: true,
            native_request_id: frame.id,
            schema_version: 1,
            schema: {
              kind: 'questions',
              questions: [
                {
                  id: 'input',
                  header: frame.title ?? null,
                  prompt: frame.message ?? '',
                  multiple: false,
                  allow_other: true,
                  secret: false,
                },
              ],
            },
            summary: 'Oh My Pi requests input',
          },
        })
      } else transport.write({ type: 'extension_ui_response', id: frame.id, cancelled: true })
    }

    return {
      open: (params) =>
        Effect.tryPromise({
          try: async () => {
            if (opened) throw failure('invalid_request', 'OMP session is already open')
            if ((params.config.permission_mode ?? 'default') !== 'default')
              throw failure('unsupported', 'OMP supports only its native default permission mode')
            const directory = process.env.ADE_DATA_DIR && join(process.env.ADE_DATA_DIR, 'omp')
            if (!directory) throw failure('invalid_request', 'The OMP worker requires ADE_DATA_DIR')
            identity = await sessionIdentity({
              resume: params.resume,
              cwd: process.cwd(),
              directory: join(directory, 'sessions'),
            })
            session = params.resume ?? JSON.stringify(identity)
            const extension = await writeMcpExtension(directory, identity.id, params.mcp_servers ?? mcpServers)
            const command = process.env.ADE_OMP_BIN
              ? [process.env.ADE_OMP_BIN]
              : [
                  process.execPath,
                  ...(process.env.ADE_OMP_ACCOUNT_HOME ? ['--no-env-file'] : []),
                  new URL('./node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js', import.meta.url).pathname,
                ]
            transport = await OmpTransport.start({
              command,
              cwd: process.cwd(),
              env: process.env.ADE_OMP_ACCOUNT_HOME
                ? {
                    ...process.env,
                    HOME: process.env.ADE_OMP_ACCOUNT_HOME,
                    PI_CODING_AGENT_DIR: process.env.ADE_OMP_ACCOUNT_HOME,
                  }
                : process.env,
              args: [
                '--session',
                identity.file,
                ...(params.config.model ? ['--model', params.config.model] : []),
                ...(extension ? ['--extension', extension] : []),
              ],
              onFrame: (frame) => {
                void pump(frame).catch((error) => {
                  emit({ type: 'error', error: error.message })
                  void transport?.stop()
                })
              },
            })
            nativeState = await transport.request('get_state')
            await verifySession(identity, nativeState)
            if (!nativeStateIsIdle(nativeState))
              throw failure(
                'provider_failure',
                'Oh My Pi has active, queued, or unreported work; reconnect with explicit ownership transfer',
              )
            await transport.request('set_subagent_subscription', { level: 'progress' })
            history = new EntryHistory(transport)
            const snapshot = await history.refresh()
            opened = true
            const initial = projectHistory(snapshot)
              .items.slice(-descriptor.limits.max_history_page_items)
              .map((item) => ({ ...item, turn: null, client_id: null }))
            return { session, history: initial }
          },
          catch: (error) =>
            error?.code ? error : failure('provider_failure', error.message ?? 'Could not open Oh My Pi'),
        }),
      send: (params) =>
        Effect.tryPromise({
          try: async () => {
            if (!opened || !active || params.session !== session)
              throw failure('invalid_request', 'OMP session is not open')
            const state = await transport.request('get_state')
            await verifySession(identity, state)
            if (!nativeStateIsIdle(state))
              throw failure('invalid_request', 'OMP has active, queued, or unreported work')
            currentAttempt = null
            const payload = promptPayload({
              text: params.text,
              attachments: params.attachments.map((content) => ({
                attachment: content.attachment,
                data: content.data,
              })),
            })
            const rpcId = randomUUID()
            const record = {
              sourceAttemptId: params.source_attempt_id,
              submission: params.submission,
              rpcId,
              acknowledged: false,
              localComplete: false,
            }
            promptAttempts.set(rpcId, record)
            while (promptAttempts.size > 32) promptAttempts.delete(promptAttempts.keys().next().value)
            currentAttempt = record
            emit({ type: 'started', session, submission: params.submission, turn: null })
            try {
              await transport.request('prompt', payload, { id: rpcId })
            } catch (error) {
              promptAttempts.delete(rpcId)
              if (currentAttempt === record) currentAttempt = null
              throw failure('provider_failure', error.message ?? 'Oh My Pi did not accept the prompt')
            }
            record.acknowledged = true
            if (record.localComplete && currentAttempt === record) currentAttempt = null
            emit({
              type: 'submitted',
              submission: params.submission,
              turn: null,
              admitted: true,
              dispatch: 'dispatched',
              native_outcome: 'accepted',
            })
            return { admitted: true, dispatch: 'dispatched', native_outcome: 'accepted', turn: null }
          },
          catch: (error) =>
            error?.code ? error : failure('provider_failure', error.message ?? 'Oh My Pi input failed'),
        }),
      steer: () =>
        Effect.fail(failure('unsupported', 'Oh My Pi RPC does not expose native steering for an identified turn')),
      cancel: (params) =>
        Effect.tryPromise({
          try: async () => {
            if (!opened || params.session !== session || params.turn != null)
              throw failure(
                'invalid_request',
                'OMP cancellation must target its open native session with no fabricated native turn',
              )
            const attempt = currentAttempt
            if (
              !attempt ||
              attempt.sourceAttemptId !== params.source_attempt_id ||
              attempt.submission !== params.submission_id
            )
              throw failure(
                'invalid_request',
                'OMP cancellation does not match the currently admitted ADE attempt and submission',
              )
            await transport.request('abort')
            let sample = null
            let observedAt = null
            try {
              const state = await transport.request('get_state')
              const sampledAt = Date.now()
              try {
                await verifySession(identity, state)
                sample = state
                observedAt = sampledAt
              } catch {}
            } catch {}
            const active =
              typeof sample?.isStreaming === 'boolean' && typeof sample.isCompacting === 'boolean'
                ? sample.isStreaming || sample.isCompacting
                : null
            const queued = Number.isSafeInteger(sample?.queuedMessageCount) ? sample.queuedMessageCount : null
            if (active === false && queued === 0) currentAttempt = null
            return {
              type: 'cancel_result',
              evidence: {
                scope: 'session',
                interruption_requested: true,
                termination: 'unknown',
                active_work_remaining: active,
                queued_work_count: queued,
                background_work_remaining: null,
                observed_at_ms: observedAt,
              },
            }
          },
          catch: (error) =>
            error?.code ? error : failure('provider_failure', error.message ?? 'Oh My Pi cancellation failed'),
        }),
      answer: (params) =>
        Effect.try({
          try: () => {
            const request = requests.get(params.id)
            if (!request || request.session !== session)
              throw failure('invalid_request', 'Oh My Pi request is no longer pending')
            const response = { type: 'extension_ui_response', id: params.id }
            if (params.answer.kind === 'choice' && request.kind === 'confirm') {
              if (params.answer.value === false || params.answer.value === 'deny') response.confirmed = false
              else if (params.answer.value === true || params.answer.value === 'accept') response.confirmed = true
              else throw failure('invalid_request', 'Confirmation answer is not a native Oh My Pi choice')
            } else if (params.answer.kind === 'questions' && request.kind !== 'confirm') {
              const values = params.answer.answers.input
              if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== 'string')
                throw failure('invalid_request', 'Oh My Pi native prompt accepts one text value')
              response.value = values[0]
            } else throw failure('unsupported', 'This Oh My Pi request does not support that typed answer')
            transport.write(response)
            requests.delete(params.id)
            emit({ type: 'resolved', id: params.id, session, submission: null, resolution: 'resolved' })
            return {}
          },
          catch: (error) =>
            error?.code ? error : failure('invalid_request', error.message ?? 'Oh My Pi answer was invalid'),
        }),
      configure_mcp: (params) =>
        Effect.tryPromise({
          try: async () => {
            if (opened) throw failure('unsupported', 'Configure Oh My Pi MCP servers before opening its native session')
            mcpServers = params.servers
            return {}
          },
          catch: (error) =>
            error?.code ? error : failure('invalid_request', error.message ?? 'OMP MCP configuration failed'),
        }),
      history: (params) =>
        Effect.tryPromise({
          try: async () => historyPage(params, descriptor, history, session),
          catch: (error) =>
            error?.code ? error : failure('provider_failure', error.message ?? 'OMP history read failed'),
        }),
      child_transcript: (params) =>
        Effect.tryPromise({
          try: async () => {
            if (!opened || params.session !== session)
              throw failure('invalid_request', 'OMP child transcript belongs to a different native session')
            if (params.cursor !== null)
              throw failure('invalid_request', 'OMP child transcripts use native offset paging')
            const record = childTranscripts.get(params.child)
            if (!record) throw failure('invalid_request', 'Child transcript was not announced by this OMP session')
            const result = await readChildTranscript(record.file, params.child, params.offset, record.headerId)
            record.headerId = result.header_id
            return result.page
          },
          catch: (error) =>
            error?.code ? error : failure('provider_failure', error.message ?? 'OMP child transcript read failed'),
        }),
      compact: () =>
        Effect.tryPromise({
          try: async () => {
            await transport.request('compact')
            return {}
          },
          catch: (error) => failure('provider_failure', error.message),
        }),
      rewind: () => Effect.fail(failure('unsupported', 'OMP branch rewinds are not file rewinds')),
      events: Stream.map(Stream.fromQueue(events), (entry) => {
        queuedBytes -= entry.bytes
        return entry.event
      }),
      close: Effect.tryPromise({
        try: async () => {
          active = false
          await transport?.stop()
        },
        catch: (error) => failure('provider_failure', error.message ?? 'OMP did not stop'),
      }),
    }
  }),
})

async function historyPage(params, descriptor, history, session) {
  if (params.session !== session) throw failure('invalid_request', 'OMP history request is for another session')
  const snapshot = await history.refresh()
  const projected = projectHistory(snapshot).items.map((item) => ({ ...item, turn: null, client_id: null }))
  const generation = JSON.stringify([snapshot.leafId, snapshot.entries.at(-1)?.id ?? null])
  const identity = {
    ...params.context,
    provider: descriptor.name,
    session,
    consistency: 'best_effort',
    source: `omp:${session}`,
    generation,
  }
  if (params.snapshot && JSON.stringify(params.snapshot) !== JSON.stringify(identity))
    throw failure('invalid_request', 'OMP history snapshot changed')
  let offset = 0
  if (params.cursor) {
    let cursor
    try {
      cursor = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8'))
    } catch {
      throw failure('invalid_request', 'OMP history cursor is invalid')
    }
    if (
      cursor.generation !== generation ||
      cursor.epoch !== params.context.invalidation_epoch ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0 ||
      cursor.offset > projected.length
    )
      throw failure('invalid_request', 'OMP history cursor is stale')
    offset = cursor.offset
  }
  const maxItems = Math.min(32, descriptor.limits.max_history_page_items, params.max_items)
  const maxBytes = Math.min(512 * 1024, params.max_bytes)
  const items = []
  let retained = 0
  for (const item of projected.slice(offset)) {
    const bytes = Buffer.byteLength(JSON.stringify(item))
    if (items.length >= maxItems || retained + bytes > maxBytes) {
      if (items.length === 0 && bytes > maxBytes)
        return {
          snapshot: identity,
          items,
          next_cursor: null,
          retained_bytes: 0,
          complete: false,
          error: failure('resource_limit', 'OMP history item exceeds the requested page byte limit'),
        }
      break
    }
    items.push(item)
    retained += bytes
  }
  const next = offset + items.length
  const next_cursor =
    next < projected.length
      ? Buffer.from(JSON.stringify({ generation, epoch: params.context.invalidation_epoch, offset: next })).toString(
          'base64url',
        )
      : null
  return {
    snapshot: identity,
    items,
    next_cursor,
    retained_bytes: retained,
    complete: next_cursor === null,
    error: null,
  }
}

async function writeMcpExtension(root, sessionId, servers) {
  if (!servers || !Object.keys(servers).length) return null
  const { createHash } = await import('node:crypto')
  const { mkdir, rename, writeFile } = await import('node:fs/promises')
  const paths = await import('node:path')
  const directory = join(root, 'mcp', createHash('sha256').update(sessionId).digest('hex').slice(0, 32))
  const mcpServers = Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      typeof server.command === 'string' && /^\.\.?[/\\]/.test(server.command)
        ? { ...server, command: paths.resolve(process.cwd(), server.command) }
        : server,
    ]),
  )
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, '.mcp.json'),
    partial = `${file}.${process.pid}.tmp`
  await writeFile(partial, JSON.stringify({ mcpServers }, null, 2) + '\n', { mode: 0o600 })
  await rename(partial, file)
  return directory
}
