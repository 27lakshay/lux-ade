import { app, BrowserWindow, nativeTheme } from 'electron'
import { dailyUseCommand, type AdeClient } from '@ade/client'
import { decodeResponse, type ResolvedAppearance } from '@ade/contracts'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import log from 'electron-log/main'
import { getBrowserOwner, getSocket } from './profile-connection'
import { codeThemeVariables } from '../shared/code-theme'
import { APP_THEME_ROLES } from '../shared/app-theme-roles'
import { WINDOW_BACKGROUND, type ThemePreference } from '../shared/window-chrome'

// A cache of committed daemon replies. Preview and renderer preference messages never write it.
let currentProfile: string | null = null
let resolvedAppearance: ResolvedAppearance | null = null
let listening = false
let appliedRevision = -1
let appearanceGeneration = 0
let startupWarning: string | null = null
let cacheWriteWarning: string | null = null
const cacheFile = (profile: string): string =>
  join(app.getPath('userData'), 'appearance', `${createHash('sha256').update(profile).digest('hex')}.json`)

function validateSnapshot(value: unknown): ResolvedAppearance {
  const appearance = decodeResponse('settings.appearance', value)
  for (const [palette, mode] of [
    [appearance.light_palette, 'light'],
    [appearance.dark_palette, 'dark'],
    [appearance.syntax.light_palette, appearance.syntax.binding.kind === 'fixed' ? null : 'light'],
    [appearance.syntax.dark_palette, appearance.syntax.binding.kind === 'fixed' ? null : 'dark'],
  ] as const) {
    if (
      (mode !== null && palette.mode !== mode) ||
      Object.keys(palette.tokens).length !== APP_THEME_ROLES.length ||
      APP_THEME_ROLES.some((role) => !Object.hasOwn(palette.tokens, role))
    )
      throw new Error('Invalid startup palette')
    for (const [role, color] of Object.entries(palette.tokens)) {
      if (!/^[a-z][a-z0-9-]*$/.test(role) || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(color))
        throw new Error('Invalid startup color')
    }
  }
  return appearance
}

export function applyResolvedAppearance(profile: string, appearance: ResolvedAppearance): void {
  if (profile !== getSocket()) return
  if (appliedRevision > appearance.revision) return
  const validated = validateSnapshot(appearance)
  resolvedAppearance = validated
  appliedRevision = validated.revision
  setAppearance(validated.preference)
  for (const window of BrowserWindow.getAllWindows()) window.setBackgroundColor(validated.tokens.background!)
  if (!currentProfile) return
  const destination = cacheFile(currentProfile)
  const temporary = `${destination}.${randomUUID()}.tmp`
  try {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    writeFileSync(temporary, JSON.stringify({ version: 1, profile: currentProfile, appearance: validated }), {
      mode: 0o600,
    })
    renameSync(temporary, destination)
    cacheWriteWarning = null
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      /* No staged file survived the failed write. */
    }
    cacheWriteWarning = 'Appearance is saved. Startup colors could not be updated.'
    log.warn('Could not save startup appearance', error)
  }
}

/** Load once per profile before creating its windows or connecting its renderer. */
export function loadAppearance(profileId?: string): void {
  const socket = getSocket()
  currentProfile = profileId ? `profile:${profileId}` : socket ? `socket:${resolve(socket)}` : null
  resolvedAppearance = null
  appliedRevision = -1
  appearanceGeneration++
  startupWarning = null
  cacheWriteWarning = null
  if (currentProfile) {
    try {
      const file = cacheFile(currentProfile)
      if (statSync(file).size > 128 * 1024) throw new Error('Startup appearance is too large')
      const saved = JSON.parse(readFileSync(file, 'utf8')) as {
        version?: unknown
        profile?: unknown
        appearance?: unknown
      }
      if (saved.version !== 1 || saved.profile !== currentProfile)
        throw new Error('Startup appearance does not match this profile or format')
      resolvedAppearance = validateSnapshot(saved.appearance)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        startupWarning =
          'ADE started with default colors because its startup appearance cache could not be used. Your saved theme selection was preserved.'
        log.warn('Using default startup appearance', error)
      }
    }
  }
  nativeTheme.themeSource = resolvedAppearance?.preference ?? 'system'
  if (!listening) {
    listening = true
    nativeTheme.on('updated', () => {
      for (const window of BrowserWindow.getAllWindows()) window.setBackgroundColor(windowBackground())
    })
  }
}

export function setAppearance(theme: ThemePreference): void {
  if (nativeTheme.themeSource === theme) return
  nativeTheme.themeSource = theme
  getBrowserOwner()?.observeSystemAppearance()
}

/** The same current-OS choice supplies native background and the blocking page boot script. */
export function startupAppearance(): {
  preference: ThemePreference
  mode: 'light' | 'dark'
  tokens: Record<string, string>
  codeVariables: Record<string, string>
} {
  const preference = resolvedAppearance?.preference ?? 'system'
  const mode = preference === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : preference
  const palette = mode === 'dark' ? resolvedAppearance?.dark_palette : resolvedAppearance?.light_palette
  const syntax = mode === 'dark' ? resolvedAppearance?.syntax.dark_palette : resolvedAppearance?.syntax.light_palette
  return {
    preference,
    mode,
    tokens: palette?.tokens ?? { background: WINDOW_BACKGROUND[mode] },
    codeVariables: codeThemeVariables(syntax?.tokens ?? {}),
  }
}

export function windowBackground(): string {
  const appearance = startupAppearance()
  return appearance.tokens.background ?? WINDOW_BACKGROUND[appearance.mode]
}

/** Refresh from committed daemon state, fenced against profile changes and reconnects. */
export async function refreshAppearance(socket: string): Promise<ResolvedAppearance> {
  const generation = appearanceGeneration
  const appearance = await dailyUseCommand(socket, { op: 'settings.appearance' })
  if (generation === appearanceGeneration) applyResolvedAppearance(socket, appearance)
  return appearance
}

/** Main follows committed changes even when the profile has no open renderer. */
export function watchAppearance(client: AdeClient, socket: string): () => void {
  let bootId: string | null = null
  const refresh = (): void => {
    void refreshAppearance(socket).catch((error) => log.warn('Could not refresh committed appearance', error))
  }
  const stopState = client.subscribe((state) => {
    if (state.status === 'connected' && state.bootId !== bootId) {
      bootId = state.bootId
      appearanceGeneration++
      appliedRevision = -1
      refresh()
    }
  })
  const stopFeed = client.subscribeFeed((frame) => {
    if (frame.type === 'settings_changed') refresh()
  })
  return () => {
    stopState()
    stopFeed()
  }
}

export function appearanceStartupStatus(): { warnings: string[] } {
  return { warnings: [startupWarning, cacheWriteWarning].filter((warning): warning is string => warning !== null) }
}

export function acknowledgeStartupWarning(): void {
  startupWarning = null
}
