// Profile switching: starts a profile daemon through the launcher, attaches the
// connection in profile-connection.ts and serves the profile IPC channels.
import { BrowserWindow, ipcMain } from 'electron'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { AdeClient } from '@ade/client'
import { setBrowserProfile } from './browser'
import { BrowserOwner } from './browser-owner'
import { broadcast, getBrowserOwner, getClient, getClientGeneration, getProfileState, getSocket,
  getStartupProfileSelection, getUnsubscribeClient, getUnsubscribeFeed, isRestoringBinding, isSwitching, launcher,
  managedProfiles, nextClientGeneration, publishProfile, refreshProfiles, setBrowserOwner, setClient, setSocket,
  setSwitching, setUnsubscribeClient, setUnsubscribeFeed, type ProfileState } from './profile-connection'
import { closeSenderTerminals } from './terminals'
import { selectedWorkspaces, selectionRequests } from './workspaces'

async function attachClient(endpoint: string, profileId: string): Promise<void> {
  const home = getProfileState().profiles.find((item) => item.id === profileId)?.home
  if (!home) throw new Error('Browser profile home is unavailable')
  const nextBrowserOwner = await BrowserOwner.open(profileId)
  try { await setBrowserProfile(profileId, home) }
  catch (error) { await nextBrowserOwner.close(); throw error }
  const previousBrowserOwner = getBrowserOwner()
  setBrowserOwner(nextBrowserOwner)
  void previousBrowserOwner?.close()
  const previous = getClient()
  const previousSubscription = getUnsubscribeClient()
  const previousFeed = getUnsubscribeFeed()
  const next = new AdeClient(endpoint)
  const generation = nextClientGeneration()
  selectedWorkspaces.clear()
  selectionRequests.clear()
  setClient(next)
  setSocket(endpoint)
  publishProfile({ activeId: profileId, error: '' })
  for (const window of BrowserWindow.getAllWindows()) closeSenderTerminals(window.webContents.id)
  previousSubscription?.()
  previousFeed?.()
  previous.stop()
  setUnsubscribeClient(next.subscribe((state) => {
    if (generation === getClientGeneration()) {
      broadcast('ade:client-state-changed', state)
      if (state.status === 'connected') {
        void nextBrowserOwner.register(endpoint, state.bootId).catch((error) =>
          console.error('Browser owner registration failed', error))
      }
    }
  }))
  setUnsubscribeFeed(next.subscribeFeed((frame) => {
    if (generation === getClientGeneration()) broadcast('ade:feed-frame', frame)
  }))
  next.start()
}

export async function selectProfile(id: string, updateDefault: boolean): Promise<ProfileState> {
  if (!managedProfiles) throw new Error('The socket is fixed by ADE_SOCKET')
  if (isSwitching()) throw new Error('A profile switch is already in progress')
  if (isRestoringBinding()) throw new Error('Wait for workspace recovery to finish before switching profiles')
  if (!getProfileState().profiles.some((item) => item.id === id)) throw new Error('Unknown profile')
  setSwitching(true)
  try {
    const previousId = getProfileState().activeId
    const previousEndpoint = getSocket()
    const result = await launcher('start', id)
    if (result.type !== 'profile_started' || typeof result.socket !== 'string' || !result.socket) {
      throw new Error('Profile launcher did not return a daemon socket')
    }
    await attachClient(result.socket, id)
    // Let packaged E2E select another profile while startup selection remains open.
    const release = process.env.ADE_E2E_STARTUP_PROFILE_RELEASE_FILE
    if (!updateDefault && process.env.ADE_E2E_HIDE_WINDOW === '1' && release && isAbsolute(release)) {
      const deadline = Date.now() + 10_000
      while (true) {
        try { await stat(release); break }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        if (Date.now() >= deadline) throw new Error('E2E startup profile release timed out')
        await new Promise<void>((done) => setTimeout(done, 25))
      }
    }
    if (updateDefault) {
      try { await launcher('select', id) } catch (error) {
        if (previousId && previousEndpoint) {
          try { await attachClient(previousEndpoint, previousId) } catch (rollbackError) {
            throw new Error(`Could not save the selected profile, and returning to the previous profile failed: ${String(rollbackError)}`, { cause: error })
          }
        }
        throw error
      }
    }
    return await refreshProfiles()
  } finally { setSwitching(false) }
}
export function registerProfileIpc(): void {
  ipcMain.handle('ade:client-state', () => getClient().getState())
  ipcMain.handle('ade:profile-state', () => getProfileState())
  ipcMain.handle('ade:profile-list', () => refreshProfiles())
  ipcMain.handle('ade:profile-create', async (_event, name: unknown) => {
    if (!managedProfiles) throw new Error('The socket is fixed by ADE_SOCKET')
    if (isSwitching()) throw new Error('A profile operation is already in progress')
    if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('Profile name must contain 1 to 80 characters')
    await launcher('create', name.trim())
    return refreshProfiles()
  })
  ipcMain.handle('ade:profile-select', async (_event, id: unknown) => {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid profile ID')
    if (getStartupProfileSelection()) await getStartupProfileSelection()
    return selectProfile(id, true)
  })
}
