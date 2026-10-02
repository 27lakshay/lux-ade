import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Cause, Effect, Layer, Queue, Stream } from 'effect'
import { runProviderWorker } from '@ade/provider-sdk/node'
import { Transcript } from './transcript.mjs'
import { loadAliases, saveAliases } from './identity.mjs'
import { historyPage, childTranscript, hydrateTranscript } from './history.mjs'
import { forkBefore } from './rewind.mjs'
import { Subagents } from './subagents.mjs'

const descriptor = JSON.parse(process.env.ADE_CLAUDE_WORKER_DESCRIPTOR ?? 'null')
if (!descriptor) throw new Error('The owning ADE runtime must provide Claude worker metadata')
const failure = (code, message) => ({ code, message })

function requestProjection(toolName, input, options) {
  if (toolName === 'AskUserQuestion') {
    const questions = (input.questions ?? []).map((question, index) => ({
      id: String(index),
      header: question.header ?? null,
      prompt: question.question ?? '',
      multiple: !!question.multiSelect,
      allow_other: !!question.allowOther,
      secret: false,
      options:
        question.options == null
          ? null
          : question.options.map((option) => ({
              label: option.label ?? '',
              description: option.description ?? '',
              value: option.label ?? '',
            })),
    }))
    return {
      schema: { kind: 'questions', questions },
      summary: 'Claude is asking for your input',
    }
  }
  const suggestions = options.suggestions ?? []
  const onceChoice = { kind: 'claude_permission', decision: 'allow_once' }
  const denyChoice = { kind: 'claude_permission', decision: 'deny' }
  const choices = [
    { value: denyChoice, label: 'Deny' },
    { value: onceChoice, label: 'Allow once', scope: 'once' },
    ...suggestions.map((suggestion) => {
      const destination = suggestion.destination
      const scope =
        destination === 'session'
          ? 'session'
          : ['userSettings', 'projectSettings', 'localSettings'].includes(destination)
            ? 'persistent'
            : undefined
      const labels = {
        session: 'Allow for this session',
        userSettings: 'Always allow in user settings',
        projectSettings: 'Always allow in project settings',
        localSettings: 'Always allow in local settings',
        cliArg: 'Apply Claude CLI permission update',
      }
      return {
        value: suggestion,
        label: labels[destination] ?? 'Use Claude permission update',
        ...(scope ? { scope } : {}),
      }
    }),
  ]
  return {
    schema: { kind: 'choices', choices },
    summary: `Claude requests permission to use ${toolName}; strict automatic review is unavailable`,
  }
}

function answersFor(request, answer) {
  if (answer?.kind === 'questions' && request.toolName === 'AskUserQuestion') {
    const mapped = {}
    for (const [index, question] of (request.input.questions ?? []).entries()) {
      const selected = answer.answers?.[String(index)]
      if (!Array.isArray(selected) || selected.length === 0)
        throw failure('invalid_request', `A response is required for question ${index}`)
      mapped[question.question] = selected.map(String).join(', ')
    }
    return { behavior: 'allow', updatedInput: { ...request.input, answers: mapped } }
  }
  if (answer?.kind === 'choice' && request.toolName !== 'AskUserQuestion') {
    if (isDeepStrictEqual(answer.value, { kind: 'claude_permission', decision: 'deny' }))
      return { behavior: 'deny', message: 'Permission denied by user' }
    if (isDeepStrictEqual(answer.value, { kind: 'claude_permission', decision: 'allow_once' }))
      return { behavior: 'allow', updatedInput: request.input, decisionClassification: 'user_temporary' }
    const selected = request.suggestions.find((suggestion) => isDeepStrictEqual(suggestion, answer.value))
    if (!selected) throw failure('invalid_request', 'Claude permission choice is not one of the SDK suggestions')
    const destination = selected.destination
    if (!['session', 'userSettings', 'projectSettings', 'localSettings', 'cliArg'].includes(destination))
      throw failure('unsupported', `Claude cannot apply permission destination ${destination}`)
    return {
      behavior: 'allow',
      updatedInput: request.input,
      updatedPermissions: [selected],
      ...(destination === 'cliArg'
        ? {}
        : {
            decisionClassification: destination === 'session' ? 'user_temporary' : 'user_permanent',
          }),
    }
  }
  throw failure('invalid_request', 'Claude request answer does not match the pending native request')
}

runProviderWorker({
  descriptor,
  dependencies: Layer.empty,
  acquire: Effect.gen(function* () {
    const eventCapacity = Math.min(32, descriptor.limits.max_output_entries)
    const events = yield* Queue.dropping(eventCapacity)
    const maxFrameBytes = descriptor.limits.max_output_frame_bytes
    const maxQueueBytes = maxFrameBytes * eventCapacity
    let queuedBytes = 0
    let ready = false
    let streamMessage = null
    const sdk = yield* Effect.tryPromise({
      try: () => import('@anthropic-ai/claude-agent-sdk'),
      catch: () => failure('provider_failure', 'The installed Claude Agent SDK could not be loaded'),
    })

    let active = true
    let nativeSession = null
    let query = null
    let run = null
    let mcpServers = {}
    let inputWake = null
    let queryGeneration = 0
    let openConfig = null
    let rewinding = false
    let inputQueue = []
    let activeSubmission = null
    let activeAttemptId = null
    let interruptedSubmission = null
    let interruptResult = null
    let pendingSends = new Map()
    let callbacks = new Map()
    let subagents = new Subagents()
    let messageAliases = new Map()
    let transcript = null

    const push = (event) => {
      if (!active) return
      const bytes = Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: event })) + 1
      if (bytes <= maxFrameBytes && queuedBytes + bytes <= maxQueueBytes) {
        queuedBytes += bytes
        if (Queue.offerUnsafe(events, { event, bytes })) return
        queuedBytes -= bytes
      }
      const detail = failure('resource_limit', 'Claude worker event exceeds the declared output byte or entry budget')
      active = false
      wakeInput()
      failPending(detail)
      query?.close()
      Queue.failCauseUnsafe(events, Cause.fail(detail))
    }
    const wakeInput = () => {
      const wake = inputWake
      inputWake = null
      wake?.()
    }
    async function* prompts() {
      const generation = queryGeneration
      while (active && generation === queryGeneration) {
        if (inputQueue.length) {
          yield inputQueue.shift()
          continue
        }
        await new Promise((resolve) => {
          inputWake = resolve
        })
      }
    }
    const confirmInputs = (message) => {
      const uuids =
        message.user_message_uuids ??
        [message.user_message_uuid, message.type === 'user' ? message.uuid : null].filter(Boolean)
      for (const uuid of uuids) {
        const sent = pendingSends.get(uuid)
        if (!sent) continue
        if (!sent.confirmed) {
          sent.confirmed = true
          push({
            type: 'submitted',
            submission: sent.submission,
            turn: null,
            admitted: true,
            dispatch: 'dispatched',
            native_outcome: 'accepted',
          })
        }
        return sent
      }
      return null
    }
    const emitItems = (message, sent) => {
      for (const event of transcript.project(message, sent)) push(event)
    }
    const canUseTool = async (toolName, input, options) => {
      if (options.signal?.aborted || !active) return { behavior: 'deny', message: 'Claude cancelled this request' }
      const callbackId = randomUUID()
      const callbackSession = nativeSession
      const callbackInput = transcript.calls.get(options.toolUseID)?.sent
      const callbackSubmission = callbackInput?.confirmed ? callbackInput.submission : null
      const { schema, summary } = requestProjection(toolName, input, options)
      let resolveCallback
      const result = new Promise((resolve) => {
        resolveCallback = resolve
      })
      const settle = (value, resolution) => {
        if (!callbacks.delete(callbackId)) return false
        options.signal?.removeEventListener('abort', abort)
        resolveCallback(value)
        if (resolution === 'withdrawn')
          push({
            type: 'resolved',
            id: options.requestId,
            resolution,
            session: callbackSession,
            submission: callbackSubmission,
          })
        return true
      }
      const abort = () => settle({ behavior: 'deny', message: 'Claude cancelled this request' }, 'withdrawn')
      callbacks.set(callbackId, { settle, toolName, input, suggestions: options.suggestions ?? [] })
      options.signal?.addEventListener('abort', abort, { once: true })
      push({
        type: 'request',
        submission: callbackSubmission,
        id: callbackId,
        method: 'claude/canUseTool',
        params: { toolName },
        session: nativeSession,
        turn: null,
        supported: true,
        metadata: {
          blocking: true,
          native_callback_id: options.toolUseID ?? null,
          native_item_id: options.toolUseID ?? null,
          native_request_id: options.requestId ?? null,
          native_session_id: nativeSession,
          native_turn_id: null,
          schema,
          schema_version: 1,
          summary,
        },
      })
      if (options.signal?.aborted) abort()
      return result
    }
    const failPending = (detail) => {
      pendingSends.clear()
      for (const callback of callbacks.values())
        callback.settle({ behavior: 'deny', message: detail.message ?? 'Claude worker is closing' })
    }
    const start = (params) => {
      const options = {
        cwd: process.cwd(),
        settingSources: params.config.setting_sources,
        permissionMode: params.config.permission_mode,
        mcpServers,
        canUseTool,
        includePartialMessages: true,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        onElicitation: async () => ({ action: 'decline' }),
        ...(params.config.model ? { model: params.config.model } : {}),
        ...(params.resume ? { resume: params.resume } : { sessionId: nativeSession }),
        ...(process.env.ADE_CLAUDE_BIN ? { pathToClaudeCodeExecutable: process.env.ADE_CLAUDE_BIN } : {}),
      }
      const usageStream = { query_id: randomUUID(), fresh: !params.resume, results: 0 }
      query = sdk.query({ prompt: prompts(), options })
      let readFailure = null
      run = (async () => {
        try {
          for await (const message of query) {
            if (!active) break
            if (message.session_id && message.session_id !== nativeSession)
              throw failure('provider_failure', 'Claude SDK returned a different native session identity')
            const sent = confirmInputs(message)
            if (message.type === 'rate_limit_event')
              push({
                type: 'usage',
                session: nativeSession,
                submission: sent?.submission ?? null,
                turn: null,
                source: 'rate_limit_event',
                report: message.rate_limit_info ?? {},
              })
            const nativeToolOwner = transcript.calls.get(message.tool_use_id)?.sent
            const child = subagents.consume(message, {
              session: nativeSession,
              turn: null,
              submission: nativeToolOwner?.submission ?? null,
            })
            if (child)
              push({
                type: 'item',
                session: nativeSession,
                submission: subagents.tasks.get(message.task_id).owner.submission,
                item: child,
              })
            if (message.type === 'stream_event' && !message.parent_tool_use_id) {
              const event = message.event
              if (event?.type === 'message_start') {
                streamMessage = { id: event.message.id, sent }
              } else if (streamMessage && event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                if (message.user_message_uuid || message.user_message_uuids) streamMessage.sent = sent
                push({
                  type: 'delta',
                  id: streamMessage.id + ':' + event.index,
                  kind: 'text',
                  role: 'assistant',
                  text: event.delta.text,
                  session: nativeSession,
                  turn: null,
                  submission: streamMessage.sent?.submission ?? null,
                })
              }
            } else if (message.type === 'user' || message.type === 'assistant') {
              const explicitlyCorrelated = message.user_message_uuid || message.user_message_uuids
              const outputOwner =
                sent ??
                (!explicitlyCorrelated && streamMessage && message.message?.id === streamMessage.id
                  ? streamMessage.sent
                  : null)
              emitItems(message, outputOwner)
              if (message.type === 'assistant' && message.message?.id === streamMessage?.id) streamMessage = null
            } else if (message.type === 'result' && sent) {
              const cancelled =
                message.terminal_reason === 'aborted_streaming' || message.terminal_reason === 'aborted_tools'
              const error = message.is_error
                ? String(message.result ?? message.errors?.join('; ') ?? 'Claude turn failed')
                : null
              push({
                type: 'usage',
                session: nativeSession,
                submission: sent.submission,
                turn: null,
                source: 'result',
                report: {
                  usage: message.usage ?? null,
                  modelUsage: message.modelUsage ?? null,
                  total_cost_usd: message.total_cost_usd ?? null,
                  is_error: !!message.is_error,
                  query_id: usageStream.query_id,
                  fresh: usageStream.fresh,
                  result_index: usageStream.results++,
                },
              })
              push({
                type: 'finished',
                session: nativeSession,
                submission: sent.submission,
                turn: null,
                status: cancelled ? 'cancelled' : message.is_error ? 'failed' : 'completed',
                error,
                interrupt_requested: interruptedSubmission === sent.submission,
                native_terminal: {
                  subtype: message.subtype ?? null,
                  is_error: message.is_error,
                  terminal_reason: message.terminal_reason ?? null,
                  stop_reason: message.stop_reason ?? null,
                  api_error_status: message.api_error_status ?? null,
                  errors: message.errors ?? [],
                },
              })
              pendingSends.delete(sent.inputUuid)
              activeSubmission = null
              activeAttemptId = null
              interruptedSubmission = null
              interruptResult = null
              streamMessage = null
            }
          }
        } catch (error) {
          readFailure = error?.code ? error : failure('provider_failure', error.message ?? 'Claude Agent SDK failed')
          failPending(readFailure)
          if (ready) {
            push({ type: 'error', session: nativeSession, turn: null, error: readFailure.message })
            if (activeSubmission)
              push({
                type: 'finished',
                session: nativeSession,
                submission: activeSubmission,
                turn: null,
                status: 'failed',
                error: readFailure.message,
              })
          }
          active = false
          wakeInput()
          query.close()
        }
      })()
      // initializationResult is a control capability report, not a session-ID report.
      // Read native startup frames concurrently so identity/refusal reaches open.
      return query.initializationResult().then(async () => {
        await new Promise((resolve) => setImmediate(resolve))
        if (readFailure) throw readFailure
        ready = true
        push({ type: 'started', session: nativeSession, submission: null, turn: null })
      })
    }

    return {
      open: (params) =>
        Effect.tryPromise({
          try: async () => {
            if (query) throw failure('invalid_request', 'Claude worker already opened a native session')
            nativeSession = params.resume ?? randomUUID()
            openConfig = params.config
            messageAliases = loadAliases(nativeSession)
            transcript = new Transcript(nativeSession, messageAliases)
            if (params.resume) {
              await hydrateTranscript(sdk, nativeSession, transcript)
            }
            try {
              await start(params)
            } catch (error) {
              active = false
              wakeInput()
              query?.close()
              throw error
            }
            return { session: nativeSession, history: [] }
          },
          catch: (error) =>
            error?.code ? error : failure('provider_failure', 'Claude Agent SDK initialization failed'),
        }),
      send: (params) =>
        Effect.try({
          try: () => {
            if (!query || !active || params.session !== nativeSession)
              throw failure('invalid_request', 'Claude session is not open')
            if (rewinding) throw failure('invalid_request', 'Claude conversation is being rewound')
            if (pendingSends.size || activeSubmission || inputQueue.length)
              throw failure('resource_limit', 'Claude already has an active or queued prompt')
            const messageId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              params.message_id ?? '',
            )
              ? params.message_id
              : randomUUID()
            const content = [{ type: 'text', text: params.text }]
            for (const part of params.attachments ?? []) {
              const attachment = part.attachment
              if (attachment.media_type.startsWith('image/'))
                content.push({
                  type: 'image',
                  source: { type: 'base64', media_type: attachment.media_type, data: part.data },
                })
              else if (attachment.media_type === 'application/pdf')
                content.push({
                  type: 'document',
                  source: { type: 'base64', media_type: attachment.media_type, data: part.data },
                })
              else if (attachment.media_type.startsWith('text/'))
                content.push({
                  type: 'text',
                  text: `Attached file ${attachment.name}:\n${Buffer.from(part.data, 'base64').toString('utf8')}`,
                })
              else throw failure('unsupported', `Claude does not support ${attachment.media_type} attachments`)
            }
            const message = {
              type: 'user',
              message: { role: 'user', content },
              parent_tool_use_id: null,
              session_id: nativeSession,
              uuid: messageId,
            }
            if (params.message_id) {
              messageAliases.set(messageId, params.message_id)
              saveAliases(nativeSession, null, messageAliases)
            }
            pendingSends.set(messageId, {
              inputUuid: messageId,
              messageId: params.message_id ?? null,
              submission: params.submission,
              sourceAttemptId: params.source_attempt_id,
              confirmed: false,
            })
            activeSubmission = params.submission
            activeAttemptId = params.source_attempt_id
            inputQueue.push(message)
            wakeInput()
            return { turn: null, admitted: true, dispatch: 'pending', native_outcome: 'pending' }
          },
          catch: (error) => (error?.code ? error : failure('provider_failure', 'Claude input could not be submitted')),
        }),
      steer: () => Effect.fail(failure('unsupported', 'Claude SDK does not expose native steering')),
      cancel: (params) =>
        Effect.tryPromise({
          try: async () => {
            if (!query || !active || params.session !== nativeSession)
              throw failure('invalid_request', 'Claude session is not open')
            if (params.turn != null)
              throw failure('unsupported', 'Claude does not expose a native turn ID to match this cancellation')
            const admitted = [...pendingSends.values()].find(
              (sent) => sent.submission === params.submission_id && sent.sourceAttemptId === params.source_attempt_id,
            )
            if (!admitted || params.source_attempt_id !== activeAttemptId || params.submission_id !== activeSubmission)
              throw failure('invalid_request', 'Claude cancellation does not match the active submission identity')
            if (interruptedSubmission === activeSubmission) return interruptResult
            interruptedSubmission = activeSubmission
            interruptResult = query.interrupt().then((receipt) => {
              if (receipt?.still_queued?.includes(admitted.inputUuid)) {
                interruptedSubmission = null
                throw failure('unsupported', 'Claude SDK left the cancelled submission queued')
              }
              return {
                type: 'cancel_result',
                evidence: {
                  scope: 'turn',
                  interruption_requested: true,
                  termination: 'requested',
                  active_work_remaining: null,
                  queued_work_count: null,
                  background_work_remaining: null,
                  observed_at_ms: null,
                },
              }
            })
            return interruptResult
          },
          catch: (error) => {
            if (interruptedSubmission === params.submission_id) interruptedSubmission = null
            return error?.code ? error : failure('provider_failure', 'Claude Agent SDK interrupt failed')
          },
        }),
      answer: (params) =>
        Effect.try({
          try: () => {
            const callback = callbacks.get(params.id)
            if (!callback) throw failure('invalid_request', 'Claude callback is no longer pending')
            const resolved = answersFor(callback, params.answer)
            callback.settle(resolved, 'resolved')
            return {}
          },
          catch: (error) => (error?.code ? error : failure('invalid_request', 'Claude request answer was invalid')),
        }),
      configure_mcp: (params) =>
        Effect.try({
          try: () => {
            if (query) throw failure('unsupported', 'Configure Claude MCP servers before opening the native session')
            mcpServers = params.servers
            return {}
          },
          catch: (error) => (error?.code ? error : failure('invalid_request', 'Claude MCP configuration was invalid')),
        }),
      history: (params) =>
        Effect.tryPromise({
          try: () =>
            historyPage(
              sdk,
              {
                ...params,
                max_items: Math.min(params.max_items, descriptor.limits.max_history_page_items),
                max_bytes: Math.min(params.max_bytes, 512 * 1024),
              },
              maxFrameBytes,
            ),
          catch: (error) =>
            error?.code ? error : failure('provider_failure', error.message ?? 'Claude native history failed'),
        }),
      child_transcript: (params) =>
        Effect.tryPromise({
          try: () => childTranscript(sdk, params, descriptor.limits),
          catch: (error) =>
            error?.code ? error : failure('provider_failure', error.message ?? 'Claude child transcript failed'),
        }),
      rewind: (params) =>
        Effect.tryPromise({
          try: async () => {
            if (!query || !active || params.session !== nativeSession)
              throw failure('invalid_request', 'Claude rewind session is not open')
            if (rewinding || activeSubmission || pendingSends.size || inputQueue.length || callbacks.size)
              throw failure('invalid_request', 'Stop the active Claude input before rewinding')
            rewinding = true
            try {
              const options = {
                cwd: process.cwd(),
                settingSources: openConfig.setting_sources,
                permissionMode: openConfig.permission_mode,
                mcpServers,
                includePartialMessages: true,
                systemPrompt: { type: 'preset', preset: 'claude_code' },
                onElicitation: async () => ({ action: 'decline' }),
                ...(openConfig.model ? { model: openConfig.model } : {}),
                ...(process.env.ADE_CLAUDE_BIN ? { pathToClaudeCodeExecutable: process.env.ADE_CLAUDE_BIN } : {}),
              }
              const fork = await forkBefore(sdk, nativeSession, params.native_message, options, messageAliases)
              const receipts = transcript.plans.receipts
              queryGeneration++
              wakeInput()
              query.close()
              await run
              nativeSession = fork.session
              messageAliases = fork.aliases
              transcript = new Transcript(nativeSession, messageAliases)
              streamMessage = null
              await hydrateTranscript(sdk, nativeSession, transcript, receipts)
              subagents = new Subagents()
              ready = false
              await start({ config: openConfig, resume: nativeSession })
              return { session: fork.session, previous_session: fork.previous_session, scope: fork.scope }
            } finally {
              rewinding = false
            }
          },
          catch: (error) =>
            error?.code ? error : failure('provider_failure', error.message ?? 'Claude native rewind failed'),
        }),
      events: Stream.map(Stream.fromQueue(events), (entry) => {
        queuedBytes -= entry.bytes
        return entry.event
      }),
      close: Effect.tryPromise({
        try: async () => {
          failPending(failure('shutdown', 'Claude worker is closing'))
          active = false
          wakeInput()
          if (query) {
            query.close()
            await run
          }
        },
        catch: (error) => (error?.code ? error : failure('provider_failure', 'Claude Agent SDK did not close cleanly')),
      }),
    }
  }),
})
