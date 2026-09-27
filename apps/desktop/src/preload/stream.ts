import type { FeedFrame } from '@ade/client'
import type { TerminalBridge, TerminalFrame } from '@ade/terminal'
import type { BridgeToWindow, WindowToBridge } from '../shared/stream-bridge'
import { invoke, receivePorts, subscribe } from './ipc'

// This window's end of the stream bridge (src/stream-bridge). The conversation feed and terminal
// streams arrive here over a MessagePort, in batches, and are handed to the renderer's listeners one
// frame at a time. The port stays in the preload; the renderer only sees the bridge API.

let port: MessagePort | null = null
const waiting: WindowToBridge[] = []
const feedListeners = new Set<(frame: FeedFrame) => void>()
const terminals = new Map<string, { onFrame: (frame: TerminalFrame) => void; onClose: (reason: string) => void }>()
const attaching = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()

function post(message: WindowToBridge): void {
  if (port) port.postMessage(message)
  else waiting.push(message)
}

function receive(message: BridgeToWindow): void {
  if (message.type === 'feed') {
    for (const frame of message.frames) for (const listener of feedListeners) listener(frame)
  } else if (message.type === 'terminal-frames') {
    const terminal = terminals.get(message.connectionId)
    for (const frame of message.frames) terminal?.onFrame(frame)
  } else if (message.type === 'terminal-close') {
    const terminal = terminals.get(message.connectionId)
    terminals.delete(message.connectionId)
    terminal?.onClose(message.reason)
  } else if (message.type === 'terminal-attached') {
    const pending = attaching.get(message.requestId)
    attaching.delete(message.requestId)
    if (message.error === null) pending?.resolve()
    else pending?.reject(new Error(message.error))
  }
}

receivePorts('ade:stream-port', (next) => {
  port?.close()
  port = next
  port.onmessage = (event: MessageEvent<BridgeToWindow>) => receive(event.data)
  for (const message of waiting.splice(0)) port.postMessage(message)
})

// When the bridge restarts, its terminal attachments are gone: tell their owners, then reconnect.
subscribe('ade:stream-lost', () => {
  port?.close()
  port = null
  for (const [connectionId, terminal] of terminals) {
    terminals.delete(connectionId)
    terminal.onClose('The stream connection restarted')
  }
  for (const [requestId, pending] of attaching) {
    attaching.delete(requestId)
    pending.reject(new Error('The stream connection restarted'))
  }
  void invoke('ade:stream-connect')
})

void invoke('ade:stream-connect')

export function onFeedFrame(listener: (frame: FeedFrame) => void): () => void {
  feedListeners.add(listener)
  return () => feedListeners.delete(listener)
}

export const terminal: TerminalBridge = {
  async attach(workspaceId, terminalId, onFrame, onClose) {
    const connectionId = globalThis.crypto.randomUUID()
    const requestId = globalThis.crypto.randomUUID()
    terminals.set(connectionId, { onFrame, onClose })
    try {
      await new Promise<void>((resolve, reject) => {
        attaching.set(requestId, { resolve, reject })
        post({ type: 'terminal-attach', requestId, connectionId, workspaceId, terminalId })
      })
    } catch (error) {
      terminals.delete(connectionId)
      throw error
    }
    return {
      input: (data) => post({ type: 'terminal-input', connectionId, data }),
      binary: (bytes) => post({ type: 'terminal-binary', connectionId, bytes }),
      resize: (cols, rows, widthPx, heightPx) =>
        post({ type: 'terminal-resize', connectionId, cols, rows, widthPx, heightPx }),
      dispose: () => {
        terminals.delete(connectionId)
        post({ type: 'terminal-detach', connectionId })
      },
    }
  },
}
