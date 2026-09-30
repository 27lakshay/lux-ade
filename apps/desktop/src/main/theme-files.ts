import { constants, watch } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import {
  writeThemeExport,
  writeThemePackExport,
  writeGhosttyThemeExport,
  ThemeFileExportError,
  type ThemeFileExport,
  type ThemePackFileExport,
  type GhosttyThemeFileExport,
} from '@ade/client'
import type { ThemeExport, ThemePackExport, GhosttyThemeExport } from '@ade/contracts'
import { BrowserWindow, dialog } from 'electron'
import type { ThemeSourceFile } from '../shared/bridge/themes'

const SOURCE_BYTES = 512 * 1024

/** Only the native picker supplies a destination; the renderer cannot provide a filesystem path. */
export async function saveThemeFile(
  sender: Electron.WebContents,
  exported: ThemeExport,
): Promise<ThemeFileExport | null> {
  const choice = await chooseDestination(sender, exported.theme.id, 'definition')
  return choice ? writeThemeExport(choice.filePath, exported, choice.overwrite) : null
}

export async function saveThemePack(
  sender: Electron.WebContents,
  exported: ThemePackExport,
): Promise<ThemePackFileExport | null> {
  const choice = await chooseDestination(sender, exported.pack.id, 'pack')
  return choice ? writeThemePackExport(choice.filePath, exported, choice.overwrite) : null
}

async function chooseDestination(sender: Electron.WebContents, id: string, format: 'definition' | 'pack' | 'ghostty') {
  try {
    return await nativeDestination(sender, id, format)
  } catch (error) {
    throw new ThemeFileExportError('unavailable', error instanceof Error ? error.message : String(error), error)
  }
}

async function nativeDestination(sender: Electron.WebContents, id: string, format: 'definition' | 'pack' | 'ghostty') {
  const parent = BrowserWindow.fromWebContents(sender)
  const description = {
    definition: { title: 'Export ADE theme', name: 'ADE theme definition', extension: 'json' },
    pack: { title: 'Export ADE theme pack', name: 'ADE theme pack', extension: 'json' },
    ghostty: { title: 'Export Ghostty theme colors', name: 'Ghostty theme', extension: 'ghostty' },
  }[format]
  const options: Electron.SaveDialogOptions = {
    title: description.title,
    buttonLabel: 'Export',
    defaultPath: `${id.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 160)}.${description.extension}`,
    filters: [{ name: description.name, extensions: [description.extension] }],
  }
  const choice = await (parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options))
  if (choice.canceled || !choice.filePath) return null
  const existing = await lstat(choice.filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing && !existing.isFile() && !existing.isSymbolicLink())
    throw new Error('Choose a regular theme file destination')
  if (existing) {
    const confirmation: Electron.MessageBoxOptions = {
      type: 'question',
      title: 'Replace theme file',
      message: 'Replace the existing theme file?',
      detail: choice.filePath,
      buttons: ['Cancel', 'Replace file'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }
    const answer = await (parent ? dialog.showMessageBox(parent, confirmation) : dialog.showMessageBox(confirmation))
    if (answer.response !== 1) return null
  }
  return { filePath: choice.filePath, overwrite: Boolean(existing) }
}

async function readSource(file: string): Promise<ThemeSourceFile> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK)
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw new Error('Choose a regular theme file')
    if (metadata.size > SOURCE_BYTES) throw new Error('Theme file exceeds 512 KiB')
    const buffer = Buffer.alloc(SOURCE_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > SOURCE_BYTES) throw new Error('Theme file exceeds 512 KiB')
    const source = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))
    return { path: file, source, error: null }
  } catch (error) {
    return { path: file, source: null, error: error instanceof Error ? error.message : String(error) }
  } finally {
    await handle?.close()
  }
}
export const readLinkedThemeSource = readSource
/** Choose one source file for a window-owned live draft. */
export async function chooseLinkedThemeFile(sender: Electron.WebContents): Promise<ThemeSourceFile | null> {
  const parent = BrowserWindow.fromWebContents(sender)
  const options: Electron.OpenDialogOptions = {
    title: 'Link theme file',
    buttonLabel: 'Link theme file',
    properties: ['openFile'],
    filters: [{ name: 'ADE theme definition', extensions: ['json', 'jsonc'] }],
  }
  const result = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options))
  if (result.canceled || result.filePaths.length === 0) return null
  if (result.filePaths.length !== 1) throw new Error('Choose one theme file')
  return readSource(result.filePaths[0]!)
}

/** The parent directory survives atomic replacement and recreation of the selected file. */
export function watchLinkedThemeFile(file: string, onChange: () => void): () => void {
  const watcher = watch(dirname(file), (_event, filename) => {
    if (filename === null || basename(String(filename)) === basename(file)) onChange()
  })
  return () => watcher.close()
}
/** File reads follow an explicit native picker; no source path can arrive from the renderer. */
export async function chooseThemeFiles(sender: Electron.WebContents): Promise<ThemeSourceFile[]> {
  const parent = BrowserWindow.fromWebContents(sender)
  const options: Electron.OpenDialogOptions = {
    title: 'Import ADE theme files',
    buttonLabel: 'Preview themes',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'ADE theme definitions and packs', extensions: ['json', 'jsonc'] }],
  }
  const result = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options))
  if (result.canceled) return []
  if (result.filePaths.length > 16) throw new Error('Preview at most 16 theme files at once')
  const files: ThemeSourceFile[] = []
  for (const file of result.filePaths) files.push(await readSource(file))
  return files
}

/** One explicitly chosen YAML file; Warp paths inside source text are never followed. */
export async function chooseWarpFile(sender: Electron.WebContents): Promise<ThemeSourceFile | null> {
  const parent = BrowserWindow.fromWebContents(sender)
  const options: Electron.OpenDialogOptions = {
    title: 'Import Warp theme file',
    buttonLabel: 'Review theme',
    properties: ['openFile'],
    filters: [{ name: 'Warp YAML theme', extensions: ['yaml', 'yml'] }],
  }
  const result = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options))
  if (result.canceled || result.filePaths.length === 0) return null
  if (result.filePaths.length !== 1) throw new Error('Choose one Warp YAML file')
  return readSource(result.filePaths[0]!)
}
export async function chooseGhosttyFile(sender: Electron.WebContents): Promise<ThemeSourceFile | null> {
  const parent = BrowserWindow.fromWebContents(sender)
  const options: Electron.OpenDialogOptions = {
    title: 'Import Ghostty theme file',
    buttonLabel: 'Review colors',
    properties: ['openFile'],
    filters: [{ name: 'Ghostty theme file', extensions: ['*'] }],
  }
  const result = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options))
  if (result.canceled || result.filePaths.length === 0) return null
  if (result.filePaths.length !== 1) throw new Error('Choose one Ghostty theme file')
  return readSource(result.filePaths[0]!)
}

export async function saveGhosttyTheme(
  sender: Electron.WebContents,
  exported: GhosttyThemeExport,
): Promise<GhosttyThemeFileExport | null> {
  const choice = await chooseDestination(sender, exported.theme.id, 'ghostty')
  return choice ? writeGhosttyThemeExport(choice.filePath, exported, choice.overwrite) : null
}
