import type { TerminalBridge } from '@ade/terminal'
import { invoke, send, subscribe } from './ipc'

export const terminal: TerminalBridge = {
  async attach(workspaceId, terminalId, onFrame, onClose) {
    const connectionId = globalThis.crypto.randomUUID()
    const stopFrames = subscribe('ade:terminal-frame', (id, frame) => {
      if (id === connectionId) onFrame(frame)
    })
    const stopClose = subscribe('ade:terminal-close', (id, reason) => {
      if (id === connectionId) onClose(reason)
    })
    try {
      await invoke('ade:terminal-attach', connectionId, workspaceId, terminalId)
    } catch (error) {
      stopFrames()
      stopClose()
      throw error
    }
    return {
      input: (data) => send('ade:terminal-input', connectionId, data),
      binary: (bytes) => send('ade:terminal-binary', connectionId, bytes),
      resize: (cols, rows, widthPx, heightPx) =>
        send('ade:terminal-resize', connectionId, cols, rows, widthPx, heightPx),
      dispose: () => {
        stopFrames()
        stopClose()
        send('ade:terminal-detach', connectionId)
      },
    }
  },
}
