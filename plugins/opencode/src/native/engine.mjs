// The OpenCode v2 session engine behind the public worker. It owns one private
// `opencode serve --stdio` server, translates its HTTP/SSE API into ADE provider
// events, and never resubmits a prompt: a lost reply is reconciled by reading the
// durable inbox and transcript, and parked work resumes only on an explicit answer.
import { setTimeout as delay } from 'node:timers/promises'
import { OpenCodeHttpError, OpenCodeTransport } from './transport.mjs'
import { SessionApi } from './session-api.mjs'
import { projectHistory, projectMessage } from './transcript.mjs'
import { TextStream } from './text-stream.mjs'

/** A typed worker failure: the provider worker contract's `{ code, message }`. */
export const failure = (code, message) => ({ code, message: String(message).slice(0, 4000) })
const isFailure = (value) => value !== null && typeof value === 'object' && typeof value.code === 'string'

/** Any thrown value as a typed failure; HTTP and transport errors keep their meaning. */
export function asFailure(error, fallback = 'OpenCode request failed') {
  if (isFailure(error) && !(error instanceof Error)) return failure(error.code, error.message)
  if (error instanceof OpenCodeHttpError) {
    if (error.status === 401 || error.status === 403) return failure('authentication_required', error.message)
    if (error.status === 409) return failure('invalid_request', error.message)
    if (error.status === 429) return failure('rate_limited', error.message)
    return failure('provider_failure', error.message)
  }
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError')
    return failure('timeout', error.message || 'OpenCode did not answer in time')
  return failure('provider_failure', error?.message || fallback)
}

const HISTORY_ITEMS = 32
const HISTORY_BYTES = 512 * 1024
const CHILD_MESSAGES = 8
const terminalReason = { completed: 'idle.succeeded', failed: 'idle.failed', interrupted: 'idle.interrupted' }

export class OpenCodeEngine {
  constructor(emit, { cwd = process.cwd(), command, env = process.env, connect } = {}) {
    this.emit = emit
    this.cwd = cwd
    this.connect =
      connect ??
      (async () => {
        const transport = await OpenCodeTransport.start({ command, cwd, env })
        try {
          return { transport, api: await SessionApi.connect(transport) }
        } catch (error) {
          await transport.stop()
          throw error
        }
      })
    this.closed = new AbortController()
    this.requests = new Map()
    this.session = null
    this.active = null
    this.epoch = 0
    this.ready = false
    this.version = null
  }

  #event(value) {
    if (!this.closed.signal.aborted) this.emit(value)
  }

  async open({ resume = null, config = {} }) {
    if (this.opening || this.transport) throw failure('invalid_request', 'OpenCode session is already open')
    this.opening = true
    if ((config.permission_mode ?? 'default') !== 'default')
      throw failure('unsupported', 'OpenCode runs only in its native default permission mode')
    let model
    if (config.model) {
      const slash = config.model.indexOf('/')
      if (slash <= 0 || slash === config.model.length - 1)
        throw failure('invalid_request', 'Use provider/model for an OpenCode model')
      model = { providerID: config.model.slice(0, slash), id: config.model.slice(slash + 1) }
    }
    try {
      ;({ transport: this.transport, api: this.api } = await this.connect())
    } catch (error) {
      throw failure('provider_failure', `OpenCode did not start: ${error?.message ?? 'unknown error'}`)
    }
    this.version = this.transport.info?.version ?? null
    try {
      if (model) await this.#modelSettled(model)
      const info = await this.api.open({ resume, cwd: this.cwd, model })
      this.session = info.id
      this.text = new TextStream(this.session)
      let connected
      const firstConnection = new Promise((resolve) => {
        connected = resolve
      })
      this.pump = this.#consume(connected).catch((error) => this.#fail(error))
      await Promise.race([
        firstConnection,
        delay(10_000, null, { signal: this.closed.signal }).then(() => {
          throw failure('timeout', 'OpenCode event subscription timed out')
        }),
      ])
      const history = projectHistory(await this.#messages())
      this.text.reconcile(history.items)
      this.knownTurns = new Set(history.items.filter((item) => item.role === 'user').map((item) => item.turn))
      const pending = await this.api.pending(this.session)
      if (pending.active)
        throw failure('provider_failure', 'OpenCode session is already executing; ownership transfer is required')
      if (pending.inbox.length) {
        const entry = pending.inbox[0]
        if (pending.inbox.length !== 1 || entry.type !== 'user' || !entry.payload?.metadata?.ade_submission)
          throw failure('provider_failure', 'OpenCode has queued work that ADE did not submit')
        // Parked ADE input from an earlier worker: disclose it and wait for an explicit
        // resume or cancel. It belongs to no current ADE attempt, so its events carry
        // no submission and the request names no running turn.
        this.active = { turn: entry.id, submission: null, recovery: true, detached: true }
        this.knownTurns.add(entry.id)
        this.#request(
          `recover:${entry.id}`,
          'opencode/recover',
          { reason: 'OpenCode holds this prompt unexecuted. Resume it, or cancel it.', prompt: entry.payload.text },
          {
            summary: 'OpenCode holds a queued prompt from before the restart',
            schema: {
              kind: 'choices',
              choices: [
                { value: 'resume', label: 'Resume the queued prompt' },
                { value: 'cancel', label: 'Cancel it' },
              ],
            },
          },
        )
      }
      this.ready = true
      this.fallback = setInterval(() => this.#schedule(), 5000)
      this.#schedule()
      return { session: this.session, history: tail(history.items) }
    } catch (error) {
      await this.close()
      throw asFailure(error, 'OpenCode session did not open')
    }
  }

  /**
   * A fresh OpenCode server publishes its model snapshot after integrations settle
   * ("the snapshot may precede initial plugin settlement"). Wait a bounded time for the
   * chosen model to appear so the first prompt does not race that settlement.
   */
  async #modelSettled(model) {
    const directory = encodeURIComponent(this.cwd)
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      let models
      try {
        models = (await this.transport.request('GET', `/api/model?location[directory]=${directory}`)).data
      } catch (error) {
        if (error?.status === 404) return // A server without the route has no settlement to wait for.
        throw error
      }
      if (
        Array.isArray(models) &&
        models.some((entry) => entry.providerID === model.providerID && entry.modelID === model.id)
      )
        return
      await delay(250, undefined, { signal: this.closed.signal })
    }
    throw failure('invalid_request', `OpenCode does not offer the model ${model.providerID}/${model.id}`)
  }

  /** The durable transcript, oldest first, bounded by the admission limits. */
  async #messages(turn = null, signal) {
    const messages = []
    let bytes = 0
    for await (const message of this.api.messages(this.session, {
      order: turn ? 'desc' : 'asc',
      signal: signal ? AbortSignal.any([this.closed.signal, signal]) : this.closed.signal,
    })) {
      bytes += Buffer.byteLength(JSON.stringify(message))
      if (messages.length >= 2000 || bytes > 16 * 1024 * 1024)
        throw failure('resource_limit', 'OpenCode history exceeds ADE admission limits')
      messages.push(message)
      if (turn && message.id === turn) break
    }
    return turn ? messages.reverse() : messages
  }

  /** One bounded page of the native transcript; the query never opens or resumes work. */
  async history({ session, context, snapshot, cursor, max_items, max_bytes }, signal) {
    if (!this.ready || session !== this.session)
      throw failure('invalid_request', 'OpenCode history request is for another session')
    const messages = await this.#messages(null, signal)
    const items = projectHistory(messages).items.map((item) => ({ ...item, client_id: null }))
    const generation = `${messages.length}:${messages.at(-1)?.id ?? ''}`
    const identity = {
      ...context,
      session,
      source: `opencode:${session}`,
      generation,
      consistency: 'best_effort',
    }
    if (
      snapshot &&
      ['provider', 'session', 'execution_id', 'source', 'generation', 'invalidation_epoch'].some(
        (key) => snapshot[key] !== identity[key],
      )
    )
      throw failure('invalid_request', 'OpenCode history changed since that snapshot')
    let offset = 0
    if (cursor) {
      let decoded
      try {
        decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
      } catch {
        throw failure('invalid_request', 'OpenCode history cursor is invalid')
      }
      if (
        decoded.generation !== generation ||
        decoded.epoch !== context.invalidation_epoch ||
        !Number.isSafeInteger(decoded.offset) ||
        decoded.offset < 0 ||
        decoded.offset > items.length
      )
        throw failure('invalid_request', 'OpenCode history cursor is stale')
      offset = decoded.offset
    }
    const limit = Math.min(HISTORY_ITEMS, max_items)
    const budget = Math.min(HISTORY_BYTES, max_bytes)
    const page = []
    // Bytes of the encoded item array, as ADE measures it: brackets, items and commas.
    let retained = 2
    for (const item of items.slice(offset)) {
      const size = Buffer.byteLength(JSON.stringify(item)) + (page.length ? 1 : 0)
      if (page.length >= limit || retained + size > budget) {
        if (page.length === 0)
          return {
            snapshot: identity,
            items: [],
            next_cursor: null,
            retained_bytes: 2,
            complete: false,
            error: failure('resource_limit', 'An OpenCode history item exceeds the requested page byte limit'),
          }
        break
      }
      page.push(item)
      retained += size
    }
    const next = offset + page.length
    const next_cursor =
      next < items.length
        ? Buffer.from(JSON.stringify({ generation, epoch: context.invalidation_epoch, offset: next })).toString(
            'base64url',
          )
        : null
    return {
      snapshot: identity,
      items: page,
      next_cursor,
      retained_bytes: retained,
      complete: !next_cursor,
      error: null,
    }
  }

  // session.ts calls this through the engine's declaration file; fallow cannot follow it.
  // fallow-ignore-next-line unused-class-member
  async childTranscript({ session, child, offset = 0, cursor = null }, signal) {
    if (!this.ready || this.closed.signal.aborted || session !== this.session)
      throw failure('invalid_request', 'OpenCode parent session is not connected')
    if (typeof child !== 'string' || !/^ses[a-zA-Z0-9_-]{1,256}$/.test(child))
      throw failure('invalid_request', 'Invalid OpenCode child identity')
    if (offset !== 0) throw failure('invalid_request', 'The OpenCode child reader pages by continuation cursor')
    const page = await this.api.childMessages(
      session,
      child,
      cursor,
      signal ? AbortSignal.any([this.closed.signal, signal]) : this.closed.signal,
      CHILD_MESSAGES,
    )
    const items = []
    let bytes = 0
    for (const message of page.messages) {
      for (const item of projectMessage(message, null)) {
        bytes += Buffer.byteLength(JSON.stringify(item))
        if (bytes > HISTORY_BYTES || items.length >= HISTORY_ITEMS)
          throw failure('resource_limit', 'An OpenCode child page exceeds the transcript page limits')
        items.push(item)
      }
    }
    return { type: 'child_transcript', child_id: child, items, next_cursor: page.next_cursor }
  }

  async #consume(connected) {
    let failures = 0
    while (!this.closed.signal.aborted) {
      try {
        for await (const event of this.transport.events({ signal: this.closed.signal })) {
          failures = 0
          if (event.type === 'server.connected') {
            connected()
            this.#schedule()
            continue
          }
          if (event.data?.sessionID !== this.session || !this.ready) continue
          for (const update of this.text.consume(event, this.active?.turn))
            this.#event({ ...update, session: this.session, submission: this.active?.submission ?? null })
          if (!['session.text.delta', 'session.reasoning.delta', 'session.tool.input.delta'].includes(event.type))
            this.#schedule()
        }
      } catch (error) {
        if (this.closed.signal.aborted) return
        if (isFailure(error) && !(error instanceof Error)) throw error
        this.epoch++
        this.text.disconnected()
        if (++failures > 5) throw failure('transport_failure', 'OpenCode event connection could not recover')
        await delay(Math.min(100 * 2 ** failures, 2000), undefined, { signal: this.closed.signal })
      }
    }
  }

  #schedule() {
    this.dirty = true
    if (!this.ready || this.timer || this.refreshing || this.closed.signal.aborted) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.refreshing = this.refresh()
        .then(() => {
          this.refreshFailures = 0
        })
        .catch(async (error) => {
          if (
            (error instanceof TypeError || error?.status >= 500) &&
            (this.refreshFailures = (this.refreshFailures ?? 0) + 1) <= 5
          ) {
            this.dirty = true
            await delay(250 * this.refreshFailures, undefined, { signal: this.closed.signal }).catch(() => {})
          } else await this.#fail(error)
        })
        .finally(() => {
          this.refreshing = null
          if (this.dirty) this.#schedule()
        })
    }, 30)
  }

  #finish(active, completion) {
    this.active = null
    this.#resolveAll()
    this.#event({
      type: 'finished',
      session: this.session,
      submission: active?.submission ?? null,
      turn: completion.turn,
      status: completion.status,
      error: completion.error,
      native_terminal: { terminal_reason: terminalReason[completion.status], is_error: completion.status === 'failed' },
      interrupt_requested: !!active?.interruptRequested,
    })
  }

  async refresh() {
    this.dirty = false
    let active = this.active
    if (active?.sending || active?.recovery || active?.cancelling) return
    if (!active) {
      const epoch = this.epoch
      const projection = projectHistory(await this.#messages())
      if (epoch !== this.epoch || this.active || this.closed.signal.aborted) return
      // Another client of the same server (an attached OpenCode TUI) admits work
      // directly. A durable user message, not a volatile delta, establishes its turn.
      for (const user of projection.items.filter((item) => item.role === 'user')) {
        if (this.knownTurns.has(user.turn)) continue
        this.knownTurns.add(user.turn)
        active = this.active = { turn: user.turn, submission: null, external: true }
        this.#event({ type: 'started', session: this.session, submission: null, turn: user.turn })
        for (const update of this.text.reconcile(projection.items.filter((item) => item.turn === user.turn)))
          this.#event({ ...update, session: this.session, submission: null })
        const completion = projection.completions.get(user.turn)
        if (!completion) break
        this.#finish(active, completion)
        active = null
      }
      if (!active) return
    }
    const epoch = this.epoch
    const [messages, pending] = await Promise.all([this.#messages(active.turn), this.api.pending(this.session)])
    if (epoch !== this.epoch || active !== this.active || active.cancelling || this.closed.signal.aborted) return
    const projection = projectHistory(messages)
    for (const update of this.text.reconcile(projection.items.filter((item) => item.turn === active.turn)))
      this.#event({ ...update, session: this.session, submission: active.submission })
    const completion = projection.completions.get(active.turn)
    if (completion) {
      this.#finish(active, completion)
      this.#schedule()
      return
    }
    const seen = new Set()
    for (const permission of pending.permissions) {
      seen.add(permission.id)
      this.#request(
        permission.id,
        'opencode/toolApproval',
        { tool: permission.action, reason: permission.message ?? '', resources: permission.resources },
        {
          summary: `OpenCode asks to use ${permission.action}`,
          schema: {
            kind: 'choices',
            choices: [
              { value: 'once', label: 'Allow once', scope: 'once' },
              { value: 'reject', label: 'Deny' },
            ],
          },
        },
      )
    }
    for (const form of pending.forms) {
      seen.add(form.id)
      const fields = Array.isArray(form.fields) ? form.fields : []
      const supported = fields.length > 0 && fields.every((field) => field.type === 'string' && !field.when?.length)
      this.#request(
        form.id,
        'opencode/questions',
        { reason: form.title },
        {
          summary: form.title || 'OpenCode asks a question',
          schema: supported
            ? {
                kind: 'questions',
                questions: fields.map((field) => ({
                  id: field.key,
                  header: field.description ?? null,
                  prompt: field.title ?? field.key,
                  secret: false,
                  allow_other: !field.options?.length,
                  multiple: false,
                  ...(field.options?.length
                    ? {
                        options: field.options.map((option) => ({
                          value: option.value,
                          label: option.label ?? String(option.value),
                          description: '',
                        })),
                      }
                    : {}),
                })),
                decline: { value: 'cancel', label: 'Cancel' },
              }
            : { kind: 'unsupported', reason: 'This OpenCode form uses fields ADE cannot present' },
        },
        supported,
      )
    }
    for (const [id, request] of this.requests) {
      if (request.kind !== 'recover' && !seen.has(id)) this.#resolve(id, 'withdrawn')
    }
  }

  #request(id, method, params, { summary, schema }, supported = true) {
    if (this.requests.has(id)) return
    const kind = method === 'opencode/recover' ? 'recover' : method === 'opencode/toolApproval' ? 'permission' : 'form'
    this.requests.set(id, { kind, turn: this.active.turn, submission: this.active.submission, responding: false })
    this.#event({
      type: 'request',
      session: this.session,
      submission: this.active.submission ?? null,
      turn: this.active.detached ? null : this.active.turn,
      id,
      method,
      params,
      supported,
      metadata: {
        schema_version: 1,
        summary: summary.slice(0, 512),
        schema,
        blocking: true,
        native_session_id: this.session,
        native_turn_id: this.active.turn,
        native_request_id: id,
      },
    })
  }

  #resolve(id, resolution = 'resolved') {
    const request = this.requests.get(id)
    if (!request) return
    this.requests.delete(id)
    this.#event({ type: 'resolved', session: this.session, submission: request.submission ?? null, id, resolution })
  }

  #resolveAll() {
    for (const id of this.requests.keys()) this.#resolve(id, 'withdrawn')
  }

  async send({ session, submission, message_id, text, attachments = [] }) {
    if (!this.ready || session !== this.session || this.closed.signal.aborted)
      throw failure('invalid_request', 'OpenCode session is not open')
    if (this.active) throw failure('invalid_request', 'OpenCode already has an active turn')
    if (typeof message_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(message_id))
      throw failure('invalid_request', 'ADE did not supply a durable message identity for OpenCode')
    // The native ID derives from ADE's durable message ID, so a retried dispatch of
    // the same message names the same OpenCode prompt and is reconciled, never duplicated.
    const turn = `msg_${message_id}`
    // Reserve synchronously before the admission await so event refresh cannot
    // interpret a not-yet-admitted message as a completed turn.
    const active = { turn, submission, sending: true }
    this.active = active
    this.knownTurns.add(turn)
    const release = () => {
      if (this.active === active) this.active = null
      this.knownTurns.delete(turn)
      this.#schedule()
    }
    let pending
    try {
      pending = await this.api.pending(session)
    } catch (error) {
      release()
      throw asFailure(error, 'OpenCode state could not be read before admission')
    }
    if (pending.active || pending.inbox.length) {
      release()
      throw failure('invalid_request', 'OpenCode has work from another view; wait for it before submitting')
    }
    this.#event({ type: 'started', session, submission, turn })
    try {
      await this.api.submit(session, { id: turn, submission, text, attachments })
    } catch (error) {
      if (error instanceof OpenCodeHttpError && error.status < 500) {
        release()
        throw asFailure(error, 'OpenCode refused the prompt')
      }
      // The request may have reached OpenCode. Reconcile by reading, never by resending.
      const known = await this.#admitted(session, turn).catch(() => null)
      if (known !== true) {
        if (known === false) release()
        else active.sending = false
        return {
          turn: known === false ? null : turn,
          admitted: true,
          dispatch: 'dispatched',
          native_outcome: known === false ? 'rejected' : 'unknown',
        }
      }
    }
    active.sending = false
    this.#event({
      type: 'submitted',
      submission,
      turn,
      admitted: true,
      dispatch: 'dispatched',
      native_outcome: 'accepted',
    })
    this.#schedule()
    return { turn, admitted: true, dispatch: 'dispatched', native_outcome: 'accepted' }
  }

  /** True when OpenCode holds `turn` durably, false when it provably does not. */
  async #admitted(session, turn) {
    const pending = await this.api.pending(session)
    if (pending.inbox.some((entry) => entry.id === turn)) return true
    try {
      await this.transport.request(
        'GET',
        `/api/session/${encodeURIComponent(session)}/message/${encodeURIComponent(turn)}`,
      )
      return true
    } catch (error) {
      if (error instanceof OpenCodeHttpError && error.status === 404) return pending.active ? null : false
      throw error
    }
  }

  async cancel({ session, submission_id, turn = null }) {
    const active = this.active
    if (session !== this.session || !active || active.submission !== submission_id || (turn && active.turn !== turn))
      throw failure('invalid_request', 'That OpenCode turn is no longer active')
    if (active.sending) throw failure('invalid_request', 'OpenCode prompt admission is still in progress')
    if (active.cancelling) throw failure('invalid_request', 'OpenCode cancellation is already in progress')
    active.cancelling = true
    active.interruptRequested = true
    try {
      const before = await this.api.pending(session)
      if (before.inbox.some((entry) => entry.id === active.turn)) {
        try {
          await this.api.cancelQueued(session, active.turn)
        } catch (error) {
          if (error?.status !== 409) throw error
        }
      }
      await this.api.interrupt(session)
      const after = await this.api.pending(session)
      const observed = Date.now()
      const projection = projectHistory(await this.#messages(active.turn))
      for (const update of this.text.reconcile(projection.items))
        this.#event({ ...update, session, submission: active.submission })
      const completion = projection.completions.get(active.turn)
      // Only OpenCode's own idle record for this turn proves it ended; the
      // interrupt reply alone does not.
      if (completion) this.#finish(active, completion)
      return {
        type: 'cancel_result',
        evidence: {
          scope: 'session',
          interruption_requested: true,
          termination: completion ? 'confirmed' : 'requested',
          active_work_remaining: after.active,
          queued_work_count: after.inbox.length,
          background_work_remaining: null,
          observed_at_ms: observed,
        },
      }
    } catch (error) {
      throw asFailure(error, 'OpenCode cancellation failed')
    } finally {
      active.cancelling = false
      this.#schedule()
    }
  }

  async answer({ id, answer, reason = null }) {
    const request = this.requests.get(id)
    if (!request || request.turn !== this.active?.turn || request.responding || this.active.cancelling)
      throw failure('invalid_request', 'That OpenCode request is no longer pending')
    request.responding = true
    try {
      if (request.kind === 'recover') {
        const choice = reason !== null ? 'cancel' : answer.kind === 'choice' ? answer.value : null
        if (choice === 'resume') {
          await this.api.resumeQueued(this.session, request.turn)
          this.active.recovery = false
          this.#event({ type: 'started', session: this.session, submission: null, turn: request.turn })
        } else if (choice === 'cancel') {
          const active = this.active
          await this.api.cancelQueued(this.session, request.turn)
          this.#resolve(id)
          this.active = null
          this.#event({
            type: 'finished',
            session: this.session,
            submission: active.submission,
            turn: active.turn,
            status: 'interrupted',
            error: null,
            native_terminal: { terminal_reason: 'inbox.cancelled', is_error: false },
            interrupt_requested: true,
          })
          return {}
        } else throw failure('invalid_request', 'Choose resume or cancel')
      } else if (request.kind === 'permission') {
        const decision = reason !== null ? 'reject' : answer.kind === 'choice' ? answer.value : null
        if (decision !== 'once' && decision !== 'reject')
          throw failure('invalid_request', 'OpenCode permission answers are once or reject')
        await this.api.permission(this.session, id, decision === 'once' ? 'accept' : 'decline')
      } else if (reason !== null || (answer.kind === 'choice' && answer.value === 'cancel')) {
        await this.api.form(this.session, id, null)
      } else if (answer.kind === 'questions') {
        const values = {}
        for (const [key, entries] of Object.entries(answer.answers)) {
          if (!Array.isArray(entries) || entries.length !== 1 || typeof entries[0] !== 'string')
            throw failure('invalid_request', 'OpenCode form fields take one text value')
          values[key] = entries[0]
        }
        await this.api.form(this.session, id, values)
      } else throw failure('invalid_request', 'Answer the questions or cancel')
      this.#resolve(id)
      this.#schedule()
      return {}
    } catch (error) {
      throw asFailure(error, 'OpenCode did not take the answer')
    } finally {
      request.responding = false
    }
  }

  async #fail(error) {
    if (this.closed.signal.aborted) return
    this.#event({ type: 'exited', error: asFailure(error).message })
    await this.close()
  }

  async close() {
    this.closed.abort()
    this.ready = false
    clearInterval(this.fallback)
    clearTimeout(this.timer)
    await this.transport?.stop()
  }
}

/** The newest items that fit one open reply; older ones stay readable through `history`. */
function tail(items) {
  const kept = []
  let bytes = 2
  for (let index = items.length - 1; index >= 0 && kept.length < HISTORY_ITEMS; index--) {
    const size = Buffer.byteLength(JSON.stringify(items[index])) + 1
    if (bytes + size > HISTORY_BYTES) break
    bytes += size
    kept.unshift(items[index])
  }
  return kept
}
