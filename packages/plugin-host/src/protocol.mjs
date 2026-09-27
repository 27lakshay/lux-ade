// @ts-check
// The backend plugin host's message handling (F057, decision D05).
//
// One host process serves one activation generation of one plugin. The daemon
// speaks JSON-RPC 2.0 to it, one JSON object per line on stdio. The methods are
// `activate`, `deactivate`, `invoke` and `health`. The host sends nothing
// unprompted: plugin output goes to stderr, which the daemon keeps as a bounded
// log tail.
//
// Error codes tell the daemon whether plugin code ran. Every code below
// COMMAND_FAILED means the request was refused before any plugin command code
// started, so the daemon may report it as not applied. COMMAND_FAILED means the
// command handler ran and threw.
//
// Pattern studied from Orca `src/main/plugins/plugin-host-entry.ts` and
// `plugin-host-runtime.ts` (MIT); no code copied.
import { isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PARSE_ERROR = -32700
export const INVALID_REQUEST = -32600
export const METHOD_NOT_FOUND = -32601
export const INVALID_PARAMS = -32602
/** The host is not active: never activated, or already deactivated. */
export const NOT_ACTIVE = -32001
/** The request names a generation this host does not serve. */
export const STALE_GENERATION = -32002
/** No handler is registered for the command. */
export const UNKNOWN_COMMAND = -32003
/** Loading the backend entry or running its `activate` failed. */
export const ACTIVATION_FAILED = -32004
/** The command handler ran and threw. */
export const COMMAND_FAILED = -32010

/** The largest request line the host accepts, in bytes. */
const MAX_LINE_BYTES = 1024 * 1024

class RpcError extends Error {
  /** @param {number} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** @param {unknown} error */
function describe(error) {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {Record<string, unknown>} params @param {string} name */
function text(params, name) {
  const value = params[name]
  if (typeof value !== 'string' || value.length === 0) throw new RpcError(INVALID_PARAMS, `Missing ${name}`)
  return value
}

/** @param {Record<string, unknown>} params */
function generationOf(params) {
  const value = params.generation
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new RpcError(INVALID_PARAMS, 'generation must be a positive integer')
  }
  return value
}

/**
 * Resolves the backend entry inside the artifact, refusing any path that
 * leaves it.
 * @param {string} artifact @param {string} entry
 */
export function entryPath(artifact, entry) {
  if (!isAbsolute(artifact)) throw new RpcError(INVALID_PARAMS, 'artifact_path must be absolute')
  if (isAbsolute(entry)) throw new RpcError(INVALID_PARAMS, 'entry must be relative to the artifact')
  const root = resolve(artifact)
  const target = resolve(root, entry)
  const inside = relative(root, target)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new RpcError(INVALID_PARAMS, 'entry must stay inside the artifact')
  }
  return target
}

/**
 * JSON-safe copy of a command's return value. `undefined` becomes null.
 * @param {unknown} value
 */
function jsonValue(value) {
  if (value === undefined) return null
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('Command returned a value that is not JSON')
  return JSON.parse(encoded)
}

/**
 * @typedef {{ activate?: (context: object) => unknown, deactivate?: () => unknown }} BackendModule
 * @typedef {{ jsonrpc: '2.0', id: number | string | null, result?: unknown,
 *   error?: { code: number, message: string } }} Response
 * @typedef {{ load?: (url: string) => Promise<BackendModule>, now?: () => number,
 *   log?: (line: string) => void }} HostOptions
 */

/**
 * Creates the host state machine: idle, then active, then deactivated. It
 * never returns to idle; a new generation gets a new host process.
 * @param {HostOptions} [options]
 */
export function createHost(options = {}) {
  const load = options.load ?? ((url) => import(url))
  const now = options.now ?? Date.now
  const log = options.log ?? ((line) => process.stderr.write(`${line}\n`))
  const started = now()
  /** @type {'idle' | 'activating' | 'active' | 'deactivated'} */
  let state = 'idle'
  /** @type {number | undefined} */
  let generation
  /** @type {string | undefined} */
  let pluginId
  /** @type {Set<string>} */
  let declared = new Set()
  /** @type {Map<string, (args: unknown, meta: object) => unknown>} */
  const handlers = new Map()
  /** @type {BackendModule | undefined} */
  let backend
  let pending = 0
  let hookRan = false

  /** @param {Record<string, unknown>} params */
  function fence(params) {
    const requested = generationOf(params)
    if (generation !== undefined && requested !== generation) {
      throw new RpcError(STALE_GENERATION, `Host serves generation ${generation}, not ${requested}`)
    }
    return requested
  }

  /** @param {Record<string, unknown>} params */
  async function activate(params) {
    const requested = generationOf(params)
    if (state !== 'idle') throw new RpcError(NOT_ACTIVE, `Host is ${state}; a host activates once`)
    const id = text(params, 'plugin_id')
    const path = entryPath(text(params, 'artifact_path'), text(params, 'entry'))
    const commands = params.commands ?? []
    if (!Array.isArray(commands) || !commands.every((item) => typeof item === 'string')) {
      throw new RpcError(INVALID_PARAMS, 'commands must be a list of command IDs')
    }
    const settings = params.settings ?? {}
    if (!isObject(settings)) throw new RpcError(INVALID_PARAMS, 'settings must be an object')
    state = 'activating'
    generation = requested
    pluginId = id
    declared = new Set(/** @type {string[]} */ (commands))
    const context = Object.freeze({
      pluginId: id,
      generation: requested,
      settings: Object.freeze({ ...settings }),
      commands: Object.freeze({ register }),
      /** @param {...unknown} parts */
      log: (...parts) => log(parts.map((part) => typeof part === 'string' ? part : describe(part)).join(' ')),
    })
    try {
      backend = await load(pathToFileURL(path).href)
      if (!backend || typeof backend.activate !== 'function') {
        throw new Error('Backend entry exports no activate function')
      }
      await backend.activate(context)
    } catch (error) {
      state = 'deactivated'
      handlers.clear()
      throw new RpcError(ACTIVATION_FAILED, `Plugin ${id} backend failed to activate: ${describe(error)}`)
    }
    // A deactivate that arrived while `activate` ran wins; stay deactivated
    // and give the plugin its cleanup hook now that its module is loaded.
    if (/** @type {string} */ (state) !== 'activating') {
      await runDeactivateHook()
      throw new RpcError(NOT_ACTIVE, `Plugin ${id} was deactivated during activation`)
    }
    state = 'active'
    return { generation: requested, registered: [...handlers.keys()].sort() }
  }

  /**
   * The registration API a plugin receives. A handle only removes the handler
   * it registered, and registering after deactivation is refused.
   * @param {string} id @param {(args: unknown, meta: object) => unknown} handler
   */
  function register(id, handler) {
    if (state !== 'activating' && state !== 'active') throw new Error(`Plugin ${pluginId} is ${state}; it cannot register commands`)
    if (typeof handler !== 'function') throw new Error(`Command ${id} needs a handler function`)
    if (!declared.has(id)) throw new Error(`Command ${id} is not declared in the plugin manifest`)
    if (handlers.has(id)) throw new Error(`Command ${id} is already registered`)
    handlers.set(id, handler)
    return Object.freeze({
      dispose() {
        if (handlers.get(id) === handler) handlers.delete(id)
      },
    })
  }

  /** @param {Record<string, unknown>} params */
  async function invoke(params) {
    const requested = fence(params)
    if (state !== 'active') throw new RpcError(NOT_ACTIVE, `Host is ${state}`)
    const command = text(params, 'command_id')
    const handler = handlers.get(command)
    if (!handler) throw new RpcError(UNKNOWN_COMMAND, `Command ${command} is not registered`)
    const invocationId = typeof params.invocation_id === 'string' ? params.invocation_id : undefined
    pending++
    try {
      const value = await handler(params.args ?? null, Object.freeze({ generation: requested, invocationId }))
      return { value: jsonValue(value) }
    } catch (error) {
      throw new RpcError(COMMAND_FAILED, describe(error))
    } finally {
      pending--
    }
  }

  /** @param {Record<string, unknown>} params */
  async function deactivate(params) {
    fence(params)
    if (state === 'deactivated' || state === 'idle') {
      state = 'deactivated'
      return { deactivated: false }
    }
    state = 'deactivated'
    handlers.clear()
    await runDeactivateHook()
    return { deactivated: true }
  }

  /** Runs the plugin's `deactivate` export at most once, once its module has loaded. */
  async function runDeactivateHook() {
    if (!backend || hookRan) return
    hookRan = true
    try {
      await backend.deactivate?.()
    } catch (error) {
      log(`Plugin ${pluginId} deactivate failed: ${describe(error)}`)
    }
  }

  function health() {
    return {
      state,
      generation: generation ?? null,
      registered: [...handlers.keys()].sort(),
      pending,
      uptime_ms: Math.max(0, now() - started),
    }
  }

  /** @type {Record<string, (params: Record<string, unknown>) => unknown>} */
  const methods = { activate, deactivate, invoke, health }

  /**
   * Handles one request object. Returns the response, or null for a
   * notification (a request without an ID).
   * @param {unknown} message
   * @returns {Promise<Response | null>}
   */
  async function handle(message) {
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      const id = isObject(message) && (typeof message.id === 'number' || typeof message.id === 'string') ? message.id : null
      return { jsonrpc: '2.0', id, error: { code: INVALID_REQUEST, message: 'Invalid JSON-RPC request' } }
    }
    const id = typeof message.id === 'number' || typeof message.id === 'string' ? message.id : null
    const notification = !('id' in message)
    const method = Object.hasOwn(methods, message.method) ? methods[message.method] : undefined
    /** @type {Response} */
    let response
    try {
      if (!method) throw new RpcError(METHOD_NOT_FOUND, `Unknown method ${message.method}`)
      const params = message.params ?? {}
      if (!isObject(params)) throw new RpcError(INVALID_PARAMS, 'params must be an object')
      response = { jsonrpc: '2.0', id, result: await method(params) }
    } catch (error) {
      const code = error instanceof RpcError ? error.code : COMMAND_FAILED
      response = { jsonrpc: '2.0', id, error: { code, message: describe(error) } }
    }
    return notification ? null : response
  }

  /**
   * Handles one line from stdin.
   * @param {string} line
   * @returns {Promise<Response | null>}
   */
  async function handleLine(line) {
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      return { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Request line is too long' } }
    }
    let message
    try { message = JSON.parse(line) }
    catch { return { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Request is not valid JSON' } } }
    return handle(message)
  }

  return { handle, handleLine, health }
}
