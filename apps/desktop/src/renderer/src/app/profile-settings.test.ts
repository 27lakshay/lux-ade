import type { FeedFrame } from '@ade/client'
import type { ProfileSettings } from '@ade/contracts'
import { createStore } from 'zustand/vanilla'
import { afterEach, expect, test, vi } from 'vitest'
import type { DaemonState } from '../state/daemon-store'
import { startProfileSettings } from './profile-settings'

let stop = (): void => {}
afterEach(() => {
  stop()
  document.documentElement.classList.remove('dark')
  document.documentElement.removeAttribute('data-reduced-motion')
})

const dark = () => document.documentElement.classList.contains('dark')
const reduced = () => document.documentElement.hasAttribute('data-reduced-motion')

test('the window shows the daemon’s settings when it connects, and follows each change', async () => {
  let feed: (frame: FeedFrame) => void = () => {}
  // Only the appearance and motion settings reach the window here.
  const get = vi.fn(async () => ({ appearance: 'dark', reduced_motion: 'on' }) as ProfileSettings)
  const host = {
    settings: { get, set: vi.fn() },
    conversations: { onFeedFrame: (listener: (frame: FeedFrame) => void) => ((feed = listener), () => {}) },
  } as unknown as Parameters<typeof startProfileSettings>[0]
  const store = createStore<DaemonState>(() => ({ status: 'connecting' }) as DaemonState)
  stop = startProfileSettings(host, store)
  expect(get).not.toHaveBeenCalled()

  store.setState({ status: 'connected' })
  await expect.poll(dark).toBe(true)
  expect(reduced()).toBe(true)

  feed({ type: 'settings_changed', settings: { appearance: 'light', reduced_motion: 'off' } } as unknown as FeedFrame)
  await expect.poll(dark).toBe(false)
  expect(reduced()).toBe(false)
})
