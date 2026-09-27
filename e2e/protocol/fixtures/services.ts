// Managed-service fixtures: a small real HTTP and WebSocket server that a
// scratch profile runs as a service, a foreign listener that takes a port
// from outside ADE, and helpers that talk to both. Nothing here sleeps; waits
// poll the protocol or the fixture's own output.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import type { ProcessLedger } from './processes'
import type { ScratchProfile } from './profile'

/**
 * The service program. Environment, all optional:
 * - `E2E_PORT_VAR` names the port variable to bind (default `PORT`).
 * - `E2E_GATE` is a file to wait for before binding, so a spec can act between launch and bind.
 * - `E2E_ON_BIND_FAIL=fallback` binds an ephemeral port when the assigned one is taken, as Vite
 *   does without `strictPort`. Otherwise the server stays alive without a listener.
 * - `E2E_IGNORE_HUP=1` ignores SIGHUP, so the process outlives its PTY.
 * - `E2E_IGNORE_TERM=1` ignores SIGTERM, so only an escalation to SIGKILL stops it.
 * - `E2E_HOST` is the address to bind (default `127.0.0.1`), such as `::1`.
 * Every HTTP reply is JSON naming the service, its PID, its bound port and every `*_URL` variable.
 * A WebSocket upgrade is accepted and answered with one text frame, `ws:<service>`.
 */
const serverSource = String.raw`import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
const variable = process.env.E2E_PORT_VAR || 'PORT'
const port = Number(process.env[variable])
const name = process.env.ADE_SERVICE_NAME || 'unnamed'
const host = process.env.E2E_HOST || '127.0.0.1'
if (process.env.E2E_IGNORE_HUP === '1') process.on('SIGHUP', () => {})
if (process.env.E2E_IGNORE_TERM === '1') process.on('SIGTERM', () => console.log('ignoring SIGTERM'))
const server = createServer((request, response) => {
  const peers = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.endsWith('_URL')))
  const body = JSON.stringify({ service: name, pid: process.pid, port: server.address().port, path: request.url, peers })
  response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
})
server.on('upgrade', (request, socket) => {
  const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.on('error', () => {})
  socket.on('data', () => {})
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
  const text = Buffer.from('ws:' + name)
  socket.write(Buffer.concat([Buffer.from([0x81, text.length]), text]))
})
function ready() { console.log('listening on ' + server.address().port) }
function listen() {
  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE' && process.env.E2E_ON_BIND_FAIL === 'fallback') {
      console.log('assigned port ' + port + ' taken; falling back')
      server.listen(0, host, ready)
      return
    }
    console.log('bind failed: ' + error.code)
    setInterval(() => {}, 1 << 30)
  })
  server.listen(port, host, ready)
}
const gate = process.env.E2E_GATE
if (gate) {
  console.log('waiting for gate')
  const timer = setInterval(() => { if (existsSync(gate)) { clearInterval(timer); listen() } }, 25)
} else listen()
`

/** A wrapper, like `pnpm dev`, whose child process binds the port. */
const wrapperSource = String.raw`import { spawn } from 'node:child_process'
if (process.env.E2E_IGNORE_HUP === '1') process.on('SIGHUP', () => {})
const child = spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname], { stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 1))
`

export type ServiceFiles = {
  /** Absolute path of the server program. */
  server: string
  /** Absolute path of the wrapper whose child binds. */
  wrapper: string
}

/** Write the service programs into `directory` (normally a workspace root). */
export async function writeServicePrograms(directory: string): Promise<ServiceFiles> {
  const folder = join(directory, 'e2e-service')
  await mkdir(folder, { recursive: true })
  const files = { server: join(folder, 'server.mjs'), wrapper: join(folder, 'wrapper.mjs') }
  await writeFile(files.server, serverSource)
  await writeFile(files.wrapper, wrapperSource)
  return files
}

export type ServiceConfig = {
  program: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  ports?: string[]
  peers?: Record<string, { service: string; port_variable: string }>
  health?: { port_variable: string; path: string; timeout_ms: number; interval_ms: number }
}

/** A service recipe that runs `program` (a fixture file) with this Node. */
export function nodeService(program: string, extra: Omit<ServiceConfig, 'program'> = {}): ServiceConfig {
  return { ports: ['PORT'], ...extra, program: process.execPath, args: [program, ...(extra.args ?? [])] }
}

/** Create a service at revision 0 and return it. */
export async function configureService(profile: ScratchProfile, workspaceId: string, name: string,
  config: ServiceConfig) {
  return (await profile.call('service.configure', { workspace_id: workspaceId, name, revision: 0, config })).service
}

export async function inspectService(profile: ScratchProfile, workspaceId: string, name: string) {
  return profile.call('service.inspect', { workspace_id: workspaceId, name })
}

export async function serviceState(profile: ScratchProfile, workspaceId: string, name: string): Promise<string | undefined> {
  return (await profile.call('service.list', { workspace_id: workspaceId })).states[name]?.state
}

/** Wait until `service.inspect` reports `state` as the service's readiness. */
export async function waitForReadiness(profile: ScratchProfile, workspaceId: string, name: string, state: string,
  timeout = 15_000): Promise<void> {
  await expect.poll(async () => (await inspectService(profile, workspaceId, name)).readiness.state, { timeout }).toBe(state)
}

/** Decode a runtime or durable log tail to text, whatever field carries it. */
export function logText(tail: unknown): string {
  if (tail === null || typeof tail !== 'object') return ''
  const record = tail as Record<string, unknown>
  let text = ''
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'string') continue
    if (key.endsWith('base64')) text += Buffer.from(value, 'base64').toString('utf8')
    else if (key === 'text' || key === 'data' || key === 'output') text += value
  }
  return text
}

/** GET `url` and parse the JSON body. Never throws on an HTTP error status. */
export async function httpGet(url: string): Promise<{ status: number; text: string; json: Record<string, unknown> | null }> {
  const response = await fetch(url, { headers: { connection: 'close' }, signal: AbortSignal.timeout(10_000) })
  const text = await response.text()
  let json: Record<string, unknown> | null = null
  try { json = JSON.parse(text) as Record<string, unknown> } catch { /* Not JSON: a proxy refusal. */ }
  return { status: response.status, text, json }
}

/** Open a WebSocket to `url` and return the first text message. */
export function websocketMessage(url: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolveMessage, rejectMessage) => {
    const socket = new WebSocket(url.replace(/^http/, 'ws'))
    const timer = setTimeout(() => { socket.close(); rejectMessage(new Error(`No WebSocket message from ${url}`)) }, timeoutMs)
    socket.addEventListener('message', (event) => {
      clearTimeout(timer)
      socket.close()
      resolveMessage(String(event.data))
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      rejectMessage(new Error(`WebSocket to ${url} failed`))
    })
  })
}

/**
 * The first service name `${prefix}-N` whose deterministic port for
 * `variable` in `workspaceId` starts at `port`. It mirrors the allocator in
 * crates/ade-daemon/src/services.rs, so a spec can give services in two
 * profiles the same assignment, as happens when two catalogues choose
 * independently. The spec still asserts the port the daemon assigned.
 */
export function serviceNameForPort(workspaceId: string, variable: string, port: number, prefix = 'clash'): string {
  for (let index = 0; index < 5_000_000; index++) {
    const name = `${prefix}-${index}`
    const digest = createHash('sha256').update(`${workspaceId}:${name}:${variable}`).digest()
    if (20_000 + (digest.readUInt16BE(0) % 20_000) === port) return name
  }
  throw new Error(`No service name maps to port ${port}`)
}

/**
 * One raw protocol line and its reply frame as sent, error frames included, so
 * a spec can assert fields such as `code` and `recovery` that the SDK drops.
 */
export function rawReply(socket: string, request: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  return new Promise((resolveReply, rejectReply) => {
    const peer = createConnection(socket)
    let frame = ''
    peer.setTimeout(timeoutMs, () => peer.destroy(new Error('Daemon request timed out')))
    peer.setEncoding('utf8')
    peer.once('connect', () => peer.write(`${JSON.stringify(request)}\n`))
    peer.on('data', (chunk: string) => {
      frame += chunk
      const end = frame.indexOf('\n')
      if (end < 0) return
      peer.destroy()
      try { resolveReply(JSON.parse(frame.slice(0, end)) as Record<string, unknown>) } catch (error) { rejectReply(error) }
    })
    peer.once('error', rejectReply)
    peer.once('close', () => rejectReply(new Error('Connection closed before a reply')))
  })
}

export type ForeignListener ={ pid: number; port: number; close(): Promise<void> }

/**
 * A process outside ADE that listens on 127.0.0.1:`port` (0 for any), owned by
 * the test's ledger. `close` kills it and waits for its exit.
 */
export async function startForeignListener(ledger: ProcessLedger, port = 0): Promise<ForeignListener> {
  const source = `const server = require('node:net').createServer((socket) => { socket.on('error', () => {}); socket.end('foreign\\n') });
server.on('error', (error) => { console.log('error ' + error.code); process.exit(3) });
server.listen(${port}, '127.0.0.1', () => console.log('listening ' + server.address().port));`
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'inherit'] })
  if (typeof child.pid !== 'number') throw new Error('The foreign listener did not start')
  await ledger.own(child.pid, 'foreign listener')
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()))
  const bound = await new Promise<number>((resolveBound, rejectBound) => {
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      const listening = /listening (\d+)/.exec(output)
      if (listening) resolveBound(Number(listening[1]))
      else if (/error/.test(output)) rejectBound(new Error(`The foreign listener could not bind ${port}: ${output.trim()}`))
    })
    child.once('exit', () => rejectBound(new Error(`The foreign listener exited: ${output.trim()}`)))
  })
  return {
    pid: child.pid,
    port: bound,
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    },
  }
}
