import { MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron'
import log from 'electron-log/main'
import { join } from 'node:path'
import type { BridgeControl } from '../shared/stream-bridge'
import { broadcast, handle } from './ipc'

// Main's side of the stream bridge (src/stream-bridge): starts the utility process, tells it which
// profile daemon to stream from, and gives each app window its own MessagePort to it. If the bridge
// exits it is restarted and windows are told to reconnect; repeated crashes stop the restarts.

const RESTART_WINDOW_MS = 30_000
const MAX_RESTARTS = 3

let bridge: UtilityProcess | null = null
let socket: string | null = null
let stopping = false
const restarts: number[] = []
const scoped = log.scope('stream-bridge')

function post(message: BridgeControl, transfer: Electron.MessagePortMain[] = []): void {
  bridge?.postMessage(message, transfer)
}

function spawn(): void {
  bridge = utilityProcess.fork(join(__dirname, 'stream-bridge.js'), [], { serviceName: 'ADE stream bridge' })
  post({ type: 'profile', socket })
  bridge.on('exit', (code) => {
    bridge = null
    if (stopping) return
    const now = Date.now()
    restarts.push(now)
    while (restarts.length && now - restarts[0] > RESTART_WINDOW_MS) restarts.shift()
    if (restarts.length > MAX_RESTARTS) {
      scoped.error(`the stream bridge exited ${restarts.length} times in 30 seconds (code ${code}); not restarting`)
      return
    }
    scoped.warn(`the stream bridge exited (code ${code}); restarting`)
    spawn()
    broadcast('ade:stream-lost')
  })
}

export function startStreamBridge(): void {
  handle('ade:stream-connect', (event) => {
    connectWindow(event.sender)
    return true
  })
  spawn()
}

/** Streams from this profile daemon from now on; `null` stops streaming. */
export function setStreamProfile(next: string | null): void {
  socket = next
  post({ type: 'profile', socket })
}

function connectWindow(contents: WebContents): void {
  if (!bridge) throw new Error('The stream bridge is not running')
  const { port1, port2 } = new MessageChannelMain()
  post({ type: 'window', windowId: contents.id }, [port1])
  contents.postMessage('ade:stream-port', null, [port2])
}

export function disconnectWindow(windowId: number): void {
  post({ type: 'window-closed', windowId })
}

export function stopStreamBridge(): void {
  stopping = true
  bridge?.kill()
  bridge = null
}
