import { contextBridge, ipcRenderer } from 'electron'
import type { TerminalBridge, TerminalFrame } from '@ade/terminal'

const terminal: TerminalBridge = {
  async attach(workspaceId, terminalId, onFrame, onClose) {
    const connectionId = globalThis.crypto.randomUUID()
    const frameListener = (_event: Electron.IpcRendererEvent, id: string, frame: TerminalFrame): void => {
      if (id === connectionId) onFrame(frame)
    }
    const closeListener = (_event: Electron.IpcRendererEvent, id: string, reason: string): void => {
      if (id === connectionId) onClose(reason)
    }
    ipcRenderer.on('ade:terminal-frame', frameListener)
    ipcRenderer.on('ade:terminal-close', closeListener)
    try {
      await ipcRenderer.invoke('ade:terminal-attach', connectionId, workspaceId, terminalId)
    } catch (error) {
      ipcRenderer.removeListener('ade:terminal-frame', frameListener)
      ipcRenderer.removeListener('ade:terminal-close', closeListener)
      throw error
    }
    return {
      input: (data) => ipcRenderer.send('ade:terminal-input', connectionId, data),
      binary: (bytes) => ipcRenderer.send('ade:terminal-binary', connectionId, bytes),
      resize: (cols, rows, widthPx, heightPx) =>
        ipcRenderer.send('ade:terminal-resize', connectionId, cols, rows, widthPx, heightPx),
      dispose: () => {
        ipcRenderer.removeListener('ade:terminal-frame', frameListener)
        ipcRenderer.removeListener('ade:terminal-close', closeListener)
        ipcRenderer.send('ade:terminal-detach', connectionId)
      },
    }
  },
}

contextBridge.exposeInMainWorld('adeHost', {
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('ade:app-version'),
  getClientState: () => ipcRenderer.invoke('ade:client-state'),
  getProfileState: () => ipcRenderer.invoke('ade:profile-state'),
  listProfiles: () => ipcRenderer.invoke('ade:profile-list'),
  createProfile: (name: string) => ipcRenderer.invoke('ade:profile-create', name),
  selectProfile: (id: string) => ipcRenderer.invoke('ade:profile-select', id),
  openWorkspace: (folder: string) => ipcRenderer.invoke('ade:workspace-open', folder),
  chooseWorkspace: () => ipcRenderer.invoke('ade:workspace-choose'),
  selectWorkspace: (id: string, conversationId: string | null): Promise<boolean> =>
    ipcRenderer.invoke('ade:workspace-select', id, conversationId),
  onProfileState: (listener: (state: unknown) => void): (() => void) => {
    const receive = (_event: Electron.IpcRendererEvent, state: unknown): void => listener(state)
    ipcRenderer.on('ade:profile-state-changed', receive)
    return () => ipcRenderer.removeListener('ade:profile-state-changed', receive)
  },
  requestConversation: (op: string, fields: Record<string, unknown>): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('ade:conversation-request', op, fields),
  requestService: (op: string, fields: Record<string, unknown>): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('ade:service-request', op, fields),
  requestScript: (op: string, fields: Record<string, unknown>): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('ade:script-request', op, fields),
  requestReview: (op: string, fields: Record<string, unknown>): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('ade:review-request', op, fields),
  onDraftError: (listener: (value: { conversationId: string; message: string }) => void): (() => void) => {
    const receive = (_event: Electron.IpcRendererEvent, value: { conversationId: string; message: string }): void => listener(value)
    ipcRenderer.on('ade:draft-error', receive)
    return () => ipcRenderer.removeListener('ade:draft-error', receive)
  },
  onClientState: (listener: (state: unknown) => void): (() => void) => {
    const receive = (_event: Electron.IpcRendererEvent, state: unknown): void => listener(state)
    ipcRenderer.on('ade:client-state-changed', receive)
    return () => ipcRenderer.removeListener('ade:client-state-changed', receive)
  },
  onFeedFrame: (listener: (frame: unknown) => void): (() => void) => {
    const receive = (_event: Electron.IpcRendererEvent, frame: unknown): void => listener(frame)
    ipcRenderer.on('ade:feed-frame', receive)
    return () => ipcRenderer.removeListener('ade:feed-frame', receive)
  },
  browser: {
    list: () => ipcRenderer.invoke('ade:browser-list'),
    open: (url: string) => ipcRenderer.invoke('ade:browser-open', url),
    select: (id: string) => ipcRenderer.invoke('ade:browser-select', id),
    newTab: () => ipcRenderer.invoke('ade:browser-new'),
    navigate: (id: string, url: string) => ipcRenderer.invoke('ade:browser-navigate', id, url),
    history: (id: string, direction: 'back' | 'forward') => ipcRenderer.invoke('ade:browser-history', id, direction),
    close: (id: string) => ipcRenderer.invoke('ade:browser-close', id),
    bounds: (id: string, rect: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke('ade:browser-bounds', id, rect),
    hide: () => ipcRenderer.invoke('ade:browser-hide'),
    onState: (listener: (state: unknown) => void): (() => void) => {
      const receive = (_event: Electron.IpcRendererEvent, state: unknown): void => listener(state)
      ipcRenderer.on('ade:browser-state', receive)
      return () => ipcRenderer.removeListener('ade:browser-state', receive)
    },
  },
  terminal,
})
