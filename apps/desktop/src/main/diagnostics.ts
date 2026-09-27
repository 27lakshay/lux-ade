import { app, BrowserWindow, crashReporter, dialog, shell } from 'electron'
import { dailyUseCommand } from '@ade/client'
import { cp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { logFile } from './logging'
import { getClient, getSocket } from './profile-connection'

// Local-only crash and diagnostics support. Crash dumps stay on this machine; nothing is uploaded.
// Help → Export Diagnostics writes a folder the user can inspect before sharing.

/** Keeps crash minidumps in app.getPath('crashDumps'). Call before the app is ready. */
export function startCrashReporter(): void {
  crashReporter.start({ uploadToServer: false })
}

const stamp = (): string => new Date().toISOString().replaceAll(':', '-').replace(/\..*$/, '')

async function writePrivate(path: string, value: unknown): Promise<void> {
  await writeFile(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  })
}

/** The daemon's own redacted bundle and status, or the reason they are missing. */
async function daemonReport(): Promise<Record<string, unknown>> {
  const socket = getSocket()
  if (!socket) return { unavailable: 'No profile daemon is connected' }
  const read = async (op: 'diagnostics.export' | 'diagnostics.status'): Promise<unknown> => {
    try {
      return await dailyUseCommand(socket, op === 'diagnostics.export' ? { op, max_events: 1000 } : { op })
    } catch (error) {
      return { unavailable: String(error) }
    }
  }
  return { export: await read('diagnostics.export'), status: await read('diagnostics.status') }
}

export async function exportDiagnostics(parent: BrowserWindow | null): Promise<void> {
  const options = {
    title: 'Export Diagnostics',
    defaultPath: join(app.getPath('desktop'), `ADE diagnostics ${stamp()}`),
    buttonLabel: 'Export',
    message: 'Includes app logs, crash reports and the daemon’s redacted operational events. Nothing is uploaded.',
  }
  const choice = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
  if (choice.canceled || !choice.filePath) return
  const folder = choice.filePath
  await mkdir(folder, { mode: 0o700 })

  const client = getClient().getState()
  await writePrivate(join(folder, 'app.json'), {
    exportedAt: new Date().toISOString(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    osVersion: process.getSystemVersion(),
    packaged: app.isPackaged,
    windows: BrowserWindow.getAllWindows().length,
    daemon: { status: client.status, detail: client.detail, bootId: client.bootId, revision: client.revision },
  })
  await writePrivate(join(folder, 'daemon.json'), await daemonReport())

  const logs = join(folder, 'logs')
  await mkdir(logs, { mode: 0o700 })
  const logDirectory = dirname(logFile())
  for (const name of await readdir(logDirectory).catch(() => [])) {
    if (name.endsWith('.log')) await cp(join(logDirectory, name), join(logs, basename(name)))
  }
  await cp(app.getPath('crashDumps'), join(folder, 'crash-reports'), { recursive: true }).catch(() => undefined)

  shell.showItemInFolder(join(folder, 'app.json'))
}
