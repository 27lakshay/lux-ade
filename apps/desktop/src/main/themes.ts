import {
  chooseThemeFiles,
  chooseLinkedThemeFile,
  readLinkedThemeSource,
  watchLinkedThemeFile,
  chooseGhosttyFile,
  chooseWarpFile,
  saveThemeFile,
  saveThemePack,
  saveGhosttyTheme,
} from './theme-files'
import { randomUUID } from 'node:crypto'
import type { ThemeDiagnostic } from '@ade/contracts'
import type { ThemeLinkedFile } from '../shared/bridge/themes'
import { emit, handleResult as handle } from './ipc'
import { decodeRequest, type ThemeInstallItem } from '@ade/contracts'
import { dailyUseCommand, DaemonRequestError } from '@ade/client'
import { getClient, getSocket } from './profile-connection'
import { refreshAppearance } from './appearance'

interface LinkedFileState {
  linkId: string
  stop: () => void
  sequence: number
  timer?: NodeJS.Timeout
  reading: boolean
  dirty: boolean
  closed: () => void
  navigation: (...args: any[]) => void
  crashed: (...args: any[]) => void
}
const linkedFiles = new Map<number, LinkedFileState>()
function endpoint(): string {
  const socket = getSocket()
  if (!socket || getClient().getState().status !== 'connected')
    throw new DaemonRequestError('unavailable', 'Profile daemon is unavailable')
  return socket
}
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new DaemonRequestError('invalid_request', 'Theme input must be text')
}
function revision(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new DaemonRequestError('invalid_request', 'Invalid theme revision')
}

function themeRequest(
  input: unknown,
  op:
    | 'themes.pack.export'
    | 'themes.preview'
    | 'themes.draft.preview'
    | 'themes.ghostty.validate'
    | 'themes.warp.validate',
) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new DaemonRequestError('invalid_request', 'Invalid theme request')
  try {
    return decodeRequest({ ...input, op })
  } catch (error) {
    throw new DaemonRequestError('invalid_request', error instanceof Error ? error.message : String(error))
  }
}
async function inspectLinkedFile(path: string, linkId: string, sequence: number): Promise<ThemeLinkedFile> {
  const file = await readLinkedThemeSource(path)
  if (file.source === null)
    return {
      ...file,
      linkId,
      sequence,
      diagnostics: [sourceDiagnostic(file.error ?? 'Theme file is unavailable')],
      validation: null,
    }
  const report = await dailyUseCommand(endpoint(), { op: 'themes.file.validate', source: file.source })
  const member = report.candidates.length === 1 ? report.candidates[0] : undefined
  const validation = member?.validation ?? null
  const diagnostics = report.container_valid ? (validation?.diagnostics ?? report.diagnostics) : report.diagnostics
  const valid = report.container_valid && report.candidates.length === 1 && validation?.valid === true
  return { path, source: valid ? file.source : null, error: null, linkId, sequence, diagnostics, validation }
}
function sourceDiagnostic(message: string): ThemeDiagnostic {
  return { code: 'source_unavailable', column: 1, length: 0, line: 1, message, offset: 0, path: '', severity: 'error' }
}
function stopLinkedFile(contents: Electron.WebContents): void {
  const state = linkedFiles.get(contents.id)
  if (!state) return
  linkedFiles.delete(contents.id)
  state.stop()
  if (state.timer) clearTimeout(state.timer)
  contents.removeListener('destroyed', state.closed)
  contents.removeListener('did-start-navigation', state.navigation)
  contents.removeListener('render-process-gone', state.crashed)
}
async function linkFile(contents: Electron.WebContents): Promise<ThemeLinkedFile | null> {
  const chosen = await chooseLinkedThemeFile(contents)
  if (!chosen) return null
  stopLinkedFile(contents)
  const linkId = randomUUID()
  const state: LinkedFileState = {
    linkId,
    stop: () => {},
    sequence: 0,
    reading: false,
    dirty: false,
    closed: () => {},
    navigation: (...args: any[]) => {
      if (args[3] === true) stopLinkedFile(contents)
    },
    crashed: () => stopLinkedFile(contents),
  }
  let flush: () => Promise<void>
  state.stop = watchLinkedThemeFile(chosen.path, () => {
    state.dirty = true
    if (state.timer) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      void flush()
    }, 80)
  })
  flush = async () => {
    if (state.reading || !state.dirty || linkedFiles.get(contents.id) !== state) return
    state.reading = true
    state.dirty = false
    const sequence = ++state.sequence
    try {
      const snapshot = await inspectLinkedFile(chosen.path, linkId, sequence)
      if (linkedFiles.get(contents.id) === state && !state.dirty) emit(contents, 'ade:themes-linked-file', snapshot)
    } catch (error) {
      const failed: ThemeLinkedFile = {
        path: chosen.path,
        source: null,
        error: String(error),
        linkId,
        sequence,
        diagnostics: [sourceDiagnostic(String(error))],
        validation: null,
      }
      if (linkedFiles.get(contents.id) === state) emit(contents, 'ade:themes-linked-file', failed)
    } finally {
      state.reading = false
      if (state.dirty && linkedFiles.get(contents.id) === state) void flush()
    }
  }
  state.closed = () => stopLinkedFile(contents)
  state.crashed = state.closed
  linkedFiles.set(contents.id, state)
  contents.once('destroyed', state.closed)
  contents.on('did-start-navigation', state.navigation)
  contents.once('render-process-gone', state.crashed)
  return inspectLinkedFile(chosen.path, linkId, 0)
}
export function registerThemesIpc(): void {
  handle('ade:themes-export-ghostty', async (_event, id, expectedRevision) => {
    text(id)
    revision(expectedRevision)
    return dailyUseCommand(endpoint(), { op: 'themes.ghostty.export', id, expected_revision: expectedRevision })
  })
  handle('ade:themes-save-ghostty', async (event, id, expectedRevision) => {
    text(id)
    revision(expectedRevision)
    const exported = await dailyUseCommand(endpoint(), {
      op: 'themes.ghostty.export',
      id,
      expected_revision: expectedRevision,
    })
    return saveGhosttyTheme(event.sender, exported)
  })
  handle('ade:themes-choose-ghostty-file', async (event) => chooseGhosttyFile(event.sender))
  handle('ade:themes-choose-warp-file', async (event) => chooseWarpFile(event.sender))
  handle('ade:themes-validate-warp', async (_event, input) => {
    const request = themeRequest(input, 'themes.warp.validate')
    if (request.op !== 'themes.warp.validate')
      throw new DaemonRequestError('invalid_request', 'Invalid Warp theme operation')
    return dailyUseCommand(endpoint(), request)
  })
  handle('ade:themes-validate-ghostty', async (_event, input) => {
    const request = themeRequest(input, 'themes.ghostty.validate')
    if (request.op !== 'themes.ghostty.validate')
      throw new DaemonRequestError('invalid_request', 'Invalid Ghostty theme operation')
    return dailyUseCommand(endpoint(), request)
  })
  handle('ade:themes-export-pack', async (_event, input) => {
    const request = themeRequest(input, 'themes.pack.export')
    if (request.op !== 'themes.pack.export')
      throw new DaemonRequestError('invalid_request', 'Invalid theme pack operation')
    return dailyUseCommand(endpoint(), request)
  })
  handle('ade:themes-save-pack', async (event, input) => {
    const request = themeRequest(input, 'themes.pack.export')
    if (request.op !== 'themes.pack.export')
      throw new DaemonRequestError('invalid_request', 'Invalid theme pack operation')
    const exported = await dailyUseCommand(endpoint(), request)
    return saveThemePack(event.sender, exported)
  })
  handle('ade:themes-validate-file', async (_event, source) => {
    text(source)
    return dailyUseCommand(endpoint(), { op: 'themes.file.validate', source })
  })
  handle('ade:themes-save-file', async (event, id, expectedRevision) => {
    text(id)
    revision(expectedRevision)
    const exported = await dailyUseCommand(endpoint(), { op: 'themes.export', id, expected_revision: expectedRevision })
    return saveThemeFile(event.sender, exported)
  })
  handle('ade:themes-removal', async (_event, id, afterKey) => {
    text(id)
    if (afterKey !== undefined) text(afterKey)
    return dailyUseCommand(endpoint(), { op: 'themes.removal', id, after_key: afterKey ?? null })
  })
  handle('ade:themes-remove', async (_event, id, expectedRevision, expectedAppearanceRevision) => {
    text(id)
    revision(expectedRevision)
    revision(expectedAppearanceRevision)
    const socket = endpoint()
    const result = await dailyUseCommand(socket, {
      op: 'themes.remove',
      id,
      expected_revision: expectedRevision,
      expected_appearance_revision: expectedAppearanceRevision,
    })
    if (result.changed) await refreshAppearance(socket)
    return result
  })
  handle('ade:themes-preview', async (_event, input) => {
    const request = themeRequest(input, 'themes.preview')
    if (request.op !== 'themes.preview')
      throw new DaemonRequestError('invalid_request', 'Invalid theme preview operation')
    return dailyUseCommand(endpoint(), request)
  })
  handle('ade:themes-preview-draft', async (_event, input) => {
    const request = themeRequest(input, 'themes.draft.preview')
    if (request.op !== 'themes.draft.preview')
      throw new DaemonRequestError('invalid_request', 'Invalid theme draft preview operation')
    return dailyUseCommand(endpoint(), request)
  })
  handle('ade:themes-choose-files', async (event) => chooseThemeFiles(event.sender))
  handle('ade:themes-validate', async (_event, source) => {
    text(source)
    return dailyUseCommand(endpoint(), { op: 'themes.validate', source })
  })
  handle('ade:themes-list', async (_event, afterId) => {
    if (afterId !== undefined) text(afterId)
    return dailyUseCommand(endpoint(), { op: 'themes.list', after_id: afterId ?? null })
  })
  handle('ade:themes-inspect', async (_event, id) => {
    text(id)
    return dailyUseCommand(endpoint(), { op: 'themes.inspect', id })
  })
  handle('ade:themes-export', async (_event, id, expectedRevision) => {
    text(id)
    if (expectedRevision !== undefined) revision(expectedRevision)
    return dailyUseCommand(endpoint(), { op: 'themes.export', id, expected_revision: expectedRevision ?? null })
  })
  handle('ade:themes-install', async (_event, input) => {
    if (!Array.isArray(input) || input.length < 1 || input.length > 16)
      throw new DaemonRequestError('invalid_request', 'Accept between 1 and 16 definitions')
    for (const item of input) {
      if (!item || typeof item !== 'object')
        throw new DaemonRequestError('invalid_request', 'Invalid accepted definition')
      text(item.source)
      revision(item.expected_revision)
    }
    const socket = endpoint()
    const result = await dailyUseCommand(socket, { op: 'themes.install', items: input as ThemeInstallItem[] })
    if (result.changed) await refreshAppearance(socket)
    return result
  })
  handle('ade:themes-rename', async (_event, id, name, expectedRevision) => {
    text(id)
    text(name)
    revision(expectedRevision)
    const socket = endpoint()
    const result = await dailyUseCommand(socket, { op: 'themes.rename', id, name, expected_revision: expectedRevision })
    if (result.changed) await refreshAppearance(socket)
    return result
  })
  handle('ade:themes-link-file', async (event) => linkFile(event.sender))
  handle('ade:themes-unlink-file', async (event, linkId) => {
    if (linkId !== undefined) text(linkId)
    const current = linkedFiles.get(event.sender.id)
    if (current && (linkId === undefined || current.linkId === linkId)) stopLinkedFile(event.sender)
  })
}
