import { ipcMain, webContents, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type {
  EventChannel,
  EventChannels,
  InvokeChannel,
  InvokeChannels,
  SendChannel,
  SendChannels,
} from '../shared/ipc'

// Typed wrappers over ipcMain, checked against the contract in src/shared/ipc.ts. Every request is
// accepted only from the main frame of a registered app window: never from a browser tab, a
// subframe, or a window that has navigated away. Arguments still arrive as `unknown`; validate them.

const appWindows = new Set<number>()

/** Marks a window's web contents as the app's own, so its requests are accepted. */
export function registerAppWindow(contents: WebContents): void {
  const id = contents.id
  appWindows.add(id)
  contents.once('destroyed', () => appWindows.delete(id))
}

function fromAppWindow(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return appWindows.has(event.sender.id) && event.senderFrame !== null && event.senderFrame === event.sender.mainFrame
}

type Result<C extends InvokeChannel> = ReturnType<InvokeChannels[C]> | Awaited<ReturnType<InvokeChannels[C]>>

export function handle<C extends InvokeChannel>(
  channel: C,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Result<C>,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromAppWindow(event)) throw new Error(`${channel} refused: the request did not come from an app window`)
    return handler(event, ...args)
  })
}

export function listen<C extends SendChannel>(
  channel: C,
  handler: (event: IpcMainEvent, ...args: unknown[]) => ReturnType<SendChannels[C]>,
): void {
  ipcMain.on(channel, (event, ...args) => {
    if (fromAppWindow(event)) handler(event, ...args)
  })
}

export function emit<C extends EventChannel>(contents: WebContents, channel: C, ...args: EventChannels[C]): void {
  if (!contents.isDestroyed()) contents.send(channel, ...args)
}

/** Sends an event to every app window. */
export function broadcast<C extends EventChannel>(channel: C, ...args: EventChannels[C]): void {
  for (const id of appWindows) {
    const contents = webContents.fromId(id)
    if (contents) emit(contents, channel, ...args)
  }
}
