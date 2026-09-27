// The active profile daemon connection: endpoint, client, generation, switching
// and profile state. Other main-process modules read it through the accessors
// below, because importers cannot reassign this module's bindings.
import { app, BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { AdeClient } from '@ade/client'
import type { BrowserOwner } from './browser-owner'

export type Profile = { id: string; name: string; selected: boolean; home: string }
export type ProfileState = { managed: boolean; profiles: Profile[]; selectedId: string | null; activeId: string | null; error: string }
export const fixedSocket = process.env.ADE_SOCKET
export const managedProfiles = !fixedSocket
let socket = fixedSocket
let client = new AdeClient(socket)
let clientGeneration = 0
let unsubscribeClient: (() => void) | null = null
let unsubscribeFeed: (() => void) | null = null
let switching = false
let restoringBinding = false
let startupProfileSelection: Promise<void> | null = null
let browserOwner: BrowserOwner | null = null
let profileState: ProfileState = { managed: managedProfiles, profiles: [], selectedId: null, activeId: null, error: '' }
const execFileAsync = promisify(execFile)

export const getSocket = (): string | undefined => socket
export const getClient = (): AdeClient => client
export const getClientGeneration = (): number => clientGeneration
export const getProfileState = (): ProfileState => profileState
export const isSwitching = (): boolean => switching
export const setSwitching = (value: boolean): void => { switching = value }
export const isRestoringBinding = (): boolean => restoringBinding
export const setRestoringBinding = (value: boolean): void => { restoringBinding = value }
export const getStartupProfileSelection = (): Promise<void> | null => startupProfileSelection
export const setStartupProfileSelection = (value: Promise<void> | null): void => { startupProfileSelection = value }
export const getBrowserOwner = (): BrowserOwner | null => browserOwner
export const setBrowserOwner = (value: BrowserOwner | null): void => { browserOwner = value }
export const setUnsubscribeClient = (value: (() => void) | null): void => { unsubscribeClient = value }
export const setUnsubscribeFeed = (value: (() => void) | null): void => { unsubscribeFeed = value }
export const getUnsubscribeClient = (): (() => void) | null => unsubscribeClient
export const getUnsubscribeFeed = (): (() => void) | null => unsubscribeFeed
export const setSocket = (value: string): void => { socket = value }
export const setClient = (value: AdeClient): void => { client = value }
export const nextClientGeneration = (): number => ++clientGeneration
export function stopClient(): void {
  unsubscribeClient?.()
  unsubscribeFeed?.()
  client.stop()
}

export function journalProfileId(endpoint: string): string {
  if (!managedProfiles) return `fixed-${createHash('sha256').update(resolve(endpoint)).digest('hex').slice(0, 32)}`
  if (socket !== endpoint || !profileState.activeId) throw new Error('Active profile changed before prompt recovery was recorded')
  return profileState.activeId
}
export function broadcast(channel: string, value: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, value)
  }
}

export function publishProfile(update: Partial<ProfileState>): ProfileState {
  profileState = { ...profileState, ...update }
  broadcast('ade:profile-state-changed', profileState)
  return profileState
}

export async function launcher(action: string, ...args: string[]): Promise<Record<string, unknown>> {
  const control = app.isPackaged ? resolve(process.resourcesPath, '../MacOS/ade-control')
    : resolve(app.getAppPath(), '../../target/debug/ade-control')
  const binary = process.env.ADE_DAEMON_BIN ?? (app.isPackaged
    ? resolve(process.resourcesPath, '../MacOS/ade-daemon')
    : resolve(app.getAppPath(), '../../target/debug/ade-daemon'))
  const environment = app.isPackaged ? {
    ...process.env,
    ADE_NODE_BIN: process.execPath,
    ADE_BUN_BIN: join(process.resourcesPath, 'bin/bun'),
    ADE_CONTROL_PACKAGED: '1',
    ELECTRON_RUN_AS_NODE: '1',
  } : process.env
  const result = await execFileAsync(control, ['profiles', '--daemon', binary, action, ...args], {
    timeout: 35_000,
    maxBuffer: 1024 * 1024,
    env: environment,
  })
  const value: unknown = JSON.parse(result.stdout)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Profile launcher returned an invalid response')
  return value as Record<string, unknown>
}

export async function refreshProfiles(): Promise<ProfileState> {
  if (!managedProfiles) return profileState
  const response = await launcher('list')
  if (response.type !== 'profiles' || !Array.isArray(response.profiles)) throw new Error('Invalid profile list')
  return publishProfile({ profiles: response.profiles as Profile[], selectedId: response.selected_id as string | null, error: '' })
}
