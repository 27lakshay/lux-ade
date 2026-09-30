import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { InlineConfig } from '../../apps/desktop/node_modules/vite/dist/node/index.js'
import { expect, test } from './fixtures'
import { repositoryRoot } from '../protocol/fixtures/environment'

test('Vite reload paints the current committed palette before reconnecting', async ({ profile, desktop }) => {
  test.setTimeout(120_000)
  const directory = join(repositoryRoot, 'apps/desktop')
  const requireDesktop = createRequire(join(directory, 'package.json'))
  const vite = (await import(
    pathToFileURL(requireDesktop.resolve('vite')).href
  )) as typeof import('../../apps/desktop/node_modules/vite/dist/node/index.js')
  const previousScan = process.env.ADE_REACT_SCAN
  const previousGrab = process.env.ADE_REACT_GRAB
  process.env.ADE_REACT_SCAN = '0'
  process.env.ADE_REACT_GRAB = '0'
  const loaded = await vite.loadConfigFromFile(
    { command: 'serve', mode: 'development' },
    join(directory, 'electron.vite.config.ts'),
  )
  const renderer = (loaded!.config as { renderer: InlineConfig }).renderer
  const server = await vite.createServer({
    ...renderer,
    root: join(directory, 'src/renderer'),
    configFile: false,
    cacheDir: join(profile.root, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  })
  try {
    await server.listen()
    await profile.call('settings.set', { appearance: 'dark', app_dark_theme: 'ade:carbon' })
    const running = await desktop.launch(profile, { ELECTRON_RENDERER_URL: server.resolvedUrls!.local[0]! })
    const { window } = running
    await expect(window.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
    await profile.call('settings.set', { app_dark_theme: 'ade:midnight' })
    const appearance = await profile.call('settings.appearance', {})
    const expected = appearance.tokens.background!
    await expect
      .poll(() =>
        window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--background').trim()),
      )
      .toBe(expected)
    await profile.killDaemon()
    await window.reload({ waitUntil: 'domcontentloaded' })
    await expect
      .poll(() =>
        window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--background').trim()),
      )
      .toBe(expected)
    const boot = await window.evaluate(
      () => (performance.getEntriesByName('ade:appearance-ready')[0] as PerformanceMark)?.detail,
    )
    expect(boot).toEqual({
      mode: 'dark',
      background: expected,
      codeKeyword: appearance.syntax.dark_palette.tokens['syntax-keyword'],
    })
    await desktop.quit(running)
  } finally {
    await server.close()
    if (previousScan === undefined) delete process.env.ADE_REACT_SCAN
    else process.env.ADE_REACT_SCAN = previousScan
    if (previousGrab === undefined) delete process.env.ADE_REACT_GRAB
    else process.env.ADE_REACT_GRAB = previousGrab
  }
})
