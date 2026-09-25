import { createConnection, type Socket } from 'node:net'

export { openTerminalConnection, type TerminalConnection, type TerminalFrame } from './terminal.js'

const APPLICATION_PROTOCOL = 'ade-application-v1'
const SESSION_PROTOCOL = 'ade-sessions-v1'
const MAX_FRAME_BYTES = 32 * 1024 * 1024
const HANDSHAKE_TIMEOUT_MS = 5_000

export interface Workspace {
  id: string
  root: string
  name: string
  terminal_id: string
}

export interface Conversation {
  id: string
  workspace_id: string
  title: string
  provider: string
  status: string
}

export interface Catalog {
  workspaces: Workspace[]
  conversations: Conversation[]
}

export type ConnectionStatus = 'unconfigured' | 'connecting' | 'connected' | 'reconnecting' | 'unavailable' | 'incompatible'

export interface ClientState {
  sequence: number
  status: ConnectionStatus
  detail: string
  bootId: string | null
  revision: number | null
  catalog: Catalog | null
}

type Listener = (state: ClientState) => void

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function stringFields(value: unknown, keys: string[]): string[] | null {
  const source = record(value)
  if (!source) return null
  const values = keys.map((key) => requiredString(source[key]))
  return values.includes(null) ? null : values as string[]
}

function parseWorkspace(value: unknown): Workspace | null {
  const fields = stringFields(value, ['id', 'root', 'name', 'terminal_id'])
  return fields ? { id: fields[0], root: fields[1], name: fields[2], terminal_id: fields[3] } : null
}

function parseConversation(value: unknown): Conversation | null {
  const fields = stringFields(value, ['id', 'workspace_id', 'provider', 'status'])
  const title = record(value)?.title
  if (!fields || typeof title !== 'string') return null
  return { id: fields[0], workspace_id: fields[1], title, provider: fields[2], status: fields[3] }
}

function parseCatalog(value: unknown): Catalog | null {
  const source = record(value)
  if (!source || !Array.isArray(source.workspaces) || !Array.isArray(source.conversations)) return null
  const workspaces = source.workspaces.map(parseWorkspace)
  const conversations = source.conversations.map(parseConversation)
  if (workspaces.includes(null) || conversations.includes(null)) return null
  return { workspaces: workspaces as Workspace[], conversations: conversations as Conversation[] }
}

function parseFrame(line: Buffer): Record<string, unknown> | null {
  try { return record(JSON.parse(line.toString('utf8'))) }
  catch { return null }
}

function eventPosition(frame: Record<string, unknown>): { bootId: string; revision: number } | null {
  const bootId = requiredString(frame.boot_id)
  const revision = frame.revision
  if (!bootId || typeof revision !== 'number') return null
  if (!Number.isSafeInteger(revision) || revision < 0) return null
  return { bootId, revision }
}

/** Read-only adapter for the prototype daemon's versioned Unix JSON-lines feed. */
export class AdeClient {
  private state: ClientState = {
    sequence: 0,
    status: 'unconfigured',
    detail: 'Choose an explicit ADE profile socket with ADE_SOCKET.',
    bootId: null,
    revision: null,
    catalog: null,
  }
  private readonly listeners = new Set<Listener>()
  private socket: Socket | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private generation = 0
  private running = false
  private retryCount = 0

  constructor(private readonly endpoint: string | undefined) {}

  getState(): ClientState {
    return this.state
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => { this.listeners.delete(listener) }
  }

  start(): void {
    if (this.running) return
    this.running = true
    if (!this.endpoint) return
    this.connect()
  }

  stop(): void {
    this.running = false
    this.generation++
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.socket?.destroy()
    this.socket = null
  }

  private publish(update: Partial<ClientState>): void {
    this.state = { ...this.state, ...update, sequence: this.state.sequence + 1 }
    for (const listener of this.listeners) listener(this.state)
  }

  private reconnect(detail: string): void {
    if (!this.running || this.retryTimer) return
    this.publish({ status: this.state.catalog ? 'reconnecting' : 'unavailable', detail })
    const delay = Math.min(5_000, 250 * 2 ** Math.min(this.retryCount++, 5))
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.running) this.connect()
    }, delay)
  }

  private connect(): void {
    if (!this.endpoint || !this.running) return
    const generation = ++this.generation
    this.publish({ status: this.state.catalog ? 'reconnecting' : 'connecting', detail: 'Connecting to profile daemon…' })
    const socket = createConnection({ path: this.endpoint })
    this.socket = socket
    let phase: 'hello' | 'catalog' | 'stream' = 'hello'
    let buffer = Buffer.alloc(0)
    let terminalError: string | null = null
    const fail = (message: string): void => {
      terminalError = message
      socket.destroy()
    }
    socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => fail('Daemon handshake timed out.'))
    socket.on('connect', () => socket.write('{"op":"hello"}\n'))
    socket.on('data', (chunk: Buffer) => {
      if (generation !== this.generation) return
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > MAX_FRAME_BYTES) return fail('Daemon frame exceeded the 32 MiB limit.')
      for (;;) {
        const end = buffer.indexOf(10)
        if (end < 0) break
        const line = buffer.subarray(0, end)
        buffer = buffer.subarray(end + 1)
        const frame = parseFrame(line)
        if (!frame) return fail('Daemon sent an invalid JSON frame.')
        if (frame.type === 'error') return fail(requiredString(frame.message) ?? 'Daemon returned an error.')
        const result = this.applyFrame(frame, phase, socket)
        if (result === 'invalid') return fail('Daemon sent an invalid or discontinuous state frame.')
        phase = result
      }
    })
    socket.on('error', (error: NodeJS.ErrnoException) => {
      terminalError = error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
        ? 'Profile daemon is unavailable at the selected socket.'
        : `Profile daemon connection failed: ${error.message}`
    })
    socket.on('close', () => {
      if (generation !== this.generation) return
      this.socket = null
      if (this.running) this.reconnect(terminalError ?? 'Profile daemon disconnected; reconnecting.')
    })
  }

  private applyFrame(
    frame: Record<string, unknown>,
    phase: 'hello' | 'catalog' | 'stream',
    socket: Socket,
  ): 'hello' | 'catalog' | 'stream' | 'invalid' {
    if (phase === 'hello') return this.applyHello(frame, socket)
    const position = eventPosition(frame)
    if (!position) return 'invalid'
    if (phase === 'catalog') return this.applyInitialCatalog(frame, socket, position.bootId, position.revision)
    if (position.bootId !== this.state.bootId || position.revision !== (this.state.revision ?? -1) + 1) return 'invalid'
    return this.applyChange(frame, position.revision)
  }

  private applyHello(frame: Record<string, unknown>, socket: Socket): 'catalog' | 'invalid' {
    if (frame.type !== 'hello') return 'invalid'
    if (frame.application_protocol !== APPLICATION_PROTOCOL || frame.session_protocol !== SESSION_PROTOCOL) {
      this.publish({ status: 'incompatible', detail: 'This daemon uses an incompatible application or session protocol. Keep its current owner running and select a compatible ADE build.' })
      this.running = false
      socket.destroy()
      return 'invalid'
    }
    socket.write('{"op":"session.subscribe"}\n')
    return 'catalog'
  }

  private applyInitialCatalog(frame: Record<string, unknown>, socket: Socket, bootId: string, revision: number): 'stream' | 'invalid' {
    if (frame.type !== 'catalog') return 'invalid'
    const catalog = parseCatalog(frame.catalog)
    if (!catalog) return 'invalid'
    socket.setTimeout(0)
    this.retryCount = 0
    this.publish({ status: 'connected', detail: '', bootId, revision, catalog })
    return 'stream'
  }

  private applyChange(frame: Record<string, unknown>, revision: number): 'stream' | 'invalid' {
    if (frame.type === 'catalog') {
      const catalog = parseCatalog(frame.catalog)
      if (!catalog) return 'invalid'
      this.publish({ revision, catalog })
      return 'stream'
    }
    if (frame.type === 'conversation_changed') {
      const conversation = parseConversation(frame.conversation)
      const catalog = this.state.catalog
      if (!conversation || !catalog) return 'invalid'
      const conversations = catalog.conversations.filter((item) => item.id !== conversation.id)
      conversations.push(conversation)
      this.publish({ revision, catalog: { ...catalog, conversations } })
      return 'stream'
    }
    // Other event families do not change this read-only summary projection.
    this.publish({ revision })
    return 'stream'
  }
}
