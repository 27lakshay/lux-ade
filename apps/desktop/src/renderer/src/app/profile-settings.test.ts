import type { FeedFrame } from '@ade/client'
import type { ProfileSettings, ResolvedAppearance } from '@ade/contracts'
import { createStore } from 'zustand/vanilla'
import { afterEach, expect, test, vi } from 'vitest'
import type { DaemonState } from '../state/daemon-store'
import { startProfileSettings } from './profile-settings'
import type {
  NativeAccessibilityBridge,
  NativeAccessibilitySnapshot,
} from '../../../shared/bridge/native-accessibility'

const defaultNativeAccessibility: NativeAccessibilitySnapshot = {
  highContrast: null,
  reducedTransparency: null,
  differentiateWithoutColor: null,
}

function nativeAccessibility() {
  let update: (snapshot: NativeAccessibilitySnapshot) => void = () => {}
  const bridge: NativeAccessibilityBridge = {
    getSnapshot: async () => defaultNativeAccessibility,
    onUpdate: (listener) => {
      update = listener
      return () => {}
    },
  }
  return {
    bridge,
    update: (snapshot: NativeAccessibilitySnapshot) => update(snapshot),
  }
}

let stop = (): void => {}
afterEach(() => {
  stop()
  document.documentElement.classList.remove('dark', 'theme-switching')
  document.documentElement.removeAttribute('style')
  document.documentElement.removeAttribute('data-reduced-motion')
  document.documentElement.removeAttribute('data-high-contrast')
  document.documentElement.removeAttribute('data-reduced-transparency')
  document.documentElement.removeAttribute('data-differentiate-without-color')
})

const dark = () => document.documentElement.classList.contains('dark')
const reduced = () => document.documentElement.hasAttribute('data-reduced-motion')

test('the window shows the daemon’s settings when it connects, and follows each change', async () => {
  let feed: (frame: FeedFrame) => void = () => {}
  const native = nativeAccessibility()
  // Only the appearance and motion settings reach the window here.
  let settings = {
    appearance: 'dark',
    reduced_motion: 'on',
    high_contrast: 'system',
    reduced_transparency: 'system',
    differentiate_without_color: 'system',
    appearance_revision: 0,
  } as ProfileSettings
  const get = vi.fn(async () => settings)
  const host = {
    settings: {
      get,
      set: vi.fn(),
      appearance: async () =>
        ({
          mode: settings.appearance,
          revision: settings.appearance_revision,
          tokens: {},
          syntax: { palette: { tokens: {} } },
        }) as ResolvedAppearance,
    },
    conversations: { onFeedFrame: (listener: (frame: FeedFrame) => void) => ((feed = listener), () => {}) },
    nativeAccessibility: native.bridge,
  } as unknown as Parameters<typeof startProfileSettings>[0]
  const store = createStore<DaemonState>(() => ({ status: 'connecting', bootId: 'boot-1' }) as DaemonState)
  stop = startProfileSettings(host, store)
  expect(get).not.toHaveBeenCalled()

  store.setState({ status: 'connected' })
  await expect.poll(dark).toBe(true)
  expect(reduced()).toBe(true)
  expect(document.documentElement.hasAttribute('data-high-contrast')).toBe(false)
  native.update({ highContrast: true, reducedTransparency: true, differentiateWithoutColor: true })
  await expect.poll(() => document.documentElement.hasAttribute('data-high-contrast')).toBe(true)
  expect(document.documentElement.hasAttribute('data-reduced-transparency')).toBe(true)
  expect(document.documentElement.hasAttribute('data-differentiate-without-color')).toBe(true)

  settings = {
    appearance: 'light',
    reduced_motion: 'off',
    high_contrast: 'off',
    reduced_transparency: 'on',
    differentiate_without_color: 'off',
    appearance_revision: 1,
  } as ProfileSettings
  feed({ type: 'settings_changed', boot_id: store.getState().bootId, settings } as FeedFrame)
  await expect.poll(dark).toBe(false)
  expect(reduced()).toBe(false)
  expect(document.documentElement.hasAttribute('data-high-contrast')).toBe(false)
  expect(document.documentElement.hasAttribute('data-reduced-transparency')).toBe(true)
  expect(document.documentElement.hasAttribute('data-differentiate-without-color')).toBe(false)
})

test.each([true, false])(
  'appearance replies respect identity changes and disposal (disconnect=%s)',
  async (disconnect) => {
    let feed: (frame: FeedFrame) => void = () => {}
    const replies: Array<(appearance: ResolvedAppearance) => void> = []
    const settings = (revision: number) =>
      ({ appearance: 'dark', reduced_motion: 'system', appearance_revision: revision }) as ProfileSettings
    const resolved = (revision: number, background: string): ResolvedAppearance => ({
      type: 'appearance',
      mode: 'dark',
      revision,
      theme_id: 'ade:graphite',
      syntax: {
        binding: { kind: 'follow_app' },
        light_palette: { id: 'ade:chalk', name: 'Chalk', mode: 'light', tokens: {} },
        dark_palette: { id: 'ade:graphite', name: 'Graphite', mode: 'dark', tokens: { 'syntax-keyword': background } },
        selected_id: 'ade:graphite',
        palette: { id: 'ade:graphite', name: 'Graphite', mode: 'dark', tokens: { 'syntax-keyword': background } },
        diagnostics: [],
      },
      preference: 'dark',
      diagnostics: [],
      light_palette: { id: 'ade:chalk', name: 'Chalk', mode: 'light', tokens: {} },
      dark_palette: { id: 'ade:graphite', name: 'Graphite', mode: 'dark', tokens: { 'syntax-keyword': background } },
      tokens: { background },
      propagation: { state: 'applied', revision },
      terminal_diagnostics: [],
      terminal: {
        revision,
        dark: true,
        minimum_contrast: 1,
        bold_color: 'inherit',
        cursor_text: 'cell-background',
        selection_foreground: 'cell-foreground',
        selection_background: { r: 0, g: 0, b: 0 },
        background: { r: 0, g: 0, b: 0 },
        foreground: { r: 255, g: 255, b: 255 },
        cursor: { r: 255, g: 255, b: 255 },
        palette: Array.from({ length: 256 }, () => ({ r: 0, g: 0, b: 0 })) as ResolvedAppearance['terminal']['palette'],
      },
    })
    const host = {
      settings: {
        get: async () => settings(0),
        appearance: () => new Promise<ResolvedAppearance>((resolve) => replies.push(resolve)),
      },
      conversations: { onFeedFrame: (listener: (frame: FeedFrame) => void) => ((feed = listener), () => {}) },
      nativeAccessibility: nativeAccessibility().bridge,
    } as unknown as Parameters<typeof startProfileSettings>[0]
    const store = createStore<DaemonState>(() => ({ status: 'connected', bootId: 'boot-1' }) as DaemonState)
    stop = startProfileSettings(host, store)
    await expect.poll(() => replies.length).toBe(1)
    feed({ type: 'settings_changed', boot_id: store.getState().bootId, settings: settings(1) } as FeedFrame)
    replies[1]!(resolved(2, '#123456'))
    await expect.poll(() => document.documentElement.style.getPropertyValue('--background')).toBe('#123456')
    replies[0]!(resolved(1, '#654321'))
    await Promise.resolve()
    expect(document.documentElement.style.getPropertyValue('--background')).toBe('#123456')
    feed({ type: 'settings_changed', boot_id: store.getState().bootId, settings: settings(3) } as FeedFrame)
    if (disconnect) store.setState({ status: 'connecting' })
    store.setState({ status: 'connected', bootId: 'boot-2' })
    await expect.poll(() => replies.length).toBe(4)
    feed({ type: 'settings_changed', boot_id: 'boot-1', settings: settings(10) } as FeedFrame)
    expect(replies).toHaveLength(4)
    replies[3]!(resolved(0, '#000000'))
    await expect.poll(() => document.documentElement.style.getPropertyValue('--background')).toBe('#000000')
    replies[2]!(resolved(3, '#abcdef'))
    await Promise.resolve()
    expect(document.documentElement.style.getPropertyValue('--background')).toBe('#000000')
    expect(document.documentElement.style.getPropertyValue('--ade-code-keyword')).toBe('#000000')
    feed({ type: 'settings_changed', boot_id: store.getState().bootId, settings: settings(1) } as FeedFrame)
    stop()
    replies[4]!(resolved(1, '#ffffff'))
    await Promise.resolve()
    expect(document.documentElement.style.getPropertyValue('--background')).toBe('#000000')
    expect(document.documentElement.style.getPropertyValue('--ade-code-keyword')).toBe('#000000')
  },
)

test('profile preferences reach root typography and density without resolving appearance', async () => {
  let feed: (frame: FeedFrame) => void = () => {}
  const settings = {
    appearance: 'dark',
    reduced_motion: 'system',
    appearance_revision: 0,
    ui_font_family: 'Sample Font, with spaces',
    ui_font_size: 15,
    code_font_family: 'Code Font',
    code_font_size: 17,
    density: 'compact',
  } as unknown as ProfileSettings
  const appearance = vi.fn(
    async () => ({ mode: 'dark', revision: 0, tokens: {}, syntax: { palette: { tokens: {} } } }) as ResolvedAppearance,
  )
  const host = {
    settings: { get: async () => settings, set: vi.fn(), appearance },
    conversations: { onFeedFrame: (listener: (frame: FeedFrame) => void) => ((feed = listener), () => {}) },
    nativeAccessibility: nativeAccessibility().bridge,
  } as unknown as Parameters<typeof startProfileSettings>[0]
  const store = createStore<DaemonState>(() => ({ status: 'connected', bootId: 'boot-1' }) as DaemonState)
  stop = startProfileSettings(host, store)
  await expect
    .poll(() => document.documentElement.style.getPropertyValue('--ade-ui-font-family'))
    .toBe('"Sample Font, with spaces"')
  expect(document.documentElement.style.getPropertyValue('--ade-code-font-family')).toBe('"Code Font"')
  expect(document.documentElement.style.getPropertyValue('--ade-ui-font-scale')).toBe(String(15 / 13))
  expect(document.documentElement.style.getPropertyValue('--ade-code-font-size')).toBe('17px')
  expect(document.documentElement.dataset.density).toBe('compact')
  await expect.poll(() => appearance.mock.calls.length).toBe(1)
  feed({
    type: 'settings_changed',
    boot_id: store.getState().bootId,
    settings: { ...settings, ui_font_size: 13, density: 'default' },
    revision: 1,
  } as unknown as FeedFrame)
  await expect.poll(() => document.documentElement.style.getPropertyValue('--ade-ui-font-scale')).toBe('1')
  expect(document.documentElement.dataset.density).toBe('default')
  expect(appearance).toHaveBeenCalledTimes(1)
})

test('a same-revision settings_changed wins over the pending startup settings.get reply', async () => {
  let feed: (frame: FeedFrame) => void = () => {}
  let resolveGet!: (settings: ProfileSettings) => void
  const startup = new Promise<ProfileSettings>((resolve) => (resolveGet = resolve))
  const initial = {
    appearance: 'dark',
    reduced_motion: 'system',
    appearance_revision: 3,
    ui_font_family: 'Old Font',
  } as unknown as ProfileSettings
  const newer = { ...initial, ui_font_family: 'New Font' }
  const host = {
    settings: {
      get: () => startup,
      set: vi.fn(),
      appearance: async () =>
        ({ mode: 'dark', revision: 3, tokens: {}, syntax: { palette: { tokens: {} } } }) as ResolvedAppearance,
    },
    conversations: { onFeedFrame: (listener: (frame: FeedFrame) => void) => ((feed = listener), () => {}) },
    nativeAccessibility: nativeAccessibility().bridge,
  } as unknown as Parameters<typeof startProfileSettings>[0]
  const store = createStore<DaemonState>(() => ({ status: 'connected', bootId: 'boot-1' }) as DaemonState)
  stop = startProfileSettings(host, store)
  feed({
    type: 'settings_changed',
    boot_id: store.getState().bootId,
    settings: newer,
    revision: 3,
  } as unknown as FeedFrame)
  resolveGet(initial)
  await expect.poll(() => document.documentElement.style.getPropertyValue('--ade-ui-font-family')).toBe('"New Font"')
})
