import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test } from './fixtures'
import { ProfileHost } from '../protocol/fixtures/managed-profiles'
import { TerminalStream } from '../protocol/fixtures/terminals'

test('appearance controls persist Graphite and Chalk and update the native window', async ({
  profile,
  desktop,
}, testInfo) => {
  const running = await desktop.launch(profile)
  const { app, window } = running
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(window.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  const light = window.getByRole('button', { name: 'Light — Chalk', exact: true })
  await expect(light).toBeVisible()
  await light.click()
  await expect.poll(async () => (await profile.call('settings.get', {})).settings.appearance).toBe('light')
  await expect(window.getByRole('main', { name: 'Settings', exact: true })).toHaveCSS(
    'background-color',
    'rgb(250, 251, 252)',
  )
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBackgroundColor().toLowerCase()),
    )
    .toBe('#fafbfc')
  await window.screenshot({ path: testInfo.outputPath('chalk-settings.png') })
  await window.getByRole('button', { name: 'Dark — Graphite', exact: true }).click()
  await expect.poll(async () => (await profile.call('settings.get', {})).settings.appearance).toBe('dark')
  await expect(window.getByRole('main', { name: 'Settings', exact: true })).toHaveCSS(
    'background-color',
    'rgb(29, 31, 35)',
  )
  await window.screenshot({ path: testInfo.outputPath('graphite-settings.png') })
  await desktop.quit(running)
  const restored = await desktop.launch(profile)
  await expect
    .poll(() =>
      restored.window.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--background').trim().toLowerCase(),
      ),
    )
    .toBe('#1d1f23')
})

test('a mounted terminal repaints from the daemon appearance without restarting', async ({ profile, desktop }) => {
  await profile.call('settings.set', { appearance: 'dark' })
  const { window } = await desktop.launch(profile)
  await window.getByRole('button', { name: /^New terminal/ }).click()
  const canvas = window.locator('[data-terminal] canvas').first()
  await expect(canvas).toBeVisible()
  const background = () =>
    canvas.evaluate((node) => Array.from((node as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1, 1).data))
  await expect.poll(background).toEqual([16, 17, 19, 255])
  const before = await profile.call('runtime.status', {})
  await profile.call('settings.set', { appearance: 'light' })
  await expect.poll(background).toEqual([232, 235, 239, 255])
  const after = await profile.call('runtime.status', {})
  expect(after.runtime_instance).toBe(before.runtime_instance)
  expect(after.terminals).toMatchObject(
    (before.terminals as Array<{ metrics: { run_id: string } }>).map((terminal) => ({
      metrics: { run_id: terminal.metrics.run_id },
    })),
  )
})

test('settings explains a saved appearance whose terminal update failed', async ({ profile, desktop }) => {
  const { window } = await desktop.launch(profile)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  const light = window.getByRole('button', { name: 'Light — Chalk', exact: true })
  await expect(light).toBeEnabled()
  await profile.killRuntime()
  await light.click()
  await expect(window.getByText(/Saved\. Terminal colors could not be confirmed:/)).toBeVisible()
  await expect(window.getByRole('button', { name: 'Retry terminal update', exact: true })).toBeEnabled()
  expect((await profile.call('settings.get', {})).settings.appearance).toBe('light')
  await expect(window.getByRole('main', { name: 'Settings', exact: true })).toHaveCSS(
    'background-color',
    'rgb(250, 251, 252)',
  )
})

test('restore default appearance uses the shared operation and preserves motion preferences', async ({
  profile,
  desktop,
}) => {
  await profile.call('settings.set', { appearance: 'light', reduced_motion: 'on' })
  const { window } = await desktop.launch(profile)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByRole('button', { name: 'Restore default appearance', exact: true }).click()
  await expect
    .poll(async () => (await profile.call('settings.get', {})).settings)
    .toMatchObject({
      appearance: 'system',
      appearance_revision: 2,
      reduced_motion: 'on',
    })
})

test('two windows in one profile adopt a selection made in either window', async ({ profile, desktop }) => {
  const { catalog } = await profile.call('catalog.get', {})
  for (const id of ['appearance-one', 'appearance-two']) {
    const created = await profile.cli('window', 'create', catalog.workspaces[0]!.id, '--id', id)
    expect(created.code, created.stderr).toBe(0)
  }
  const { app } = await desktop.launch(profile)
  await expect.poll(() => app.windows().length).toBe(2)
  const [first, second] = app.windows()
  for (const window of [first!, second!]) {
    await window.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(window.getByRole('button', { name: 'Light — Chalk', exact: true })).toBeEnabled()
  }
  await first!.getByRole('button', { name: 'Light — Chalk', exact: true }).click()
  for (const window of [first!, second!]) {
    await expect(window.getByRole('main', { name: 'Settings', exact: true })).toHaveCSS(
      'background-color',
      'rgb(250, 251, 252)',
    )
  }
  await second!.getByRole('button', { name: 'Dark — Graphite', exact: true }).click()
  for (const window of [first!, second!]) {
    await expect(window.getByRole('main', { name: 'Settings', exact: true })).toHaveCSS(
      'background-color',
      'rgb(29, 31, 35)',
    )
  }
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => window.getBackgroundColor().toLowerCase()),
      ),
    )
    .toEqual(['#1d1f23', '#1d1f23'])
})

test('a terminal opening during appearance changes paints the latest committed colors', async ({
  profile,
  desktop,
}) => {
  await profile.call('settings.set', { appearance: 'dark' })
  const { window } = await desktop.launch(profile)
  // Gate the browser's actual compilation boundary; custom ade:// assets bypass routing.
  await window.evaluate(() => {
    const instantiate = WebAssembly.instantiate
    const held = new Promise<void>((resolve) => {
      globalThis.addEventListener('appearance-test-release-wasm', () => resolve(), { once: true })
    })
    WebAssembly.instantiate = (async (...args: Parameters<typeof instantiate>) => {
      document.documentElement.dataset.wasmWaiting = 'true'
      await held
      return instantiate(...args)
    }) as typeof instantiate
  })
  try {
    await window.getByRole('button', { name: /^New terminal/ }).click()
    await expect(window.locator('html')).toHaveAttribute('data-wasm-waiting', 'true')
    const before = await profile.call('runtime.status', {})
    await profile.call('settings.set', { appearance: 'light' })
    await profile.call('settings.set', { appearance: 'dark' })
    await profile.call('settings.set', { appearance: 'light' })
    await window.evaluate(() => globalThis.dispatchEvent(new Event('appearance-test-release-wasm')))
    const canvas = window.locator('[data-terminal] canvas').first()
    await expect(canvas).toBeVisible()
    await expect
      .poll(() =>
        canvas.evaluate((node) =>
          Array.from((node as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1, 1).data),
        ),
      )
      .toEqual([232, 235, 239, 255])
    const after = await profile.call('runtime.status', {})
    expect(after.runtime_instance).toBe(before.runtime_instance)
    // This terminal starts on its first attachment, after WASM is released.
    const existing = before.terminals as Array<{ metrics: { run_id: string; shell_pid: number } }>
    expect(after.terminals).toHaveLength(existing.length + 1)
    expect(after.terminals).toEqual(
      expect.arrayContaining(
        existing.map(({ metrics }) =>
          expect.objectContaining({
            metrics: expect.objectContaining({ run_id: metrics.run_id, shell_pid: metrics.shell_pid }),
          }),
        ),
      ),
    )
    expect((await profile.call('settings.appearance', {})).propagation).toMatchObject({ state: 'applied' })
  } finally {
    await window.evaluate(() => globalThis.dispatchEvent(new Event('appearance-test-release-wasm')))
  }
})

test('a hidden terminal paints the latest appearance when its existing tab returns', async ({ profile, desktop }) => {
  await profile.call('settings.set', { appearance: 'dark' })
  const { window } = await desktop.launch(profile)
  await window.getByRole('button', { name: /^New terminal/ }).click()
  const terminal = window.locator('[data-terminal]').first()
  const terminalId = await terminal.getAttribute('data-terminal')
  const selected = window.locator('[data-tab-id][aria-selected="true"]')
  const tabId = await selected.getAttribute('data-tab-id')
  const canvas = await terminal.locator('canvas').elementHandle()
  expect(canvas).not.toBeNull()
  await expect
    .poll(() =>
      canvas!.evaluate((node) =>
        Array.from((node as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1, 1).data),
      ),
    )
    .toEqual([16, 17, 19, 255])
  await window.getByRole('button', { name: /^New conversation/ }).click()
  await expect.poll(() => canvas!.evaluate((node) => node.isConnected)).toBe(false)
  await expect.poll(() => canvas!.evaluate((node) => (node as HTMLCanvasElement).width)).toBe(0)
  const before = await profile.call('runtime.status', {})
  await profile.call('settings.set', { appearance: 'light' })
  await window.locator(`[data-tab-id="${tabId}"]`).click()
  await expect(window.locator(`[data-terminal="${terminalId}"] canvas`)).toBeVisible()
  await expect.poll(() => canvas!.evaluate((node) => node.isConnected)).toBe(true)
  await expect
    .poll(() =>
      canvas!.evaluate((node) =>
        Array.from((node as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1, 1).data),
      ),
    )
    .toEqual([232, 235, 239, 255])
  const after = await profile.call('runtime.status', {})
  expect(after.runtime_instance).toBe(before.runtime_instance)
  expect(after.terminals).toMatchObject(
    (before.terminals as Array<{ metrics: { run_id: string; shell_pid: number } }>).map(({ metrics }) => ({
      metrics: { run_id: metrics.run_id, shell_pid: metrics.shell_pid },
    })),
  )
})

test('changing terminal colors preserves mouse selection and scrollback position', async ({ profile, desktop }) => {
  await profile.call('settings.set', { appearance: 'dark' })
  const { window } = await desktop.launch(profile)
  await window.getByRole('button', { name: /^New terminal/ }).click()
  const terminal = window.locator('[data-terminal]').first()
  const canvas = terminal.locator('canvas')
  await expect(canvas).toBeVisible()
  const terminalId = await terminal.getAttribute('data-terminal')
  const { catalog } = await profile.call('catalog.get', {})
  const sent = await profile.cli('terminal', 'send', catalog.workspaces[0]!.id, terminalId!, 'seq 1 500')
  expect(sent.code, sent.stderr).toBe(0)
  const scrollbar = terminal.getByRole('scrollbar', { name: 'Terminal scrollback' })
  await expect.poll(async () => Number(await scrollbar.getAttribute('aria-valuemax'))).toBeGreaterThan(400)
  const box = (await canvas.boundingBox())!
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await window.mouse.wheel(0, -600)
  await expect
    .poll(
      async () =>
        Number(await scrollbar.getAttribute('aria-valuemax')) - Number(await scrollbar.getAttribute('aria-valuenow')),
    )
    .toBeGreaterThan(5)
  await window.mouse.move(box.x + 1, box.y + 40)
  await window.mouse.down()
  await window.mouse.move(box.x + 90, box.y + 40, { steps: 5 })
  await window.mouse.up()
  // Exercise the browser copy handler without changing the user's system clipboard.
  const selectedText = () =>
    terminal.locator('textarea').evaluate((input) => {
      const clipboardData = new DataTransfer()
      input.dispatchEvent(new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true }))
      return clipboardData.getData('text/plain')
    })
  const selection = await selectedText()
  expect(selection.trim()).toMatch(/^\d+$/)
  const selectedPixels = (rgb: number[]) =>
    canvas.evaluate((node, color) => {
      const element = node as HTMLCanvasElement
      const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data
      let count = 0
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] === color[0] && pixels[i + 1] === color[1] && pixels[i + 2] === color[2] && pixels[i + 3] === 255)
          count++
      }
      return count
    }, rgb)
  await expect.poll(() => selectedPixels([40, 60, 85])).toBeGreaterThan(50)
  const offset = await scrollbar.getAttribute('aria-valuenow')
  const before = await profile.call('runtime.status', {})
  await profile.call('settings.set', { appearance: 'light' })
  await expect
    .poll(() =>
      canvas.evaluate((node) =>
        Array.from((node as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1, 1).data),
      ),
    )
    .toEqual([232, 235, 239, 255])
  await expect.poll(() => selectedPixels([220, 232, 250])).toBeGreaterThan(50)
  expect(await selectedText()).toBe(selection)
  await expect(scrollbar).toHaveAttribute('aria-valuenow', offset!)
  expect((await profile.call('runtime.status', {})).terminals).toMatchObject(
    (before.terminals as Array<{ metrics: { run_id: string; shell_pid: number; terminal_bytes: number } }>).map(
      ({ metrics }) => ({
        metrics: { run_id: metrics.run_id, shell_pid: metrics.shell_pid, terminal_bytes: metrics.terminal_bytes },
      }),
    ),
  )
})

test('palette controls apply same-mode colors to the app and native window', async ({ profile, desktop }) => {
  await profile.call('settings.set', { appearance: 'dark' })
  const { app, window } = await desktop.launch(profile)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByRole('button', { name: 'Carbon', exact: true }).click()
  const catalog = await profile.call('settings.palettes', {})
  const carbon = catalog.palettes.find((palette) => palette.id === 'ade:carbon')!
  const linen = catalog.palettes.find((palette) => palette.id === 'ade:linen')!
  const painted = () =>
    window.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--background').trim().toLowerCase(),
    )
  const native = () =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBackgroundColor().toLowerCase())
  await expect.poll(painted).toBe(carbon.tokens.background!.toLowerCase())
  await expect.poll(native).toBe(carbon.tokens.background!.toLowerCase())
  await window.getByRole('button', { name: 'Linen', exact: true }).click()
  await window.getByRole('button', { name: 'Light — Linen', exact: true }).click()
  await expect.poll(painted).toBe(linen.tokens.background!.toLowerCase())
  await expect.poll(native).toBe(linen.tokens.background!.toLowerCase())
  expect((await profile.call('settings.get', {})).settings).toMatchObject({
    app_dark_theme: 'ade:carbon',
    app_light_theme: 'ade:linen',
  })
})

test('same-mode palette changes repaint mounted terminals and all app tokens', async ({ profile, desktop }) => {
  await profile.call('settings.set', { appearance: 'dark' })
  const { window } = await desktop.launch(profile)
  const existing = (await profile.call('catalog.get', {})).catalog.terminals.map((terminal) => terminal.id)
  await window.getByRole('button', { name: /^New terminal/ }).click()
  const selected = window.locator('[data-terminal]:visible').first()
  // The old canvas can still be visible while the create command is pending.
  await expect
    .poll(async () => {
      const id = await selected.getAttribute('data-terminal')
      return id !== null && !existing.includes(id)
    })
    .toBe(true)
  const canvas = selected.locator('canvas')
  await expect(canvas).toBeVisible()
  await expect
    .poll(() =>
      canvas.evaluate((node) =>
        Array.from((node as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1, 1).data),
      ),
    )
    .toEqual([16, 17, 19, 255])
  const before = await profile.call('runtime.status', {})
  const catalog = await profile.call('settings.palettes', {})
  for (const id of ['ade:carbon', 'ade:midnight', 'ade:graphite']) {
    await profile.call('settings.set', { app_dark_theme: id })
    const expected = catalog.palettes.find((palette) => palette.id === id)!
    await expect
      .poll(() =>
        window.evaluate((roles) => {
          const style = getComputedStyle(document.documentElement)
          return Object.fromEntries(roles.map((role) => [role, style.getPropertyValue(`--${role}`).trim()]))
        }, Object.keys(expected.tokens)),
      )
      .toEqual(expected.tokens)
    const resolved = await profile.call('settings.appearance', {})
    const { r, g, b } = resolved.terminal.background
    await expect
      .poll(() =>
        canvas.evaluate((node) =>
          Array.from((node as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1, 1).data),
        ),
      )
      .toEqual([r, g, b, 255])
  }
  const after = await profile.call('runtime.status', {})
  expect(after.runtime_instance).toBe(before.runtime_instance)
  expect(after.terminals).toMatchObject(
    (before.terminals as Array<{ metrics: { run_id: string; shell_pid: number } }>).map(({ metrics }) => ({
      metrics: { run_id: metrics.run_id, shell_pid: metrics.shell_pid },
    })),
  )
})

test('the registered desktop reports system changes to app and terminal without changing explicit mode', async ({
  profile,
  desktop,
}) => {
  const { app, window } = await desktop.launch(profile)
  await window.getByRole('button', { name: /^New terminal/ }).click()
  const canvas = window.locator('[data-terminal] canvas').first()
  await expect(canvas).toBeVisible()
  await expect.poll(async () => (await profile.call('browser.owner.get', {})).type).toBe('browser_owner')
  // Replace only the OS signal at Electron's boundary; the production owner, daemon,
  // runtime, feed and renderer apply it. Do not change the user's macOS preferences.
  const osMode = async (dark: boolean) =>
    app.evaluate(({ nativeTheme }, value) => {
      Object.defineProperty(nativeTheme, 'shouldUseDarkColors', { configurable: true, get: () => value })
      nativeTheme.emit('updated')
    }, dark)
  for (const dark of [false, true, false]) {
    await osMode(dark)
    await expect.poll(async () => (await profile.call('settings.appearance', {})).mode).toBe(dark ? 'dark' : 'light')
    await expect
      .poll(() =>
        canvas.evaluate((node) =>
          Array.from((node as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1, 1).data),
        ),
      )
      .toEqual(dark ? [16, 17, 19, 255] : [232, 235, 239, 255])
    await expect
      .poll(() =>
        window.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--background').trim().toLowerCase(),
        ),
      )
      .toBe(dark ? '#1d1f23' : '#fafbfc')
  }
  const beforeBurst = (await profile.call('settings.appearance', {})).revision
  await app.evaluate(({ nativeTheme }) => {
    for (const dark of [true, false]) {
      Object.defineProperty(nativeTheme, 'shouldUseDarkColors', { configurable: true, get: () => dark })
      nativeTheme.emit('updated')
    }
  })
  await expect.poll(async () => (await profile.call('settings.appearance', {})).revision).toBeGreaterThan(beforeBurst)
  await expect.poll(async () => (await profile.call('settings.appearance', {})).mode).toBe('light')
  await profile.call('settings.set', { appearance: 'dark' })
  await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark')
  const explicit = await profile.call('settings.appearance', {})
  await osMode(true)
  await osMode(false)
  expect(await profile.call('settings.appearance', {})).toEqual(explicit)
  await profile.call('settings.set', { appearance: 'system' })
  await expect.poll(async () => (await profile.call('settings.appearance', {})).mode).toBe('light')
})

for (const kind of ['fixed', 'paired'] as const) {
  test(`cold start uses cached ${kind} syntax and app palettes before paint without a daemon`, async ({
    profile,
    desktop,
  }) => {
    await profile.call('settings.set', {
      appearance: 'dark',
      app_dark_theme: 'ade:carbon',
      app_light_theme: 'ade:linen',
      syntax_binding: kind === 'fixed' ? { kind, theme_id: 'ade:ink' } : { kind, light: 'ade:chalk', dark: 'ade:ink' },
    })
    const saved = await profile.call('settings.appearance', {})
    const first = await desktop.launch(profile)
    await expect
      .poll(() =>
        first.window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--background').trim()),
      )
      .toBe('#25211D')
    const key = createHash('sha256')
      .update(`socket:${resolve(profile.socket)}`)
      .digest('hex')
    const file = join(desktop.userData, 'appearance', `${key}.json`)
    await expect
      .poll(async () => JSON.parse(await readFile(file, 'utf8')).appearance.dark_palette.id)
      .toBe('ade:carbon')
    await desktop.quit(first)
    await profile.killDaemon()
    const offline = await desktop.launch(profile)
    await expect
      .poll(() =>
        offline.window.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--background').trim(),
        ),
      )
      .toBe('#25211D')
    expect(
      await offline.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.getBackgroundColor().toLowerCase(),
      ),
    ).toBe('#25211d')
    await offline.window.screenshot()
    await expect
      .poll(() => offline.window.evaluate(() => performance.getEntriesByType('paint').length))
      .toBeGreaterThan(0)
    const timing = await offline.window.evaluate(() => ({
      appearance: performance
        .getEntriesByName('ade:appearance-ready')
        .map((entry) => ({ start: entry.startTime, detail: (entry as PerformanceMark).detail })),
      paints: performance.getEntriesByType('paint').map((entry) => entry.startTime),
    }))
    expect(timing.appearance).toHaveLength(1)
    expect(timing.appearance[0]!.detail).toEqual({
      mode: 'dark',
      background: '#25211D',
      codeKeyword: saved.syntax.dark_palette.tokens['syntax-keyword'],
    })
    expect(
      await offline.window.evaluate(() => document.documentElement.style.getPropertyValue('--ade-code-keyword')),
    ).toBe(saved.syntax.dark_palette.tokens['syntax-keyword'])
    for (const paint of timing.paints) expect(timing.appearance[0]!.start).toBeLessThanOrEqual(paint)
    const currentOsDark = await offline.app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'system'
      return nativeTheme.shouldUseDarkColors
    })
    await desktop.quit(offline)
    // A valid cached pair must use today's OS mode, even when its prior resolved mode differs.
    const cached = JSON.parse(await readFile(file, 'utf8'))
    cached.appearance.preference = 'system'
    const priorPalette = currentOsDark ? cached.appearance.light_palette : cached.appearance.dark_palette
    cached.appearance.mode = priorPalette.mode
    cached.appearance.tokens = priorPalette.tokens
    cached.appearance.theme_id = priorPalette.id
    await writeFile(file, JSON.stringify(cached))
    const system = await desktop.launch(profile)
    const dark = await system.app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)
    const expected = dark
      ? cached.appearance.dark_palette.tokens.background
      : cached.appearance.light_palette.tokens.background
    await expect
      .poll(() =>
        system.window.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--background').trim(),
        ),
      )
      .toBe(expected)
    expect(
      await system.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.getBackgroundColor().toLowerCase(),
      ),
    ).toBe(expected.toLowerCase())
    const expectedSyntax = dark ? saved.syntax.dark_palette : saved.syntax.light_palette
    expect(
      await system.window.evaluate(() => document.documentElement.style.getPropertyValue('--ade-code-keyword')),
    ).toBe(expectedSyntax.tokens['syntax-keyword'])
    const boot = await system.window.evaluate(
      () => (performance.getEntriesByName('ade:appearance-ready')[0] as PerformanceMark).detail,
    )
    expect(boot.codeKeyword).toBe(expectedSyntax.tokens['syntax-keyword'])
  })
}

for (const corruption of ['colors', 'roles', 'syntax'] as const) {
  test(`startup cache stays isolated by profile and rejects corrupt ${corruption}`, async ({
    ade,
    profile,
    desktop,
  }) => {
    await profile.call('settings.set', { appearance: 'dark', app_dark_theme: 'ade:carbon' })
    const first = await desktop.launch(profile)
    await expect
      .poll(() =>
        first.window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--background').trim()),
      )
      .toBe('#25211D')
    const key = createHash('sha256')
      .update(`socket:${resolve(profile.socket)}`)
      .digest('hex')
    const file = join(desktop.userData, 'appearance', `${key}.json`)
    await expect
      .poll(async () => JSON.parse(await readFile(file, 'utf8')).appearance.dark_palette.id)
      .toBe('ade:carbon')
    await desktop.quit(first)
    const other = await ade.profile()
    await other.killDaemon()
    const fresh = await desktop.launch(other)
    const freshDark = await fresh.app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)
    const fallback = freshDark ? '#1d1f23' : '#fafbfc'
    await expect
      .poll(() =>
        fresh.window.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--background').trim().toLowerCase(),
        ),
      )
      .toBe(fallback)
    expect(
      await fresh.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.getBackgroundColor().toLowerCase(),
      ),
    ).toBe(fallback)
    await desktop.quit(fresh)
    const cached = JSON.parse(await readFile(file, 'utf8'))
    if (corruption === 'colors') {
      cached.appearance.dark_palette.tokens.background = 'url(https://invalid.example/)'
    } else if (corruption === 'syntax') {
      cached.appearance.syntax.light_palette.tokens['syntax-keyword'] = 'url(https://invalid.example/)'
    } else {
      delete cached.appearance.dark_palette.tokens.foreground
      cached.appearance.dark_palette.tokens['unknown-role'] = '#010203'
    }
    await writeFile(file, JSON.stringify(cached))
    await profile.killDaemon()
    const corrupt = await desktop.launch(profile)
    await expect
      .poll(() =>
        corrupt.window.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--background').trim().toLowerCase(),
        ),
      )
      .toBe(fallback)
    expect(
      await corrupt.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.getBackgroundColor().toLowerCase(),
      ),
    ).toBe(fallback)
    await profile.restartDaemon()
    await corrupt.window.getByRole('button', { name: 'Settings', exact: true }).click()
    const warning = corrupt.window.getByText(
      'ADE started with default colors because its startup appearance cache could not be used. Your saved theme selection was preserved.',
      { exact: true },
    )
    await expect(warning).toBeVisible()
    await corrupt.window.getByRole('button', { name: 'Restore default appearance', exact: true }).click()
    await expect(warning).not.toBeVisible()
  })
}

test('main refreshes the startup cache after CLI changes with no open windows', async ({ profile, desktop }) => {
  await profile.call('settings.set', { appearance: 'dark' })
  const first = await desktop.launch(profile)
  await expect(first.window.getByRole('button', { name: /^New terminal/ })).toBeVisible()
  await first.app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.destroy()
  })
  await expect.poll(() => first.app.windows().length).toBe(0)
  const changed = await profile.cli('settings', 'set', 'app_dark_theme', 'ade:midnight')
  expect(changed.code, changed.stderr).toBe(0)
  const key = createHash('sha256')
    .update(`socket:${resolve(profile.socket)}`)
    .digest('hex')
  const file = join(desktop.userData, 'appearance', `${key}.json`)
  await expect
    .poll(async () => JSON.parse(await readFile(file, 'utf8')).appearance.dark_palette.id)
    .toBe('ade:midnight')
  const expected = (await profile.call('settings.appearance', {})).tokens.background!
  await desktop.quit(first)
  await profile.killDaemon()
  const offline = await desktop.launch(profile)
  await expect
    .poll(() =>
      offline.window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--background').trim()),
    )
    .toBe(expected)
})

test('settings explains an unavailable selected theme and restores defaults', async ({ profile, desktop }) => {
  await profile.call('settings.set', { appearance: 'dark', reduced_motion: 'on' })
  const database = new DatabaseSync(join(profile.dataDirectory, 'sessions.sqlite'))
  // Coordinate fixture writes with the live daemon's short transactions.
  database.exec('PRAGMA busy_timeout = 5000')
  database
    .prepare(
      "INSERT INTO profile_settings(key,value,updated_at) VALUES('app_dark_theme',?,0) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(JSON.stringify('missing:palette'))
  database.close()
  await profile.restartDaemon('kill')
  const { window, app } = await desktop.launch(profile)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  const warning = window.getByText('Selected theme missing:palette is unavailable. Using Graphite.', { exact: true })
  await expect(warning).toBeVisible()
  await expect(window.getByRole('main', { name: 'Settings', exact: true })).toHaveCSS(
    'background-color',
    'rgb(29, 31, 35)',
  )
  expect(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBackgroundColor().toLowerCase()),
  ).toBe('#1d1f23')
  await window.getByRole('button', { name: 'Restore default appearance', exact: true }).click()
  await expect(warning).not.toBeVisible()
  expect((await profile.call('settings.get', {})).settings).toMatchObject({
    app_dark_theme: 'ade:graphite',
    reduced_motion: 'on',
  })
})

test('app palette changes leave embedded website colors and content unchanged', async ({ profile, desktop }) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(
      '<html style="--background:#123456;--primary:#abcdef;background:var(--background);color:var(--primary)"><body><h1>Website colors</h1></body></html>',
    )
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Website fixture has no TCP port')
  const url = `http://127.0.0.1:${address.port}/theme-fixture`
  try {
    const running = await desktop.launch(profile)
    await running.window.evaluate(async (url) => {
      const state = await window.adeHost.browser.open(url)
      await window.adeHost.browser.bounds(state.selectedId!, { x: 0, y: 100, width: 600, height: 400 })
    }, url)
    const read = () =>
      running.app.evaluate(async ({ webContents }, url) => {
        const page = webContents.getAllWebContents().find((contents) => contents.getURL() === url)
        if (!page) return null
        return page.executeJavaScript(
          `({ text: document.body.innerText, background: getComputedStyle(document.documentElement).backgroundColor, foreground: getComputedStyle(document.documentElement).color, adeHost: typeof window.adeHost })`,
        )
      }, url)
    await expect.poll(read).toEqual({
      text: 'Website colors',
      background: 'rgb(18, 52, 86)',
      foreground: 'rgb(171, 205, 239)',
      adeHost: 'undefined',
    })
    const before = await read()
    for (const appearance of ['light', 'dark'] as const) {
      await profile.call('settings.set', { appearance, app_light_theme: 'ade:linen', app_dark_theme: 'ade:carbon' })
      const expected = (await profile.call('settings.appearance', {})).tokens.background!
      await expect
        .poll(() =>
          running.window.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--background').trim(),
          ),
        )
        .toBe(expected)
      expect(await read()).toEqual(before)
    }
    await desktop.quit(running)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())))
  }
})

test('managed profile switches apply each profile palette even when its revision is lower', async ({
  ade,
  desktop,
}, testInfo) => {
  const host = await ProfileHost.create(ade)
  try {
    const first = await host.create('Carbon profile')
    const second = await host.create('Linen profile')
    for (const profile of [first, second]) {
      const started = await profile.cli('settings', 'get')
      expect(started.code, started.stderr).toBe(0)
    }
    for (const id of ['ade:carbon', 'ade:midnight', 'ade:carbon']) {
      await first.call('settings.set', { appearance: 'dark', app_dark_theme: id })
    }
    await second.call('settings.set', { appearance: 'light', app_light_theme: 'ade:linen' })
    const firstAppearance = await first.call('settings.appearance', {})
    const secondAppearance = await second.call('settings.appearance', {})
    expect(firstAppearance.revision).toBeGreaterThan(secondAppearance.revision)
    const running = await desktop.launch(first.asScratch(), { ...host.env, ADE_SOCKET: '' })
    const { window: page, app } = running
    await host.track()
    const painted = () =>
      page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--background').trim())
    await expect.poll(painted).toBe(firstAppearance.tokens.background)
    for (const [profile, expected] of [
      [second, secondAppearance],
      [first, firstAppearance],
    ] as const) {
      await page.evaluate((id) => window.adeHost.profiles.select(id), profile.id)
      await expect
        .poll(() => page.evaluate(() => window.adeHost.profiles.getState()))
        .toMatchObject({ activeId: profile.id })
      await expect.poll(painted).toBe(expected.tokens.background)
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBackgroundColor().toLowerCase()),
        )
        .toBe(expected.tokens.background!.toLowerCase())
      const key = createHash('sha256').update(`profile:${profile.id}`).digest('hex')
      await expect
        .poll(
          async () => JSON.parse(await readFile(join(desktop.userData, 'appearance', `${key}.json`), 'utf8')).profile,
        )
        .toBe(`profile:${profile.id}`)
    }
    expect((await second.call('settings.get', {})).settings).toMatchObject({
      appearance: 'light',
      app_light_theme: 'ade:linen',
    })
  } finally {
    await desktop.closeAll()
    await host.teardown(testInfo)
  }
})

test('terminal binding controls keep a fixed palette independent and restore following', async ({
  profile,
  desktop,
}) => {
  await profile.call('settings.set', { appearance: 'light' })
  const { window: page } = await desktop.launch(profile)
  const existing = (await profile.call('catalog.get', {})).catalog.terminals.map((terminal) => terminal.id)
  await page.getByRole('button', { name: /^New terminal/ }).click()
  const selected = page.locator('[data-terminal]:visible').first()
  await expect
    .poll(async () => {
      const id = await selected.getAttribute('data-terminal')
      return id !== null && !existing.includes(id)
    })
    .toBe(true)
  const canvas = selected.locator('canvas')
  await expect(canvas).toBeVisible()
  const pixels = () =>
    canvas.evaluate((node) => Array.from((node as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1, 1).data))
  await expect.poll(pixels).toEqual([232, 235, 239, 255])
  const before = await profile.call('runtime.status', {})
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Fixed theme', exact: true }).click()
  await expect
    .poll(async () => (await profile.call('settings.get', {})).settings.terminal_binding)
    .toEqual({ kind: 'fixed', theme_id: 'ade:graphite' })
  await expect(page.getByRole('main', { name: 'Settings', exact: true })).toHaveCSS(
    'background-color',
    'rgb(250, 251, 252)',
  )
  await page.getByRole('link', { name: 'Back to workspace' }).click()
  await expect.poll(pixels).toEqual([16, 17, 19, 255])
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Separate pair', exact: true }).click()
  await expect
    .poll(async () => (await profile.call('settings.get', {})).settings.terminal_binding)
    .toEqual({ kind: 'paired', light: 'ade:chalk', dark: 'ade:graphite' })
  await page
    .getByRole('group', { name: 'Light terminal palette', exact: true })
    .getByRole('button', { name: 'Linen', exact: true })
    .click()
  await expect
    .poll(async () => (await profile.call('settings.get', {})).settings.terminal_binding)
    .toEqual({ kind: 'paired', light: 'ade:linen', dark: 'ade:graphite' })
  await page.getByRole('link', { name: 'Back to workspace' }).click()
  const expected = (await profile.call('settings.appearance', {})).terminal.background
  await expect.poll(pixels).toEqual([expected.r, expected.g, expected.b, 255])
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Follow app', exact: true }).click()
  await expect
    .poll(async () => (await profile.call('settings.get', {})).settings.terminal_binding)
    .toEqual({ kind: 'follow_app' })
  await page.getByRole('link', { name: 'Back to workspace' }).click()
  await expect.poll(pixels).toEqual([232, 235, 239, 255])
  const after = await profile.call('runtime.status', {})
  expect(after.runtime_instance).toBe(before.runtime_instance)
  expect(after.terminals).toMatchObject(
    (before.terminals as Array<{ metrics: { run_id: string } }>).map((terminal) => ({
      metrics: { run_id: terminal.metrics.run_id },
    })),
  )
})

test('one terminal override keeps its palette while the app changes and reset restores following', async ({
  profile,
  desktop,
}) => {
  await profile.call('settings.set', { appearance: 'light' })
  const { window: page } = await desktop.launch(profile)
  const existing = (await profile.call('catalog.get', {})).catalog.terminals.map((terminal) => terminal.id)
  await page.getByRole('button', { name: /^New terminal/ }).click()
  const selected = page.locator('[data-terminal]:visible').first()
  await expect
    .poll(async () => {
      const id = await selected.getAttribute('data-terminal')
      return id !== null && !existing.includes(id)
    })
    .toBe(true)
  const terminalId = (await selected.getAttribute('data-terminal'))!
  const { catalog } = await profile.call('catalog.get', {})
  const record = catalog.terminals.find((terminal) => terminal.id === terminalId)!
  const canvas = selected.locator('canvas')
  const pixels = () =>
    canvas.evaluate((node) => Array.from((node as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1, 1).data))
  await expect.poll(pixels).toEqual([232, 235, 239, 255])
  const before = await profile.call('runtime.status', {})
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('combobox', { name: 'Terminal to customize', exact: true }).selectOption(terminalId)
  await page
    .getByRole('group', { name: 'Override mode', exact: true })
    .getByRole('button', { name: 'Fixed theme', exact: true })
    .click()
  await page.getByRole('combobox', { name: 'Override palette', exact: true }).selectOption('ade:graphite')
  await expect
    .poll(
      async () =>
        (await profile.call('terminal.appearance.get', { workspace_id: record.workspace_id, terminal_id: terminalId }))
          .resolved_id,
    )
    .toBe('ade:graphite')
  await page.getByRole('link', { name: 'Back to workspace' }).click()
  await expect.poll(pixels).toEqual([16, 17, 19, 255])
  await profile.call('settings.set', { app_light_theme: 'ade:linen' })
  const app = await profile.call('settings.appearance', {})
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--background').trim()))
    .toBe(app.tokens.background)
  expect(await pixels()).toEqual([16, 17, 19, 255])
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('combobox', { name: 'Terminal to customize', exact: true }).selectOption(terminalId)
  await page
    .getByRole('group', { name: 'Override mode', exact: true })
    .getByRole('button', { name: 'Use profile theme', exact: true })
    .click()
  await expect
    .poll(
      async () =>
        (await profile.call('terminal.appearance.get', { workspace_id: record.workspace_id, terminal_id: terminalId }))
          .provenance,
    )
    .toBe('profile')
  await page.getByRole('link', { name: 'Back to workspace' }).click()
  const { r, g, b } = app.terminal.background
  await expect.poll(pixels).toEqual([r, g, b, 255])
  await profile.call('settings.set', { terminal_binding: { kind: 'fixed', theme_id: 'ade:graphite' } })
  await expect.poll(pixels).toEqual([16, 17, 19, 255])
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('combobox', { name: 'Terminal to customize', exact: true }).selectOption(terminalId)
  const overrideMode = page.getByRole('group', { name: 'Override mode', exact: true })
  await overrideMode.getByRole('button', { name: 'Follow app', exact: true }).click()
  await expect(page.getByText('Terminal override: Linen (light).', { exact: true })).toBeVisible()
  await overrideMode.getByRole('button', { name: 'Separate pair', exact: true }).click()
  await page
    .getByRole('group', { name: 'Light override palette', exact: true })
    .getByRole('button', { name: 'Chalk', exact: true })
    .click()
  await expect(page.getByText('Terminal override: Chalk (light).', { exact: true })).toBeVisible()
  await page
    .getByRole('group', { name: 'Dark override palette', exact: true })
    .getByRole('button', { name: 'Carbon', exact: true })
    .click()
  await expect
    .poll(
      async () =>
        (await profile.call('terminal.appearance.get', { workspace_id: record.workspace_id, terminal_id: terminalId }))
          .binding,
    )
    .toEqual({ kind: 'paired', light: 'ade:chalk', dark: 'ade:carbon' })
  await profile.call('settings.set', { appearance: 'dark' })
  await expect(page.getByText('Terminal override: Carbon (dark).', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Back to workspace' }).click()
  const paired = await profile.call('terminal.appearance.get', {
    workspace_id: record.workspace_id,
    terminal_id: terminalId,
  })
  await expect
    .poll(pixels)
    .toEqual([paired.appearance.background.r, paired.appearance.background.g, paired.appearance.background.b, 255])
  const after = await profile.call('runtime.status', {})
  expect(after.runtime_instance).toBe(before.runtime_instance)
  expect(after.terminals).toMatchObject(
    (before.terminals as Array<{ metrics: { run_id: string; shell_pid: number } }>).map(({ metrics }) => ({
      metrics: { run_id: metrics.run_id, shell_pid: metrics.shell_pid },
    })),
  )
})

test('terminal override controls explain a stale edit and allow retry after refresh', async ({ profile, desktop }) => {
  await profile.call('settings.set', { appearance: 'light' })
  const { catalog } = await profile.call('catalog.get', {})
  const terminal = catalog.terminals[0]!
  const { app, window: page } = await desktop.launch(profile)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('combobox', { name: 'Terminal to customize', exact: true }).selectOption(terminal.id)
  await expect(page.getByText('Using profile theme: Chalk (light).', { exact: true })).toBeVisible()
  const bridge = await app.evaluate(
    ({ app }) => app.getAppMetrics().find((metric) => metric.name === 'ADE stream bridge')?.pid,
  )
  expect(bridge).toBeDefined()
  // Delay the real settings feed while keeping the public command connection live.
  process.kill(bridge!, 'SIGSTOP')
  try {
    await profile.call('settings.set', { app_light_theme: 'ade:linen' })
    const mode = page.getByRole('group', { name: 'Override mode', exact: true })
    await mode.getByRole('button', { name: 'Fixed theme', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: /Appearance changed from revision/ })).toBeVisible()
    expect(
      (await profile.call('terminal.appearance.get', { workspace_id: terminal.workspace_id, terminal_id: terminal.id }))
        .provenance,
    ).toBe('profile')
    await expect(page.getByText('Using profile theme: Linen (light).', { exact: true })).toBeVisible()
    await mode.getByRole('button', { name: 'Fixed theme', exact: true }).click()
    await expect(page.getByText('Terminal override: Linen (light).', { exact: true })).toBeVisible()
    expect(
      (await profile.call('terminal.appearance.get', { workspace_id: terminal.workspace_id, terminal_id: terminal.id }))
        .provenance,
    ).toBe('terminal')
  } finally {
    process.kill(bridge!, 'SIGCONT')
  }
})

test('terminal override controls explain a missing definition and reset it without losing the terminal', async ({
  profile,
  desktop,
}) => {
  await profile.call('settings.set', { appearance: 'light' })
  const { catalog } = await profile.call('catalog.get', {})
  const terminal = catalog.terminals[0]!
  const database = new DatabaseSync(join(profile.dataDirectory, 'sessions.sqlite'))
  // Coordinate fixture writes with the live daemon's short transactions.
  database.exec('PRAGMA busy_timeout = 5000')
  database
    .prepare("UPDATE terminals SET data=json_set(data,'$.appearance_binding',json(?)) WHERE id=?")
    .run(JSON.stringify({ kind: 'fixed', theme_id: 'missing:terminal' }), terminal.id)
  database.close()
  await profile.restartDaemon('kill')
  const resolved = await profile.call('terminal.appearance.get', {
    workspace_id: terminal.workspace_id,
    terminal_id: terminal.id,
  })
  expect(resolved).toMatchObject({
    selected_id: 'missing:terminal',
    resolved_id: 'ade:chalk',
    mode: 'light',
    fallback: true,
    provenance: 'terminal',
  })
  const { window: page } = await desktop.launch(profile)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('combobox', { name: 'Terminal to customize', exact: true }).selectOption(terminal.id)
  const warning = page.getByText('Selected theme missing:terminal is unavailable for this mode. Using Chalk.', {
    exact: true,
  })
  await expect(warning).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Override palette', exact: true })).toHaveValue('missing:terminal')
  await page
    .getByRole('group', { name: 'Override mode', exact: true })
    .getByRole('button', { name: 'Use profile theme', exact: true })
    .click()
  await expect(warning).not.toBeVisible()
  expect(
    await profile.call('terminal.appearance.get', { workspace_id: terminal.workspace_id, terminal_id: terminal.id }),
  ).toMatchObject({ terminal_id: terminal.id, provenance: 'profile', fallback: false })
})

test('terminal color controls apply literal cursor text and selection colors and restore theme values', async ({
  profile,
  desktop,
}) => {
  await profile.call('settings.set', { appearance: 'dark' })
  const { window } = await desktop.launch(profile)
  await window.getByRole('button', { name: /^New terminal/ }).click()
  const terminal = window.locator('[data-terminal]').first()
  const canvas = terminal.locator('canvas')
  await expect(canvas).toBeVisible()
  const id = (await terminal.getAttribute('data-terminal'))!
  const { catalog } = await profile.call('catalog.get', {})
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByLabel('Cursor text', { exact: true }).selectOption('literal')
  await window.getByLabel('Cursor text color', { exact: true }).fill('#ee22aa')
  await window.getByLabel('Selection foreground', { exact: true }).selectOption('cell-foreground')
  await window.getByLabel('Selection background', { exact: true }).selectOption('literal')
  await window.getByLabel('Selection background color', { exact: true }).fill('#123456')
  await window.getByRole('button', { name: 'Apply terminal colors', exact: true }).click()
  await expect
    .poll(async () => (await profile.call('settings.appearance', {})).terminal)
    .toMatchObject({
      cursor_text: { r: 238, g: 34, b: 170 },
      selection_foreground: 'cell-foreground',
      selection_background: { r: 18, g: 52, b: 86 },
    })
  await window.getByRole('link', { name: 'Back to workspace' }).click()
  const sent = await profile.cli(
    'terminal',
    'send',
    catalog.workspaces[0]!.id,
    id,
    "printf '\\033]12;#123456\\007\\033[2J\\033[H\\033[31;44;7mANSI \\033[38;2;20;30;40;48;2;60;70;80;7mMMMM界éfi\\033[0m\\033[1;1H\\033[2 q'; read",
  )
  expect(sent.code, sent.stderr).toBe(0)
  await terminal.locator('textarea').focus()
  const countColor = (color: number[]) =>
    canvas.evaluate((node, expected) => {
      const element = node as HTMLCanvasElement
      const bytes = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data
      let count = 0
      for (let i = 0; i < bytes.length; i += 4)
        if (bytes[i] === expected[0] && bytes[i + 1] === expected[1] && bytes[i + 2] === expected[2]) count++
      return count
    }, color)
  const cursorTextVisible = () =>
    canvas.evaluate((node) => {
      const bytes = (node as HTMLCanvasElement)
        .getContext('2d')!
        .getImageData(0, 0, (node as HTMLCanvasElement).width, (node as HTMLCanvasElement).height).data
      const fill = [18, 52, 86]
      const text = [238, 34, 170]
      const delta = text.map((channel, index) => channel - fill[index]!)
      const length = delta.reduce((sum, channel) => sum + channel * channel, 0)
      for (let offset = 0; offset < bytes.length; offset += 4) {
        const alpha =
          delta.reduce((sum, channel, index) => sum + (bytes[offset + index]! - fill[index]!) * channel, 0) / length
        if (alpha < 0.08 || alpha > 1) continue
        if (delta.every((channel, index) => Math.abs(bytes[offset + index]! - (fill[index]! + channel * alpha)) < 20)) {
          return true
        }
      }
      return false
    })
  await expect.poll(cursorTextVisible).toBe(true)
  const box = (await canvas.boundingBox())!
  await window.mouse.move(box.x + 5, box.y + 10)
  await window.mouse.down()
  await window.mouse.move(box.x + 45, box.y + 10, { steps: 5 })
  await window.mouse.up()
  await expect.poll(() => countColor([18, 52, 86])).toBeGreaterThan(50)
  await expect.poll(() => countColor([60, 70, 80])).toBeGreaterThan(0)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  for (const label of ['Cursor text', 'Selection foreground', 'Selection background'])
    await window.getByLabel(label, { exact: true }).selectOption('theme')
  await window.getByRole('button', { name: 'Apply terminal colors', exact: true }).click()
  await expect.poll(async () => (await profile.call('settings.get', {})).settings.terminal_color_overrides).toEqual({})
})

test('terminal contrast controls repaint existing truecolor output without changing terminal identity or bytes', async ({
  profile,
  desktop,
}) => {
  const { window } = await desktop.launch(profile)
  await window.getByRole('button', { name: /^New terminal/ }).click()
  const terminal = window.locator('[data-terminal]').first()
  const canvas = terminal.locator('canvas')
  await expect(canvas).toBeVisible()
  const id = (await terminal.getAttribute('data-terminal'))!
  const { catalog } = await profile.call('catalog.get', {})
  const sent = await profile.cli(
    'terminal',
    'send',
    catalog.workspaces[0]!.id,
    id,
    "printf '\\033[2J\\033[H\\033[?25l\\033[38;2;0;0;0;48;2;0;0;0mMMMM'; read",
  )
  expect(sent.code, sent.stderr).toBe(0)
  const whitePixels = () =>
    canvas.evaluate((node) => {
      const element = node as HTMLCanvasElement
      if (element.width === 0 || element.height === 0) return null
      const data = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data
      let count = 0
      for (let i = 0; i < data.length; i += 4)
        if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255) count++
      return count
    })
  await expect.poll(whitePixels).toBe(0)
  const source = await profile.call('settings.appearance', {})
  const before = await profile.call('runtime.status', {})
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByLabel('Terminal minimum contrast', { exact: true }).fill('22')
  await expect(window.getByRole('button', { name: 'Apply terminal contrast', exact: true })).toBeDisabled()
  await window.getByLabel('Terminal minimum contrast', { exact: true }).fill('21')
  await window.getByRole('button', { name: 'Apply terminal contrast', exact: true }).click()
  await expect.poll(async () => (await profile.call('settings.get', {})).settings.terminal_minimum_contrast).toBe(21)
  await window.getByRole('link', { name: 'Back to workspace' }).click()
  await expect.poll(whitePixels).toBeGreaterThan(0)
  const corrected = await profile.call('settings.appearance', {})
  expect(corrected.tokens).toEqual(source.tokens)
  expect(corrected.terminal).toMatchObject({
    foreground: source.terminal.foreground,
    background: source.terminal.background,
    palette: source.terminal.palette,
  })
  expect((await profile.call('runtime.status', {})).terminals).toMatchObject(
    (before.terminals as Array<{ metrics: { run_id: string; shell_pid: number; terminal_bytes: number } }>).map(
      ({ metrics }) => ({
        metrics: { run_id: metrics.run_id, shell_pid: metrics.shell_pid, terminal_bytes: metrics.terminal_bytes },
      }),
    ),
  )
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByLabel('Terminal minimum contrast', { exact: true }).fill('1')
  await window.getByRole('button', { name: 'Apply terminal contrast', exact: true }).click()
  await expect.poll(async () => (await profile.call('settings.get', {})).settings.terminal_minimum_contrast).toBe(1)
  await window.getByRole('link', { name: 'Back to workspace' }).click()
  await expect.poll(whitePixels).toBe(0)
})

test('terminal bold controls repaint indexed and truecolor text while preserving the running terminal', async ({
  profile,
  desktop,
}) => {
  const { window } = await desktop.launch(profile)
  await window.getByRole('button', { name: /^New terminal/ }).click()
  const terminal = window.locator('[data-terminal]').first()
  const canvas = terminal.locator('canvas')
  await expect(canvas).toBeVisible()
  const id = (await terminal.getAttribute('data-terminal'))!
  const { catalog } = await profile.call('catalog.get', {})
  const sent = await profile.cli(
    'terminal',
    'send',
    catalog.workspaces[0]!.id,
    id,
    "printf '\\033[2J\\033[H\\033[?25l\\033]4;1;#640000\\007\\033]4;9;#00c800\\007\\033[1;31mMMMM\\033[38;2;100;0;0mMMMM'; read",
  )
  expect(sent.code, sent.stderr).toBe(0)
  const pixels = (rgb: number[]) =>
    canvas.evaluate((node, color) => {
      const element = node as HTMLCanvasElement
      if (element.width === 0 || element.height === 0) return null
      const data = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data
      let count = 0
      for (let i = 0; i < data.length; i += 4)
        if (data[i] === color[0] && data[i + 1] === color[1] && data[i + 2] === color[2]) count++
      return count
    }, rgb)
  await expect.poll(() => pixels([100, 0, 0])).toBeGreaterThan(0)
  const before = await profile.call('runtime.status', {})
  const source = await profile.call('settings.appearance', {})
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByLabel('Terminal bold colors', { exact: true }).selectOption('bright')
  await window.getByRole('button', { name: 'Apply bold colors', exact: true }).click()
  await expect.poll(async () => (await profile.call('settings.get', {})).settings.terminal_bold_color).toBe('bright')
  await window.getByRole('link', { name: 'Back to workspace' }).click()
  await expect.poll(() => pixels([0, 200, 0])).toBeGreaterThan(0)
  await expect.poll(() => pixels([100, 0, 0])).toBeGreaterThan(0)

  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByLabel('Terminal bold colors', { exact: true }).selectOption('custom')
  await window.getByLabel('Bold text color', { exact: true }).fill('#ee22aa')
  await window.getByRole('button', { name: 'Apply bold colors', exact: true }).click()
  await expect
    .poll(async () => (await profile.call('settings.get', {})).settings.terminal_bold_color)
    .toEqual({ r: 238, g: 34, b: 170 })
  await window.getByRole('link', { name: 'Back to workspace' }).click()
  await expect.poll(() => pixels([238, 34, 170])).toBeGreaterThan(0)
  await expect.poll(() => pixels([100, 0, 0])).toBe(0)
  await expect.poll(() => pixels([0, 200, 0])).toBe(0)

  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByLabel('Terminal bold colors', { exact: true }).selectOption('inherit')
  await window.getByRole('button', { name: 'Apply bold colors', exact: true }).click()
  await expect.poll(async () => (await profile.call('settings.get', {})).settings.terminal_bold_color).toBe('inherit')
  await window.getByRole('link', { name: 'Back to workspace' }).click()
  await expect.poll(() => pixels([100, 0, 0])).toBeGreaterThan(0)
  await expect.poll(() => pixels([0, 200, 0])).toBe(0)
  await expect.poll(() => pixels([238, 34, 170])).toBe(0)
  const restored = await profile.call('settings.appearance', {})
  expect(restored.tokens).toEqual(source.tokens)
  expect(restored.terminal).toEqual({ ...source.terminal, revision: source.terminal.revision + 3 })
  expect((await profile.call('runtime.status', {})).terminals).toMatchObject(
    (before.terminals as Array<{ metrics: { run_id: string; shell_pid: number; terminal_bytes: number } }>).map(
      ({ metrics }) => ({
        metrics: { run_id: metrics.run_id, shell_pid: metrics.shell_pid, terminal_bytes: metrics.terminal_bytes },
      }),
    ),
  )
})

test('terminal readability policies survive desktop relaunch and repaint recovered output', async ({
  profile,
  desktop,
}) => {
  const running = await desktop.launch(profile)
  const { window } = running
  await window.getByRole('button', { name: /^New terminal/ }).click()
  const terminal = window.locator('[data-terminal]').first()
  const id = (await terminal.getAttribute('data-terminal'))!
  const { catalog } = await profile.call('catalog.get', {})
  const sent = await profile.cli(
    'terminal',
    'send',
    catalog.workspaces[0]!.id,
    id,
    "printf '\\033[2J\\033[H\\033[?25l\\033[1;38;2;100;0;0;48;2;0;0;0mMMMM'; read",
  )
  expect(sent.code, sent.stderr).toBe(0)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByLabel('Terminal minimum contrast', { exact: true }).fill('21')
  await window.getByLabel('Terminal bold colors', { exact: true }).selectOption('custom')
  await window.getByLabel('Bold text color', { exact: true }).fill('#000000')
  await window.getByRole('button', { name: 'Apply bold colors', exact: true }).click()
  await expect
    .poll(async () => (await profile.call('settings.get', {})).settings.terminal_bold_color)
    .toEqual({ r: 0, g: 0, b: 0 })
  await expect(window.getByLabel('Terminal minimum contrast', { exact: true })).toHaveValue('21')
  await window.getByRole('button', { name: 'Apply terminal contrast', exact: true }).click()
  await expect.poll(async () => (await profile.call('settings.get', {})).settings.terminal_minimum_contrast).toBe(21)
  await window.getByRole('link', { name: 'Back to workspace' }).click()
  const before = await profile.call('runtime.status', {})
  await desktop.quit(running)
  const restored = await desktop.launch(profile)
  const canvas = restored.window.locator(`[data-terminal="${id}"] canvas`)
  await expect(canvas).toBeVisible()
  await expect
    .poll(() =>
      canvas.evaluate((node) => {
        const element = node as HTMLCanvasElement
        if (!element.width || !element.height) return null
        const data = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data
        let count = 0
        for (let i = 0; i < data.length; i += 4)
          if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255) count++
        return count
      }),
    )
    .toBeGreaterThan(0)
  expect((await profile.call('runtime.status', {})).terminals).toMatchObject(
    (before.terminals as Array<{ metrics: { run_id: string; shell_pid: number; terminal_bytes: number } }>).map(
      ({ metrics }) => ({
        metrics: { run_id: metrics.run_id, shell_pid: metrics.shell_pid, terminal_bytes: metrics.terminal_bytes },
      }),
    ),
  )
  await restored.window.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(restored.window.getByLabel('Terminal bold colors', { exact: true })).toHaveValue('custom')
  await expect(restored.window.getByLabel('Bold text color', { exact: true })).toHaveValue('#000000')
  await expect(restored.window.getByLabel('Terminal minimum contrast', { exact: true })).toHaveValue('21')
})

test('syntax settings choose fixed and paired palettes independently and survive relaunch', async ({
  profile,
  desktop,
}) => {
  await profile.call('settings.set', { appearance: 'light' })
  const source = await profile.call('settings.appearance', {})
  const running = await desktop.launch(profile)
  const { window } = running
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByLabel('Syntax theme mode', { exact: true }).selectOption('fixed')
  await window.getByLabel('Fixed syntax theme', { exact: true }).selectOption('ade:carbon')
  await window.getByRole('button', { name: 'Apply syntax theme', exact: true }).click()
  await expect(window.getByText('Saved syntax theme: Carbon (dark).', { exact: true })).toBeVisible()
  await expect
    .poll(() => window.evaluate(() => document.documentElement.style.getPropertyValue('--ade-code-keyword')))
    .toBe('#E6B66D')
  const fixed = await profile.call('settings.appearance', {})
  expect(fixed.tokens).toEqual(source.tokens)
  expect(fixed.terminal).toEqual({ ...source.terminal, revision: source.revision + 1 })
  await window.getByLabel('Syntax theme mode', { exact: true }).selectOption('paired')
  await window.getByLabel('Light syntax theme', { exact: true }).selectOption('ade:linen')
  await window.getByLabel('Dark syntax theme', { exact: true }).selectOption('ade:ink')
  await window.getByRole('button', { name: 'Apply syntax theme', exact: true }).click()
  await expect(window.getByText('Saved syntax theme: Linen (light).', { exact: true })).toBeVisible()
  await window.getByRole('button', { name: 'Dark — Graphite', exact: true }).click()
  await expect(window.getByText('Saved syntax theme: Ink (dark).', { exact: true })).toBeVisible()
  await desktop.quit(running)
  const restored = await desktop.launch(profile)
  await restored.window.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(restored.window.getByLabel('Syntax theme mode', { exact: true })).toHaveValue('paired')
  await expect(restored.window.getByLabel('Light syntax theme', { exact: true })).toHaveValue('ade:linen')
  await expect(restored.window.getByLabel('Dark syntax theme', { exact: true })).toHaveValue('ade:ink')
  await restored.window.getByLabel('Syntax theme mode', { exact: true }).selectOption('follow_app')
  await restored.window.getByRole('button', { name: 'Apply syntax theme', exact: true }).click()
  await expect(restored.window.getByText('Saved syntax theme: Graphite (dark).', { exact: true })).toBeVisible()
})

test('mounted desktop renders both symbolic Ghostty cursor fills from truecolor cells', async ({
  profile,
  desktop,
}) => {
  const foreground = '#0c2238'
  const background = '#5a646e'
  const themes = ['cell-foreground', 'cell-background'] as const
  for (const [index, cursor] of themes.entries()) {
    const id = 'user:cursor-fill-' + index
    const source = JSON.stringify({
      format: 'ade-theme',
      version: 1,
      id,
      name: 'Cursor fill ' + cursor,
      mode: 'dark',
      provenance: { kind: 'user' },
      terminal: {
        defaults: 'ade:graphite',
        tokens: {
          terminal: background,
          'terminal-foreground': foreground,
          'terminal-cursor': cursor,
          'terminal-cursor-text': 'cell-foreground',
        },
      },
    })
    await profile.call('themes.install', { items: [{ source, expected_revision: 0 }] })
  }
  await profile.call('settings.set', {
    appearance: 'dark',
    terminal_binding: { kind: 'fixed', theme_id: 'user:cursor-fill-0' },
  })
  const { window } = await desktop.launch(profile)
  await window.getByRole('button', { name: /^New terminal/ }).click()
  const terminal = window.locator('[data-terminal]:visible').first()
  const canvas = terminal.locator('canvas')
  await expect(canvas).toBeVisible()
  const terminalId = (await terminal.getAttribute('data-terminal'))!
  const { catalog } = await profile.call('catalog.get', {})
  const sent = await profile.cli(
    'terminal',
    'send',
    catalog.workspaces[0]!.id,
    terminalId,
    "printf '\\033[2J\\033[H\\033[38;2;12;34;56;48;2;90;100;110mA\\033[0m界éfi\\033[1;1H\\033[2 q\\033]112\\007'; read",
  )
  expect(sent.code, sent.stderr).toBe(0)
  const cursorPixel = () =>
    canvas.evaluate((node) => {
      const element = node as HTMLCanvasElement
      const scale = element.width / element.getBoundingClientRect().width
      const inset = Math.ceil(4 * scale) + 1
      return Array.from(element.getContext('2d')!.getImageData(inset, inset, 1, 1).data)
    })
  await terminal.locator('textarea').focus()
  const foregroundPixels = () =>
    canvas.evaluate((node) => {
      const element = node as HTMLCanvasElement
      const bytes = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data
      let count = 0
      for (let i = 0; i < bytes.length; i += 4)
        if (bytes[i] === 12 && bytes[i + 1] === 34 && bytes[i + 2] === 56) count++
      return count
    })
  await expect.poll(cursorPixel).toEqual([12, 34, 56, 255])
  const initialForegroundPixels = await foregroundPixels()
  await profile.call('settings.set', { terminal_binding: { kind: 'fixed', theme_id: 'user:cursor-fill-1' } })
  await expect.poll(cursorPixel).toEqual([90, 100, 110, 255])
  await expect.poll(foregroundPixels).toBeLessThan(initialForegroundPixels)
  await expect.poll(foregroundPixels).toBeGreaterThan(0)
  await profile.call('settings.set', { terminal_binding: { kind: 'fixed', theme_id: 'user:cursor-fill-0' } })
  await expect.poll(cursorPixel).toEqual([12, 34, 56, 255])
})
test('mounted desktop paints all 256 indexed palette colors to Canvas', async ({ profile, desktop }) => {
  const palette = Array.from({ length: 256 }, (_, index) => ({
    r: index,
    g: (index * 7) & 255,
    b: (index * 13) & 255,
  }))
  const paletteTokens = Object.fromEntries(
    palette.map(({ r, g, b }, index) => [
      'terminal-ansi-' + index,
      '#' + [r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join(''),
    ]),
  )
  const source = JSON.stringify({
    format: 'ade-theme',
    version: 1,
    id: 'user:indexed-pixel-test',
    name: 'Indexed pixel test',
    mode: 'dark',
    provenance: { kind: 'user' },
    terminal: { defaults: 'ade:graphite', tokens: paletteTokens },
  })
  await profile.call('themes.install', { items: [{ source, expected_revision: 0 }] })
  await profile.call('settings.set', {
    appearance: 'dark',
    terminal_binding: { kind: 'fixed', theme_id: 'user:indexed-pixel-test' },
  })
  const { window } = await desktop.launch(profile)
  await window.getByRole('button', { name: /^New terminal/ }).click()
  const terminal = window.locator('[data-terminal]:visible').first()
  const canvas = terminal.locator('canvas')
  await expect(canvas).toBeVisible()
  const terminalId = (await terminal.getAttribute('data-terminal'))!
  const { catalog } = await profile.call('catalog.get', {})
  const paletteOutput = Array.from(
    { length: 16 },
    (_, row) =>
      Array.from({ length: 16 }, (_, column) => String.raw`\033[48;5:${row * 16 + column}m  \033[0m`).join('') +
      String.raw`\033[0m\r\n`,
  ).join('')
  const sent = await profile.cli(
    'terminal',
    'send',
    catalog.workspaces[0]!.id,
    terminalId,
    `printf '\\033[2J\\033[H${paletteOutput}'; read`,
  )
  expect(sent.code, sent.stderr).toBe(0)
  const indexedPixelCount = () =>
    canvas.evaluate((node, colors) => {
      const element = node as HTMLCanvasElement
      const bytes = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data
      const expected = new Set(colors.map(({ r, g, b }) => (r << 16) | (g << 8) | b))
      const found = new Set<number>()
      for (let offset = 0; offset < bytes.length; offset += 4) {
        const rgb = (bytes[offset]! << 16) | (bytes[offset + 1]! << 8) | bytes[offset + 2]!
        if (expected.has(rgb)) found.add(rgb)
      }
      return found.size
    }, palette)
  await expect.poll(indexedPixelCount, { timeout: 15_000 }).toBe(256)
})
test('density controls preserve shell structure, focus and reachability at default and compact settings', async ({
  profile,
  desktop,
}) => {
  const { window } = await desktop.launch(profile)
  const density = window.getByLabel('Density', { exact: true })
  const shellBounds = () =>
    window.evaluate(() => {
      const selectors = ['main[aria-label="Workspace"]', '[aria-label="Projects"]', 'button[aria-label="Settings"]']
      return selectors.map((selector) => {
        const element = document.querySelector<HTMLElement>(selector)
        if (!element) return null
        const { x, y, width, height } = element.getBoundingClientRect()
        return { x, y, width, height }
      })
    })
  const expectShell = async () => {
    const bounds = await shellBounds()
    expect(bounds).toHaveLength(3)
    for (const box of bounds) {
      expect(box).not.toBeNull()
      expect(box!.width).toBeGreaterThan(0)
      expect(box!.height).toBeGreaterThan(0)
    }
    expect(bounds[1]!.x).toBeLessThan(bounds[0]!.x + bounds[0]!.width)
  }
  await expect(window.getByRole('main', { name: 'Workspace', exact: true })).toBeVisible()
  await expectShell()
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await density.click()
  await window.getByRole('option', { name: 'compact', exact: true }).click()
  await expect.poll(() => window.evaluate(() => document.documentElement.dataset.density)).toBe('compact')
  await expect
    .poll(() =>
      window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ade-section-gap').trim()),
    )
    .toBe('1rem')
  await expect(density).toBeFocused()
  await window.getByRole('link', { name: 'Back to workspace', exact: true }).click()
  await expectShell()
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await density.click()
  await window.getByRole('option', { name: 'default', exact: true }).click()
  await expect.poll(() => window.evaluate(() => document.documentElement.dataset.density)).toBe('default')
  await expect
    .poll(() =>
      window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ade-section-gap').trim()),
    )
    .toBe('1.5rem')
  await expect(density).toBeFocused()
  await window.getByRole('link', { name: 'Back to workspace', exact: true }).click()
  await expectShell()
})

test('typography settings apply to the profile and reattach the running terminal', async ({ profile, desktop }) => {
  await profile.call('settings.set', { appearance: 'dark' })
  const { window } = await desktop.launch(profile)
  await window.getByRole('button', { name: /^New terminal/ }).click()
  const terminal = window.locator('[data-terminal]:visible').first()
  const canvas = terminal.locator('canvas')
  await expect(canvas).toBeVisible()
  const terminalId = (await terminal.getAttribute('data-terminal'))!
  const originalCanvas = await canvas.elementHandle()
  const { catalog } = await profile.call('catalog.get', {})
  const workspaceId = catalog.workspaces[0]!.id
  const sent = await profile.cli(
    'terminal',
    'send',
    workspaceId,
    terminalId,
    "printf '\\033[2J\\033[H\\033[?25l\\033[38;2;255;255;255mPROFILE-PREFS-CONTINUITY'; read",
  )
  expect(sent.code, sent.stderr).toBe(0)
  const whitePixels = (target: typeof canvas) =>
    target.evaluate((node) => {
      const element = node as HTMLCanvasElement
      if (element.width === 0 || element.height === 0) return 0
      const bytes = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data
      let count = 0
      for (let offset = 0; offset < bytes.length; offset += 4)
        if (bytes[offset] === 255 && bytes[offset + 1] === 255 && bytes[offset + 2] === 255) count++
      return count
    })
  await expect.poll(() => whitePixels(canvas)).toBeGreaterThan(0)
  const initialWhitePixels = await whitePixels(canvas)
  type TerminalMetrics = {
    workspace: { terminal_id: string }
    metrics: {
      run_id: string
      shell_pid: number
      terminal_bytes: number
      shell_running: boolean
      pixel_size: [number, number]
    }
  }
  const runtimeTerminals = async () => (await profile.call('runtime.status', {})).terminals as TerminalMetrics[]
  await expect
    .poll(async () =>
      runtimeTerminals().then((items) => items.find((item) => item.workspace.terminal_id === terminalId)?.metrics),
    )
    .toMatchObject({ run_id: expect.any(String), shell_pid: expect.any(Number), shell_running: true })
  const beforeTerminal = (await runtimeTerminals()).find((item) => item.workspace.terminal_id === terminalId)!
  expect(beforeTerminal.metrics.terminal_bytes).toBeGreaterThan(0)
  const terminalGrid = async () => {
    const stream = TerminalStream.open(profile, workspaceId, terminalId)
    try {
      const snapshot = await stream.snapshot()
      const recovery = snapshot.terminal_recovery as {
        cols?: number
        rows?: number
        initial_cols?: number
        initial_rows?: number
        events?: Array<{ type: string; cols?: number; rows?: number }>
      }
      const resize = [...(recovery.events ?? [])].reverse().find((event) => event.type === 'resize')
      const cols = resize?.cols ?? recovery.cols ?? recovery.initial_cols
      const rows = resize?.rows ?? recovery.rows ?? recovery.initial_rows
      if (cols === undefined || rows === undefined) throw new Error('Terminal snapshot did not expose grid dimensions')
      return { cols, rows }
    } finally {
      stream.close()
    }
  }
  const initialGrid = await terminalGrid()

  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(window.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await window.getByLabel('UI font family', { exact: true }).fill('Inter Test UI')
  await window.getByRole('button', { name: 'Apply ui font family', exact: true }).click()
  const codeFamily = window.getByLabel('Code font family', { exact: true })
  await codeFamily.fill('Source Code Test')
  await window.getByRole('button', { name: 'Apply code font family', exact: true }).click()
  await window.getByLabel('UI font size', { exact: true }).fill('16')
  await window.getByRole('button', { name: 'Apply ui font size', exact: true }).click()
  await window.getByLabel('Code font size', { exact: true }).fill('18')
  await window.getByRole('button', { name: 'Apply code font size', exact: true }).click()
  await window.getByLabel('Density', { exact: true }).click()
  await window.getByRole('option', { name: 'compact', exact: true }).click()

  await window.getByLabel('Terminal font family', { exact: true }).fill('ADE Unavailable Mono 1234')
  await window.getByRole('button', { name: 'Apply terminal font family', exact: true }).click()
  await window.getByLabel('Terminal font size', { exact: true }).fill('16')
  await window.getByRole('button', { name: 'Apply terminal font size', exact: true }).click()
  await window.getByLabel('Terminal line height', { exact: true }).fill('1.55')
  await window.getByRole('button', { name: 'Apply terminal line height', exact: true }).click()
  await window.getByLabel('Terminal font kerning', { exact: true }).click()
  await window.getByRole('option', { name: 'none', exact: true }).click()
  await window.getByLabel('Terminal cursor shape', { exact: true }).click()
  await window.getByRole('option', { name: 'underline', exact: true }).click()
  const blink = window.getByRole('switch', { name: 'Terminal cursor blink', exact: true })
  await expect(blink).toBeEnabled()
  await blink.click()
  await expect(blink).not.toBeChecked()

  await codeFamily.fill('bad;font')
  await expect(
    window.getByText('Font family cannot contain control characters or CSS delimiters.', { exact: true }),
  ).toBeVisible()
  await expect(window.getByRole('button', { name: 'Apply code font family', exact: true })).toBeDisabled()
  await codeFamily.fill('Source Code Test')

  await expect
    .poll(async () => (await profile.call('settings.get', {})).settings)
    .toMatchObject({
      ui_font_family: 'Inter Test UI',
      ui_font_size: 16,
      code_font_family: 'Source Code Test',
      code_font_size: 18,
      terminal_font_family: 'ADE Unavailable Mono 1234',
      terminal_font_size: 16,
      density: 'compact',
      terminal_line_height: 1.55,
      terminal_font_kerning: 'none',
      terminal_cursor_shape: 'underline',
      terminal_cursor_blink: false,
    })
  await expect.poll(() => window.evaluate(() => document.documentElement.dataset.density)).toBe('compact')
  await expect
    .poll(() =>
      window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ade-ui-font-family').trim()),
    )
    .toBe('"Inter Test UI"')
  await expect
    .poll(() =>
      window.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--ade-code-font-family').trim(),
      ),
    )
    .toBe('"Source Code Test"')
  await expect
    .poll(() =>
      window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ade-ui-font-scale').trim()),
    )
    .toBe(String(16 / 13))
  await expect
    .poll(() =>
      window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ade-code-font-size').trim()),
    )
    .toBe('18px')
  await window.getByRole('link', { name: 'Back to workspace', exact: true }).click()
  const reattached = window.locator(`[data-terminal="${terminalId}"] canvas`)
  await expect(reattached).toBeVisible()
  await expect
    .poll(() =>
      originalCanvas!.evaluate(
        (node, id) => node === document.querySelector(`[data-terminal="${id}"] canvas`),
        terminalId,
      ),
    )
    .toBe(true)
  await expect.poll(() => whitePixels(reattached)).toBeGreaterThan(initialWhitePixels)
  await expect.poll(() => terminalGrid()).not.toEqual(initialGrid)

  const afterStatus = await profile.call('runtime.status', {})
  const afterTerminal = (afterStatus.terminals as TerminalMetrics[]).find(
    (item) => item.workspace.terminal_id === terminalId,
  )!
  expect(afterTerminal.metrics).toMatchObject({
    run_id: beforeTerminal.metrics.run_id,
    shell_pid: beforeTerminal.metrics.shell_pid,
    terminal_bytes: beforeTerminal.metrics.terminal_bytes,
    shell_running: true,
    pixel_size: [expect.any(Number), expect.any(Number)],
  })
  expect(afterTerminal.metrics.pixel_size.every((size) => size > 0)).toBe(true)
})

test('accessibility preferences persist and explicit overrides reach the renderer', async ({ profile, desktop }) => {
  const { window } = await desktop.launch(profile)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()

  for (const label of ['High contrast', 'Reduced transparency', 'Differentiate without color']) {
    await window.getByLabel(label, { exact: true }).click()
    await window.getByRole('option', { name: 'On', exact: true }).click()
  }

  await expect
    .poll(async () => (await profile.call('settings.get', {})).settings)
    .toMatchObject({ high_contrast: 'on', reduced_transparency: 'on', differentiate_without_color: 'on' })
  await expect.poll(() => window.evaluate(() => document.documentElement.hasAttribute('data-high-contrast'))).toBe(true)
  await expect
    .poll(() => window.evaluate(() => document.documentElement.hasAttribute('data-reduced-transparency')))
    .toBe(true)
  await expect
    .poll(() => window.evaluate(() => document.documentElement.hasAttribute('data-differentiate-without-color')))
    .toBe(true)

  await window.getByLabel('High contrast', { exact: true }).click()
  await window.getByRole('option', { name: 'Off', exact: true }).click()
  await expect.poll(async () => (await profile.call('settings.get', {})).settings.high_contrast).toBe('off')
  await expect
    .poll(() => window.evaluate(() => document.documentElement.hasAttribute('data-high-contrast')))
    .toBe(false)
})
