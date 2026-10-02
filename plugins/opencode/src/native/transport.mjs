// OpenCode v2's stdio lease owns an authenticated loopback HTTP server.
// Keep this protocol boundary independent of ADE's session projection.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const MAX_RESPONSE = 16 * 1024 * 1024

export class OpenCodeHttpError extends Error {
  constructor(method, status) {
    super(`OpenCode ${method} request failed (HTTP ${status})`)
    this.status = status
  }
}

async function readBounded(response, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.length
    if (size > limit) throw new Error('OpenCode response exceeds its size limit')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export class OpenCodeTransport {
  #child
  #origin
  #authorization
  #closed = new AbortController()
  #exit
  #stopping
  #requestTimeout
  #info

  static async start({
    command = process.env.ADE_OPENCODE_BIN || 'opencode',
    prefixArgs = [],
    cwd = process.cwd(),
    env = process.env,
    startupTimeout = 30_000,
    requestTimeout = 30_000,
  } = {}) {
    const transport = new OpenCodeTransport()
    const password = randomBytes(32).toString('base64url')
    transport.#authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
    transport.#requestTimeout = requestTimeout
    // Do not detach: ADE's Rpc process group must also own the server if the
    // bridge dies abruptly. Stdin EOF handles normal bridge termination.
    const child = spawn(command, [...prefixArgs, 'serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'], {
      cwd,
      env: { ...env, OPENCODE_PASSWORD: password, OPENCODE_SERVER_PASSWORD: password, OPENCODE_CLIENT: 'ade' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    transport.#child = child
    child.stdin.on('error', () => {})
    // Drain without retaining credentials or unbounded provider diagnostics.
    child.stderr.resume()
    transport.#exit = new Promise((resolve) => {
      child.once('error', () => {
        transport.#closed.abort(new Error('Could not launch OpenCode; check its installation'))
        resolve()
      })
      child.once('exit', () => {
        transport.#closed.abort(new Error('OpenCode server exited'))
        resolve()
      })
    })
    try {
      transport.#origin = await new Promise((resolve, reject) => {
        let pending = ''
        let settled = false
        const finish = (error, origin) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          transport.#closed.signal.removeEventListener('abort', onAbort)
          child.stdout.off('data', onData)
          child.stdout.resume()
          if (error) reject(error)
          else resolve(origin)
        }
        const onAbort = () => finish(transport.#closed.signal.reason)
        const onData = (chunk) => {
          pending += chunk.toString('utf8')
          if (pending.length > 64 * 1024) return finish(new Error('Invalid OpenCode startup announcement'))
          const end = pending.indexOf('\n')
          if (end < 0) return
          try {
            const url = new URL(JSON.parse(pending.slice(0, end)).url)
            if (
              url.protocol !== 'http:' ||
              url.hostname !== '127.0.0.1' ||
              !url.port ||
              url.username ||
              url.password ||
              url.pathname !== '/' ||
              url.search ||
              url.hash
            ) {
              throw new Error('Invalid endpoint')
            }
            finish(null, url.origin)
          } catch {
            finish(new Error('OpenCode did not announce a local v2 endpoint'))
          }
        }
        const timer = setTimeout(() => finish(new Error('OpenCode startup timed out')), startupTimeout)
        child.stdout.on('data', onData)
        transport.#closed.signal.addEventListener('abort', onAbort, { once: true })
        if (transport.#closed.signal.aborted) onAbort()
      })
      const readySignal = AbortSignal.any([transport.#closed.signal, AbortSignal.timeout(startupTimeout)])
      let info
      let healthPath = '/api/info'
      while (true) {
        try {
          info = await transport.request('GET', healthPath, undefined, { signal: readySignal })
          if (info.healthy === false) {
            await delay(100, undefined, { signal: readySignal })
            continue
          }
          break
        } catch (error) {
          // Installed 2.0.3 predates the clone's server.info route. Only a
          // missing route permits this fallback, never an auth/server failure.
          if (error.status === 404 && healthPath === '/api/info') {
            healthPath = '/api/health'
            continue
          }
          if (error.status !== 503) throw error
          await delay(100, undefined, { signal: readySignal })
        }
      }
      if (info.pid !== child.pid || !info.version.startsWith('2.')) {
        throw new Error('OpenCode endpoint identity or v2 version does not match the owned server')
      }
      transport.#info = Object.freeze({ version: info.version, pid: info.pid, healthPath })
      return transport
    } catch (error) {
      await transport.stop()
      throw error
    }
  }

  // The engine and tests call this through the injected transport; fallow cannot follow the untyped call.
  // fallow-ignore-next-line unused-class-member
  get pid() {
    return this.#child.pid
  }
  // The engine and tests call this through the injected transport; fallow cannot follow the untyped call.
  // fallow-ignore-next-line unused-class-member
  get info() {
    return this.#info
  }

  async #fetch(method, path, { body, signal, stream = false } = {}) {
    if ((!path.startsWith('/api/') && !(method === 'GET' && path === '/openapi.json')) || path.includes('\\'))
      throw new Error('Invalid OpenCode API path')
    const url = new URL(path, this.#origin)
    if (url.origin !== this.#origin) throw new Error('Invalid OpenCode API origin')
    const signals = [this.#closed.signal]
    if (signal) signals.push(signal)
    if (!stream) signals.push(AbortSignal.timeout(this.#requestTimeout))
    const response = await fetch(url, {
      method,
      headers: {
        authorization: this.#authorization,
        'content-type': 'application/json',
        accept: stream ? 'text/event-stream' : 'application/json',
      },
      // oxlint-disable-next-line unicorn/no-invalid-fetch-options -- body is undefined for GET; only POST sends one
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any(signals),
      redirect: 'error',
    })
    if (!response.ok) {
      // Do not expose server bodies: tool errors can contain secrets or prompts.
      await response.body?.cancel()
      throw new OpenCodeHttpError(method, response.status)
    }
    return response
  }

  async request(method, path, body, { signal } = {}) {
    const response = await this.#fetch(method, path, { body, signal })
    if (response.status === 204) return null
    return JSON.parse(await readBounded(response, MAX_RESPONSE))
  }

  // One volatile subscription. A caller must resnapshot durable state after
  // every disconnect; this transport intentionally never retries mutations.
  // The engine and tests call this through the injected transport; fallow cannot follow the untyped call.
  // fallow-ignore-next-line unused-class-member
  async *events({ signal } = {}) {
    const response = await this.#fetch('GET', '/api/event', { signal, stream: true })
    if (!response.headers.get('content-type')?.startsWith('text/event-stream')) {
      await response.body?.cancel()
      throw new Error('OpenCode did not return an event stream')
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let pending = ''
    let data = []
    let bytes = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error('OpenCode event stream disconnected; reload session state')
        bytes += chunk.value.byteLength
        if (bytes > MAX_RESPONSE) throw new Error('OpenCode event exceeds its size limit')
        pending += decoder.decode(chunk.value, { stream: true })
        let end
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end).replace(/\r$/, '')
          pending = pending.slice(end + 1)
          if (!line) {
            bytes = Buffer.byteLength(pending)
            if (data.length) {
              const value = JSON.parse(data.join('\n'))
              data = []
              yield value
            }
          } else if (line.startsWith('data:')) {
            data.push(line.slice(5).replace(/^ /, ''))
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }

  stop() {
    if (this.#stopping) return this.#stopping
    this.#stopping = (async () => {
      this.#closed.abort(new Error('OpenCode transport stopped'))
      this.#child.stdin.end()
      const kill = setTimeout(() => this.#child.kill('SIGKILL'), 2_000)
      try {
        await this.#exit
      } finally {
        clearTimeout(kill)
      }
    })()
    return this.#stopping
  }
}
