// Session operations use the owned executable's advertised contract. v2.0.3
// and the evaluated v2 source disagree on permission and interrupt fields.
import { createHash } from 'node:crypto'
const SESSION = '/api/session/{sessionID}'
const segment = (value) => encodeURIComponent(value)

export function protocol(spec) {
  const resolve = (schema) => {
    if (!schema?.$ref) return schema
    const prefix = '#/components/schemas/'
    if (!schema.$ref.startsWith(prefix)) throw new Error('Unsupported OpenCode schema reference')
    return spec.components?.schemas?.[schema.$ref.slice(prefix.length)]
  }
  const operation = (path, method) => {
    const result = spec.paths?.[path]?.[method]
    if (!result) throw new Error(`OpenCode lacks required ${method} ${path}`)
    return result
  }
  const body = (path) => resolve(operation(path, 'post').requestBody?.content?.['application/json']?.schema)
  const permission = body(`${SESSION}/permission/{requestID}/reply`)
  const permissionField = ['decision', 'reply'].find((key) => permission?.required?.includes(key))
  const replies = resolve(permission?.properties?.[permissionField])?.enum
  if (!permissionField || !['once', 'reject'].every((reply) => replies?.includes(reply))) {
    throw new Error('Unsupported OpenCode permission reply contract')
  }
  const interrupt = operation(`${SESSION}/interrupt`, 'post')
  const interruptField = interrupt.parameters?.find(
    (p) => p.in === 'query' && ['resume', 'continue'].includes(p.name),
  )?.name
  if (!interruptField) throw new Error('Unsupported OpenCode interrupt contract')
  const formCancelDelete = !!spec.paths?.[`${SESSION}/form/{formID}`]?.delete
  if (!formCancelDelete) operation(`${SESSION}/form/{formID}/cancel`, 'post')
  const prompt = body(`${SESSION}/prompt`)
  if (!['id', 'text', 'files', 'metadata', 'resume'].every((key) => key in (prompt?.properties ?? {}))) {
    throw new Error('OpenCode lacks durable prompt admission')
  }
  for (const [path, method] of [
    ['/api/session', 'post'],
    [SESSION, 'get'],
    [`${SESSION}/message`, 'get'],
    [`${SESSION}/message/{messageID}`, 'get'],
    [`${SESSION}/inbox`, 'get'],
    [`${SESSION}/inbox/{inboxID}`, 'delete'],
    [`${SESSION}/permission`, 'get'],
    [`${SESSION}/form`, 'get'],
    [`${SESSION}/form/{formID}/reply`, 'post'],
    ['/api/session/active', 'get'],
  ])
    operation(path, method)
  return Object.freeze({ permissionField, interruptField, formCancelDelete })
}

export class SessionApi {
  constructor(transport, dialect) {
    this.transport = transport
    this.dialect = dialect
  }

  static async connect(transport) {
    return new SessionApi(transport, protocol(await transport.request('GET', '/openapi.json')))
  }

  path(session) {
    if (typeof session !== 'string' || !session.startsWith('ses')) throw new Error('Invalid OpenCode session identity')
    return `/api/session/${segment(session)}`
  }

  async open({ resume, cwd, model, permissions }) {
    if (resume) {
      const existing = (await this.transport.request('GET', this.path(resume))).data
      if (existing.id !== resume) throw new Error('OpenCode returned a different session identity')
      // Never change an existing session location implicitly.
      if (existing.location?.directory !== cwd) throw new Error('OpenCode session belongs to a different directory')
      return existing
    }
    return (
      await this.transport.request('POST', '/api/session', {
        location: { directory: cwd },
        ...(model ? { model } : {}),
        ...(permissions ? { permissions } : {}),
      })
    ).data
  }

  async *messages(session, { signal, order = 'asc' } = {}) {
    let cursor
    const seen = new Set()
    do {
      const query = new URLSearchParams({ limit: '200', ...(cursor ? { cursor } : { order }) })
      const page = await this.transport.request('GET', `${this.path(session)}/message?${query}`, undefined, { signal })
      if (!Array.isArray(page.data)) throw new Error('Invalid OpenCode message page')
      for (const message of page.data) yield message
      cursor = page.cursor?.next
      if (cursor && seen.has(cursor)) throw new Error('OpenCode repeated a history cursor')
      if (cursor) seen.add(cursor)
    } while (cursor)
  }

  async pending(session) {
    const path = this.path(session)
    const [inbox, permissions, forms, active] = await Promise.all([
      this.transport.request('GET', `${path}/inbox`),
      this.transport.request('GET', `${path}/permission`),
      this.transport.request('GET', `${path}/form`),
      this.transport.request('GET', '/api/session/active'),
    ])
    // This is a set of projections, not an atomic snapshot. The bridge must
    // subscribe first and reconcile again when events arrive during these reads.
    return { inbox: inbox.data, permissions: permissions.data, forms: forms.data, active: !!active.data[session] }
  }

  async childMessages(parent, child, cursor, signal) {
    if (cursor != null && (typeof cursor !== 'string' || !cursor.length || Buffer.byteLength(cursor) > 4096))
      throw new Error('Invalid OpenCode child cursor')
    const info = (await this.transport.request('GET', this.path(child), undefined, { signal })).data
    if (info?.id !== child || info.parentID !== parent)
      throw new Error('OpenCode child does not belong to this parent session')
    const query = new URLSearchParams({ limit: '50', ...(cursor ? { cursor } : { order: 'asc' }) })
    const page = await this.transport.request('GET', `${this.path(child)}/message?${query}`, undefined, { signal })
    if (!Array.isArray(page.data) || page.data.length > 50) throw new Error('Invalid OpenCode child message page')
    const next = page.cursor?.next ?? null
    if (
      next !== null &&
      (typeof next !== 'string' || !next.length || Buffer.byteLength(next) > 4096 || next === cursor)
    )
      throw new Error('Invalid OpenCode child continuation')
    return { messages: page.data, next_cursor: next }
  }

  async submit(session, { id, submission, text, attachments = [], resume = true, retry = false }) {
    if (typeof id !== 'string' || !id.startsWith('msg_')) throw new Error('Missing durable OpenCode message identity')
    if (typeof submission !== 'string' || !submission) throw new Error('Missing lux-ade submission identity')
    const files = []
    for (const { attachment, data } of attachments) {
      if (attachment.media_type.startsWith('image/')) {
        files.push({ uri: `data:${attachment.media_type};base64,${data}`, name: attachment.name })
      } else {
        text += `\n\nAttached file ${attachment.name}:\n${Buffer.from(data, 'base64').toString('utf8')}`
      }
    }
    const fingerprint = createHash('sha256').update(JSON.stringify({ text, files, submission })).digest('hex')
    const check = (value) => {
      const payload = value.payload ?? value
      if (payload.metadata?.ade_prompt_hash !== fingerprint || payload.metadata?.ade_submission !== submission) {
        throw new Error('OpenCode message identity already belongs to a different payload')
      }
    }
    // OpenCode acknowledges an existing ID even if a retry changes the text.
    // Check durable ownership before a retry could resume that existing work.
    const inbox = (await this.transport.request('GET', `${this.path(session)}/inbox`)).data
    const existing = inbox.find((item) => item.id === id)
    if (existing) {
      check(existing)
      return existing
    } else {
      try {
        const message = (await this.transport.request('GET', `${this.path(session)}/message/${segment(id)}`)).data
        check(message)
        // Delivered work has already crossed admission. Never schedule it again.
        return { id, sessionID: session, delivered: true }
      } catch (error) {
        if (error.status !== 404) throw error
      }
      if (retry) throw new Error('OpenCode admission is absent; refusing to replay possibly cancelled work')
    }
    // Caller persists id before admission. Never mint another ID or retry here
    // after a lost response; read the inbox/transcript to reconcile that ID.
    const result = await this.transport.request('POST', `${this.path(session)}/prompt`, {
      id,
      text,
      ...(files.length ? { files } : {}),
      metadata: { ade_submission: submission, ade_prompt_hash: fingerprint },
      delivery: 'queue',
      resume,
    })
    if (result.data?.id !== id || result.data?.sessionID !== session)
      throw new Error('OpenCode returned a different prompt identity')
    check(result.data)
    return result.data
  }

  async cancelQueued(session, id) {
    return this.transport.request('DELETE', `${this.path(session)}/inbox/${segment(id)}`)
  }

  async resumeQueued(session, id) {
    const inbox = (await this.transport.request('GET', `${this.path(session)}/inbox`)).data
    const existing = inbox.find((entry) => entry.id === id)
    if (
      existing?.type !== 'user' ||
      !existing.payload.metadata?.ade_submission ||
      !existing.payload.metadata?.ade_prompt_hash
    ) {
      throw new Error('Pending lux-ade admission is no longer available')
    }
    const payload = existing.payload
    return this.transport.request('POST', `${this.path(session)}/prompt`, {
      id,
      text: payload.text,
      metadata: payload.metadata,
      delivery: existing.delivery,
      resume: true,
      ...(payload.files?.length
        ? {
            files: payload.files.map((file) => ({
              uri: `data:${file.mime};base64,${file.data}`,
              ...(file.name ? { name: file.name } : {}),
            })),
          }
        : {}),
    })
  }

  async interrupt(session) {
    // Explicit false prevents cancellation from resuming pending work in either dialect.
    return this.transport.request('POST', `${this.path(session)}/interrupt?${this.dialect.interruptField}=false`)
  }

  async permission(session, id, decision) {
    if (!['accept', 'decline'].includes(decision)) throw new Error('Choose accept or decline')
    return this.transport.request('POST', `${this.path(session)}/permission/${segment(id)}/reply`, {
      [this.dialect.permissionField]: decision === 'accept' ? 'once' : 'reject',
    })
  }

  async form(session, id, answer) {
    const path = `${this.path(session)}/form/${segment(id)}`
    return answer === null
      ? this.transport.request(
          this.dialect.formCancelDelete ? 'DELETE' : 'POST',
          this.dialect.formCancelDelete ? path : `${path}/cancel`,
        )
      : this.transport.request('POST', `${path}/reply`, { answer })
  }
}
