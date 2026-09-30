import { expect, test } from './fixtures'

test('desktop theme conflict errors preserve the SDK code and details through IPC and the context bridge', async ({
  profile,
  desktop,
}) => {
  const source = JSON.stringify({
    format: 'ade-theme',
    version: 1,
    id: 'user:error-fixture',
    name: 'Error fixture',
    mode: 'dark',
    provenance: { kind: 'user' },
    terminal: { defaults: 'ade:graphite', tokens: {} },
  })
  await profile.call('themes.install', { items: [{ source, expected_revision: 0 }] })
  await profile.call('themes.rename', { id: 'user:error-fixture', name: 'Updated fixture', expected_revision: 1 })
  const { window: page } = await desktop.launch(profile)
  const sdk = await profile
    .call('themes.export', { id: 'user:error-fixture', expected_revision: 1 })
    .catch((error) => ({
      code: error.code,
      message: error.message,
      delivery: error.delivery,
      replied: error.replied,
      details: error.details,
    }))
  const renderer = await page.evaluate(async () => {
    try {
      await window.adeHost.themes.export('user:error-fixture', 1)
      return { unexpected: 'success' }
    } catch (error) {
      const value = error as { code: string; message: string; delivery: string; replied: boolean; details: unknown }
      return {
        code: value.code,
        message: value.message,
        delivery: value.delivery,
        replied: value.replied,
        details: value.details,
      }
    }
  })
  expect(renderer).toEqual(sdk)
  expect(renderer).toMatchObject({
    code: 'theme_conflict',
    replied: true,
    details: { id: 'user:error-fixture', expected: 1, current: 2 },
  })
})

test('desktop theme refusals and appearance conflicts keep structured details while local invalid input stays not-sent', async ({
  profile,
  desktop,
}) => {
  const { window: page } = await desktop.launch(profile)
  const before = await profile.call('settings.appearance', {})
  const refusals = await page.evaluate(async () => {
    const capture = async (run: () => Promise<unknown>) => {
      try {
        await run()
        return { unexpected: 'success' }
      } catch (error) {
        return error
      }
    }
    const saved = await window.adeHost.settings.get()
    await window.adeHost.settings.set({
      appearance: saved.appearance === 'light' ? 'dark' : 'light',
      expected_appearance_revision: saved.appearance_revision,
    })
    return {
      missing: await capture(() => window.adeHost.themes.inspect('user:missing')),
      protected: await capture(() => window.adeHost.themes.rename('ade:graphite', 'Changed', 0)),
      invalid: await capture(() => window.adeHost.themes.install([])),
      select: await capture(() =>
        window.adeHost.settings.set({
          appearance: saved.appearance,
          expected_appearance_revision: saved.appearance_revision,
        }),
      ),
      reset: await capture(() => window.adeHost.settings.resetAppearance(saved.appearance_revision)),
    }
  })
  expect(refusals.missing).toMatchObject({ code: 'theme_not_found', replied: true, details: { id: 'user:missing' } })
  expect(refusals.protected).toMatchObject({ code: 'theme_protected', replied: true, details: { id: 'ade:graphite' } })
  expect(refusals.invalid).toMatchObject({ code: 'invalid_request', delivery: 'not_sent', replied: false })
  const current = await profile.call('settings.appearance', {})
  const sdk = await profile
    .call('settings.appearance.reset', { expected_appearance_revision: before.revision })
    .catch((error) => ({ code: error.code, message: error.message, details: error.details }))
  expect(refusals.reset).toMatchObject(sdk)
  expect(refusals.select).toMatchObject({ code: 'appearance_conflict', replied: true })
  expect(await profile.call('settings.appearance', {})).toEqual(current)
})

test('malformed pack bridge requests and rejected native destinations retain machine-readable host errors', async ({
  profile,
  desktop,
}) => {
  const { app, window: page } = await desktop.launch(profile)
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, profile.root)
  const errors = await page.evaluate(async () => {
    const capture = async (run: () => Promise<unknown>) => {
      try {
        await run()
        return { unexpected: 'success' }
      } catch (error) {
        return error
      }
    }
    return {
      malformed: await capture(() =>
        window.adeHost.themes.exportPack({ id: 42 } as unknown as Parameters<
          typeof window.adeHost.themes.exportPack
        >[0]),
      ),
      destination: await capture(() => window.adeHost.themes.saveFile('ade:graphite', 0)),
    }
  })
  expect(errors.malformed).toMatchObject({ code: 'invalid_request', delivery: 'not_sent', replied: false })
  expect(errors.destination).toMatchObject({
    code: 'unavailable',
    delivery: 'not_sent',
    replied: false,
    message: 'Choose a regular theme file destination',
  })
})

test('per-terminal appearance conflicts preserve the daemon details and leave the terminal binding unchanged', async ({
  profile,
  desktop,
}) => {
  const { window: page } = await desktop.launch(profile)
  const { catalog } = await profile.call('catalog.get', {})
  const terminal = catalog.terminals[0]!
  const before = await profile.call('terminal.appearance.get', {
    workspace_id: terminal.workspace_id,
    terminal_id: terminal.id,
  })
  await profile.call('settings.set', { appearance: 'light' })
  const request = {
    workspace_id: terminal.workspace_id,
    terminal_id: terminal.id,
    binding: { kind: 'fixed' as const, theme_id: 'ade:graphite' },
    expected_appearance_revision: before.revision,
  }
  const sdk = await profile.call('terminal.appearance.set', request).catch((error) => ({
    code: error.code,
    message: error.message,
    delivery: error.delivery,
    replied: error.replied,
    details: error.details,
  }))
  const renderer = await page.evaluate(async (request) => {
    try {
      return await window.adeHost.terminals.setAppearance(
        request.workspace_id,
        request.terminal_id,
        request.binding,
        request.expected_appearance_revision,
      )
    } catch (error) {
      const value = error as { code: string; message: string; delivery: string; replied: boolean; details: unknown }
      return {
        code: value.code,
        message: value.message,
        delivery: value.delivery,
        replied: value.replied,
        details: value.details,
      }
    }
  }, request)
  expect(renderer).toEqual(sdk)
  expect(renderer).toMatchObject({ code: 'appearance_conflict', replied: true })
  expect(
    (await profile.call('terminal.appearance.get', { workspace_id: terminal.workspace_id, terminal_id: terminal.id }))
      .provenance,
  ).toBe('profile')
})
