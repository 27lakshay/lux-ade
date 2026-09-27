import { ipcRenderer } from 'electron'
import type {
  EventChannel,
  EventChannels,
  InvokeChannel,
  InvokeChannels,
  PortChannel,
  SendChannel,
  SendChannels,
} from '../shared/ipc'

// Typed wrappers over ipcRenderer, checked against the contract in src/shared/ipc.ts.

export function invoke<C extends InvokeChannel>(
  channel: C,
  ...args: Parameters<InvokeChannels[C]>
): ReturnType<InvokeChannels[C]> {
  return ipcRenderer.invoke(channel, ...args) as ReturnType<InvokeChannels[C]>
}

/**
 * The bridge method a channel serves, forwarding its arguments unchanged. Unlike `invoke`, it keeps
 * a generic method generic, so a contract request stays typed by its operation.
 */
export function forward<C extends InvokeChannel>(channel: C): InvokeChannels[C] {
  return ((...args: unknown[]) => ipcRenderer.invoke(channel, ...args)) as InvokeChannels[C]
}

export function send<C extends SendChannel>(channel: C, ...args: Parameters<SendChannels[C]>): void {
  ipcRenderer.send(channel, ...args)
}

/** Calls `listener` with each MessagePort main delivers on `channel`. */
export function receivePorts(channel: PortChannel, listener: (port: MessagePort) => void): void {
  ipcRenderer.on(channel, (event) => {
    const [port] = event.ports
    if (port) listener(port)
  })
}

/** Calls `listener` with each event's arguments; returns the unsubscribe function. */
export function subscribe<C extends EventChannel>(
  channel: C,
  listener: (...args: EventChannels[C]) => void,
): () => void {
  const receive = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void =>
    listener(...(args as EventChannels[C]))
  ipcRenderer.on(channel, receive)
  return () => ipcRenderer.removeListener(channel, receive)
}
