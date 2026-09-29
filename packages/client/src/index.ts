import { createConnection, type Socket } from 'node:net'
import { call, type CallRequest } from './call.js'
import { helloLine } from './request.js'
import { applyWindowFrame, parseWindows, type Window } from './windows.js'
import {
  decodeFeedFrame as decodeDailyUseFeedFrame,
  decodeRequest as decodeDailyUseRequest,
  decodeResponse as decodeDailyUseResponse,
  decodeTerminalFrame,
  type FeedFrame as DailyUseFeedFrame,
  type Operation as DailyUseOperation,
  type Request as DailyUseRequest,
  type Response as DailyUseResponse,
} from '@ade/contracts'

export {
  openTerminalConnection,
  type TerminalConnection,
  type TerminalConnectionOptions,
  type TerminalFrame,
} from './terminal.js'
export {
  requestDaemon,
  controlOperations,
  controlSocketPath,
  DaemonRequestError,
  categoryErrorCodes,
  daemonRefusalCodes,
  isDaemonRefusal,
  type DaemonErrorCode,
  type DaemonResponse,
  type KnownDaemonErrorCode,
  type RequestDelivery,
  type RequestOptions,
} from './request.js'
export {
  call,
  decodeCallReply,
  encodeCall,
  takesOperationId,
  type CallRequest,
  type OperationIdOperation,
} from './call.js'
export { isOperation, operationIdOperations, operations, type Operation, type Tier } from '@ade/contracts'
export { type ReviewAnchor, type ReviewFeedback } from './review.js'
export {
  applyWindowFrame,
  parseWindow,
  parseWindows,
  type Layout,
  type LayoutAction,
  type LayoutNode,
  type LayoutRecord,
  type PaneNode,
  type SplitNode,
  type Tab,
  type TabTarget,
  type Window,
  type WindowBounds,
  type WindowView,
} from './windows.js'
export {
  workspaceRemoveBlockers,
  worktreeDeleteBlockers,
  type WorkspaceRemoveBlocker,
  type WorkspaceRemoveBlockerKind,
  type WorktreeDeleteBlocker,
} from './workspaces.js'
export {
  decodeDailyUseFeedFrame,
  decodeDailyUseRequest,
  decodeDailyUseResponse,
  decodeTerminalFrame,
  type DailyUseFeedFrame,
  type DailyUseOperation,
  type DailyUseRequest,
  type DailyUseResponse,
}

/**
 * A typed command against the same profile daemon used by Electron and the CLI.
 * An effect command without an `operation_id` is sent under a fresh one.
 */
export async function dailyUseCommand<O extends DailyUseOperation>(
  endpoint: string,
  request: DailyUseCommand<O>,
): Promise<DailyUseResponse<O>> {
  const { op, ...fields } = request as unknown as { op: O } & Record<string, unknown>
  return call(endpoint, op, fields as unknown as CallRequest<O>)
}

/** A command as `dailyUseCommand` takes it: the request with its `op`. */
export type DailyUseCommand<O extends DailyUseOperation> = { op: O } & CallRequest<O>

const APPLICATION_PROTOCOL = 'ade-application-v1'
const SESSION_PROTOCOL = 'ade-sessions-v1'
const MAX_FRAME_BYTES = 32 * 1024 * 1024
const HANDSHAKE_TIMEOUT_MS = 5_000

export interface Workspace {
  id: string
  root: string
  /** The name ADE shows; `workspace.rename` changes it, never the folder. */
  name: string
  needs_rebind: boolean
  worktree_lifecycle_needs_rebind: boolean
  /**
   * The project the workspace belongs to; never empty. The SDK's catalog
   * parser always sets it and the fields below; they are optional only so
   * hand-built fixtures stay valid.
   */
  project_id?: string
  kind?: WorkspaceKind
  /** The branch `HEAD` names; null when detached or not a Git checkout. */
  branch?: string | null
  /** The daemon's own workspace, which cannot be removed. */
  default?: boolean
  /** ADE made or adopted this linked worktree and may delete it. */
  ade_owned?: boolean
}

export type WorkspaceKind = 'primary_checkout' | 'linked_worktree' | 'folder'
export type ProjectKind = 'repository' | 'folder'

/** A project in the catalog: a Git repository or a plain folder. */
export interface CatalogProject {
  id: string
  kind: ProjectKind
  /** A repository's checkout folder name, or the folder's own name. */
  name: string
  /** A repository's Git common directory, or the folder. */
  root: string
}

export interface Conversation {
  id: string
  workspace_id: string
  title: string
  provider: string
  status: string
  account_id?: string | null
  account_context?: 'managed' | 'ambient'
  /**
   * Whether the Conversation needs the person, as the daemon derives it from
   * its status and open requests. Set when the daemon sends it.
   */
  attention?: Attention
  /** It has a reply or notice newer than the profile last marked seen (`conversation.mark_seen`). */
  unread?: boolean
  /** The Conversation that delegated this one, for an orchestration child. */
  parent_conversation_id?: string | null
  /** The orchestration group this child runs in. */
  group_id?: string | null
}

/** What a terminal runs, and whether its process runs; see `TerminalRecord` in `@ade/contracts`. */
export type TerminalKind = 'shell' | 'service' | 'script'
export type TerminalStatus = 'not_started' | 'running' | 'exited' | 'stopped'

/**
 * A terminal record, owned by its workspace. `busy` means a command holds the
 * terminal's foreground, named by `foreground`; closing it asks first.
 */
export interface Terminal {
  id: string
  workspace_id: string
  kind: TerminalKind
  title: string
  status: TerminalStatus
  exit_code: number | null
  busy: boolean
  foreground: string | null
  primary: boolean
  service_id: string | null
  script_run_id: string | null
}

export type Attention = 'idle' | 'running' | 'needs_you' | 'error'

export interface Catalog {
  /** Every project of the listed workspaces. */
  projects: CatalogProject[]
  workspaces: Workspace[]
  conversations: Conversation[]
  /** The workspaces' terminals, in creation order. */
  terminals: Terminal[]
  /** Every window, open and closed, with the revision of each of its layouts. */
  windows: Window[]
}

export type ConnectionStatus =
  | 'unconfigured'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'unavailable'
  | 'incompatible'

export interface ClientState {
  sequence: number
  status: ConnectionStatus
  detail: string
  bootId: string | null
  revision: number | null
  catalog: Catalog | null
}

type Listener = (state: ClientState) => void
/** A `session.subscribe` frame, checked against its contract as it arrives. */
export type FeedFrame = DailyUseFeedFrame
type FeedListener = (frame: FeedFrame) => void

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function stringFields(value: unknown, keys: string[]): string[] | null {
  const source = record(value)
  if (!source) return null
  const values = keys.map((key) => requiredString(source[key]))
  return values.includes(null) ? null : (values as string[])
}

function parseWorkspace(value: unknown): Workspace | null {
  const fields = stringFields(value, ['id', 'root', 'name', 'project_id'])
  const source = record(value)
  if (!fields || !source) return null
  for (const flag of ['needs_rebind', 'worktree_lifecycle_needs_rebind', 'default', 'ade_owned'] as const)
    if (typeof source[flag] !== 'boolean') return null
  if (!workspaceKinds.has(source.kind as string)) return null
  const branch = source.branch
  if (branch !== null && typeof branch !== 'string') return null
  return {
    id: fields[0],
    root: fields[1],
    name: fields[2],
    needs_rebind: source.needs_rebind as boolean,
    worktree_lifecycle_needs_rebind: source.worktree_lifecycle_needs_rebind as boolean,
    project_id: fields[3],
    kind: source.kind as WorkspaceKind,
    branch,
    default: source.default as boolean,
    ade_owned: source.ade_owned as boolean,
  }
}

const workspaceKinds: ReadonlySet<string> = new Set<WorkspaceKind>(['primary_checkout', 'linked_worktree', 'folder'])
const attentions: ReadonlySet<string> = new Set<Attention>(['idle', 'running', 'needs_you', 'error'])
const terminalKinds: ReadonlySet<string> = new Set<TerminalKind>(['shell', 'service', 'script'])
const terminalStatuses: ReadonlySet<string> = new Set<TerminalStatus>(['not_started', 'running', 'exited', 'stopped'])

function parseConversation(value: unknown): Conversation | null {
  const fields = stringFields(value, ['id', 'workspace_id', 'provider', 'status'])
  const source = record(value)
  const title = source?.title
  if (!fields || typeof title !== 'string') return null
  const accountId = link(source?.account_id)
  const accountContext = source?.account_context
  if (accountContext !== 'managed' && accountContext !== 'ambient') return null
  const attention = source?.attention
  const unread = source?.unread
  const parent = link(source?.parent_conversation_id)
  const group = link(source?.group_id)
  if (!attentions.has(attention as string) || typeof unread !== 'boolean') return null
  if (accountId === false || parent === false || group === false) return null
  return {
    id: fields[0],
    workspace_id: fields[1],
    title,
    provider: fields[2],
    status: fields[3],
    account_id: accountId,
    account_context: accountContext,
    attention: attention as Attention,
    unread,
    parent_conversation_id: parent,
    group_id: group,
  }
}

function parseTerminal(value: unknown): Terminal | null {
  const fields = stringFields(value, ['id', 'workspace_id'])
  const source = record(value)
  if (!fields || !source) return null
  const { kind, title, status } = source
  if (!terminalKinds.has(kind as string) || !terminalStatuses.has(status as string) || typeof title !== 'string')
    return null
  const exitCode = source.exit_code
  if (exitCode !== null && !Number.isInteger(exitCode)) return null
  if (typeof source.busy !== 'boolean' || typeof source.primary !== 'boolean') return null
  const links = [source.foreground, source.service_id, source.script_run_id].map(link)
  if (links.includes(false)) return null
  const [foreground, serviceId, scriptRunId] = links as (string | null)[]
  return {
    id: fields[0],
    workspace_id: fields[1],
    kind: kind as TerminalKind,
    title,
    status: status as TerminalStatus,
    exit_code: exitCode as number | null,
    busy: source.busy,
    foreground,
    primary: source.primary,
    service_id: serviceId,
    script_run_id: scriptRunId,
  }
}

/** A string or null; `false` when it is anything else, or absent. */
function link(value: unknown): string | null | false {
  return value === null || typeof value === 'string' ? value : false
}

function parseProject(value: unknown): CatalogProject | null {
  const fields = stringFields(value, ['id', 'kind', 'name', 'root'])
  if (!fields || (fields[1] !== 'repository' && fields[1] !== 'folder')) return null
  return { id: fields[0], kind: fields[1], name: fields[2], root: fields[3] }
}

/** A catalog as the daemon sends it, or null when it is malformed. */
export function parseCatalog(value: unknown): Catalog | null {
  const source = record(value)
  if (!source) return null
  const { projects, workspaces, conversations, terminals } = source
  if (![projects, workspaces, conversations, terminals].every(Array.isArray)) return null
  const lists = {
    projects: (projects as unknown[]).map(parseProject),
    workspaces: (workspaces as unknown[]).map(parseWorkspace),
    conversations: (conversations as unknown[]).map(parseConversation),
    terminals: (terminals as unknown[]).map(parseTerminal),
  }
  const windows = parseWindows(source.windows)
  if (!windows || Object.values(lists).some((list) => list.includes(null))) return null
  return {
    projects: lists.projects as CatalogProject[],
    workspaces: lists.workspaces as Workspace[],
    conversations: lists.conversations as Conversation[],
    terminals: lists.terminals as Terminal[],
    windows,
  }
}

function parseFrame(line: Buffer): Record<string, unknown> | null {
  try {
    return record(JSON.parse(line.toString('utf8')))
  } catch {
    return null
  }
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
  private readonly feedListeners = new Set<FeedListener>()
  private socket: Socket | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private generation = 0
  private running = false
  private retryCount = 0

  /**
   * `pairing` is presented in the hello, for a remote host's paired endpoint
   * reached through a forward. A host that refuses the pairing ends the feed:
   * it is not retried.
   */
  constructor(
    private readonly endpoint: string | undefined,
    private readonly options: { pairing?: { pairingId: string; token: string } | null } = {},
  ) {}

  getState(): ClientState {
    return this.state
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => {
      this.listeners.delete(listener)
    }
  }

  subscribeFeed(listener: FeedListener): () => void {
    this.feedListeners.add(listener)
    return () => {
      this.feedListeners.delete(listener)
    }
  }

  /** Catalog, conversation and terminal changes only. Reconnect starts with a new catalog snapshot. */
  subscribeDailyUseFeed(listener: (frame: DailyUseFeedFrame) => void): () => void {
    return this.subscribeFeed((frame) => {
      if (frame.type === 'catalog' || frame.type === 'conversation_changed' || frame.type === 'terminal_changed')
        listener(frame)
    })
  }

  /** Call any operation on this client's profile daemon; the reply is validated against its contract. */
  call<O extends DailyUseOperation>(op: O, request: CallRequest<O>): Promise<DailyUseResponse<O>> {
    if (!this.endpoint) return Promise.reject(new Error('Profile daemon endpoint is unavailable'))
    return call(this.endpoint, op, request)
  }

  command<O extends DailyUseOperation>(request: DailyUseCommand<O>): Promise<DailyUseResponse<O>> {
    if (!this.endpoint) return Promise.reject(new Error('Profile daemon endpoint is unavailable'))
    return dailyUseCommand(this.endpoint, request)
  }

  getCatalog(): Promise<DailyUseResponse<'catalog.get'>> {
    return this.command<'catalog.get'>({ op: 'catalog.get' })
  }

  /** Change the name ADE shows for a workspace; its folder and branch are unchanged. */
  renameWorkspace(workspaceId: string, name: string): Promise<DailyUseResponse<'workspace.rename'>> {
    return this.call('workspace.rename', { workspace_id: workspaceId, name })
  }

  /**
   * Remove a workspace from ADE without touching its files. Pass the same
   * `operationId` to retry a lost reply. A refusal is a `DaemonRequestError`
   * with code `workspace_remove_blocked`; `workspaceRemoveBlockers` reads what blocks it.
   */
  removeWorkspace(workspaceId: string, operationId?: string): Promise<DailyUseResponse<'workspace.remove'>> {
    return this.call('workspace.remove', {
      workspace_id: workspaceId,
      ...(operationId !== undefined ? { operation_id: operationId } : {}),
    })
  }

  getConversation(
    conversationId: string,
    before?: number,
    limit?: number,
  ): Promise<DailyUseResponse<'conversation.get'>> {
    return this.command<'conversation.get'>({
      op: 'conversation.get',
      conversation_id: conversationId,
      ...(before !== undefined ? { before } : {}),
      ...(limit !== undefined ? { limit } : {}),
    })
  }

  sendPrompt(conversationId: string, requestId: string, text: string): Promise<DailyUseResponse<'agent.send'>> {
    return this.command<'agent.send'>({
      op: 'agent.send',
      conversation_id: conversationId,
      request_id: requestId,
      text,
    })
  }

  answerRequest(
    conversationId: string,
    requestId: string,
    decision: string,
    answers?: unknown,
  ): Promise<DailyUseResponse<'agent.answer'>> {
    return this.command<'agent.answer'>({
      op: 'agent.answer',
      conversation_id: conversationId,
      request_id: requestId,
      decision,
      ...(answers !== undefined ? { answers } : {}),
    })
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
    this.publish({
      status: this.state.catalog ? 'reconnecting' : 'connecting',
      detail: 'Connecting to profile daemon…',
    })
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
    socket.on('connect', () => socket.write(helloLine(this.options.pairing)))
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
        if (frame.type === 'error') {
          if (phase === 'hello' && (frame.code === 'pairing_revoked' || frame.code === 'unauthenticated')) {
            // The host refused this pairing. Retrying cannot help: a person pairs again.
            this.running = false
            this.publish({
              status: 'unavailable',
              detail: requiredString(frame.message) ?? 'The host refused this pairing.',
            })
            socket.destroy()
            return
          }
          return fail(requiredString(frame.message) ?? 'Daemon returned an error.')
        }
        // After the handshake every frame is a feed frame; each is checked against its contract.
        let feedFrame: FeedFrame | null = null
        if (phase !== 'hello') {
          try {
            feedFrame = decodeDailyUseFeedFrame(frame)
          } catch (error) {
            this.publish({ status: 'incompatible', detail: `Daemon feed frame failed its contract: ${String(error)}` })
            this.stop()
            return
          }
        }
        const result = this.applyFrame(frame, phase, socket)
        if (result === 'invalid') return fail('Daemon sent an invalid or discontinuous state frame.')
        phase = result
        if (feedFrame) for (const listener of this.feedListeners) listener(feedFrame)
      }
    })
    socket.on('error', (error: NodeJS.ErrnoException) => {
      terminalError =
        error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
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
      this.publish({
        status: 'incompatible',
        detail:
          'This daemon uses an incompatible application or session protocol. Keep its current owner running and select a compatible ADE build.',
      })
      this.running = false
      socket.destroy()
      return 'invalid'
    }
    try {
      decodeDailyUseResponse('hello', frame)
    } catch {
      return 'invalid'
    }
    socket.write('{"op":"session.subscribe"}\n')
    return 'catalog'
  }

  private applyInitialCatalog(
    frame: Record<string, unknown>,
    socket: Socket,
    bootId: string,
    revision: number,
  ): 'stream' | 'invalid' {
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
    if (frame.type === 'terminal_changed') {
      const terminal = parseTerminal(frame.terminal)
      const catalog = this.state.catalog
      if (!terminal || !catalog) return 'invalid'
      // A terminal the catalog does not list was removed; its catalog frame came first.
      const terminals = catalog.terminals.map((item) => (item.id === terminal.id ? terminal : item))
      this.publish({ revision, catalog: { ...catalog, terminals } })
      return 'stream'
    }
    const catalog = this.state.catalog
    const windows = catalog ? applyWindowFrame(catalog.windows, frame) : undefined
    if (windows === null) return 'invalid'
    if (catalog && windows) {
      this.publish({ revision, catalog: { ...catalog, windows } })
      return 'stream'
    }
    // Other event families do not change this read-only summary projection.
    this.publish({ revision })
    return 'stream'
  }
}
