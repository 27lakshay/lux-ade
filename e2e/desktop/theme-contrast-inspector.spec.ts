import { expect, test } from './fixtures'
async function renderedSurface(element: import('@playwright/test').Locator, base?: string): Promise<string> {
  return element.evaluate((node, underlay) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')!
    if (underlay) {
      context.fillStyle = underlay
      context.fillRect(0, 0, 1, 1)
    }
    context.fillStyle = getComputedStyle(node).backgroundColor
    context.fillRect(0, 0, 1, 1)
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data
    return '#' + [red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('')
  }, base)
}
async function renderedTextColor(element: import('@playwright/test').Locator): Promise<string> {
  return element.evaluate((node) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')!
    context!.fillStyle = getComputedStyle(node).color
    context!.fillRect(0, 0, 1, 1)
    const [red, green, blue] = context!.getImageData(0, 0, 1, 1).data
    return '#' + [red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('')
  })
}

async function computedSrgbChannels(
  element: import('@playwright/test').Locator,
  property: 'backgroundColor' | 'color',
) {
  return element.evaluate((node, key) => {
    const probe = document.createElement('span')
    const source = getComputedStyle(node)[key]
    probe.style.setProperty(
      key === 'backgroundColor' ? 'background-color' : 'color',
      `color-mix(in srgb, ${source} 100%, transparent 0%)`,
    )
    document.body.append(probe)
    const converted = getComputedStyle(probe)[key]
    probe.remove()
    const values =
      converted
        .match(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi)
        ?.slice(0, 3)
        .map(Number) ?? []
    const channels = converted.startsWith('color(srgb') ? values : values.map((channel) => channel / 255)
    return { source, converted, channels }
  }, property)
}
async function renderedDiffColor(
  host: import('@playwright/test').Locator,
  selector: string,
  property: 'color' | 'backgroundColor',
) {
  return host.evaluate(
    (element, input) => {
      const find = (root: ParentNode): Element | null => {
        const match = root.querySelector(input.selector)
        if (match) return match
        for (const child of root.querySelectorAll('*')) {
          if (child.shadowRoot) {
            const nested = find(child.shadowRoot)
            if (nested) return nested
          }
        }
        return null
      }
      const target = find(element)
      if (!target) return null
      if (input.property === 'color') {
        const color = getComputedStyle(target).color
        const channels = color
          .match(/\d+(?:\.\d+)?/g)!
          .slice(0, 3)
          .map((channel) => Number(channel))
        return '#' + channels.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')
      }
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      const context = canvas.getContext('2d')!
      context.fillStyle = getComputedStyle(element).backgroundColor
      context.fillRect(0, 0, 1, 1)
      const layers: Element[] = []
      for (let current: Element | null = target; current && current !== element;) {
        layers.push(current)
        if (current.parentElement) current = current.parentElement
        else {
          const root = current.getRootNode()
          current = root instanceof ShadowRoot ? root.host : null
        }
      }
      for (const layer of layers.reverse()) {
        context.fillStyle = getComputedStyle(layer)[input.property]
        context.fillRect(0, 0, 1, 1)
      }
      const [red, green, blue] = context.getImageData(0, 0, 1, 1).data
      return '#' + [red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('')
    },
    { selector, property },
  )
}
async function expectRenderedSurface(
  locator: import('@playwright/test').Locator,
  row: import('@playwright/test').Locator,
  base?: string,
) {
  const text = await row.textContent()
  const expected = text?.match(/surface: (#[0-9a-f]{6})/i)?.[1]
  expect(expected).toBeDefined()
  await expect.poll(() => renderedSurface(locator, base)).toBe(expected)
}
async function expectSurfaceWithinRoundingPixel(locator: import('@playwright/test').Locator, actual: string) {
  const text = await locator.textContent()
  const reported = text?.match(/surface: (#[0-9a-f]{6})/i)?.[1]
  expect(reported).toBeDefined()
  const actualChannels = actual
    .slice(1)
    .match(/../g)!
    .map((channel) => Number.parseInt(channel, 16))
  const reportedChannels = reported!
    .slice(1)
    .match(/../g)!
    .map((channel) => Number.parseInt(channel, 16))
  for (let index = 0; index < 3; index++)
    expect(Math.abs(actualChannels[index] - reportedChannels[index])).toBeLessThanOrEqual(1)
}

test('theme contrast inspection is read-only and follows a report into an editable draft field', async ({
  profile,
  desktop,
}) => {
  const importedSource = JSON.stringify({
    format: 'ade-theme',
    version: 1,
    id: 'user:inspector-imported',
    name: 'Imported inspection',
    mode: 'dark',
    provenance: {
      kind: 'imported',
      source: 'scratch fixture',
      source_version: '1',
      author: 'Fixture author',
      license: 'MIT',
    },
    app: { defaults: 'ade:graphite', tokens: { primary: '#234567' } },
    terminal: null,
    syntax: null,
  })
  await profile.call('themes.install', { items: [{ source: importedSource, expected_revision: 0 }] })
  const appearanceBefore = await profile.call('settings.appearance', {})
  const graphiteBefore = await profile.call('themes.inspect', { id: 'ade:graphite' })
  const importedBefore = await profile.call('themes.inspect', { id: 'user:inspector-imported' })
  const { window } = await desktop.launch(profile)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByRole('button', { name: 'Theme library', exact: true }).click()
  const library = window.getByRole('dialog')
  await library.getByLabel('Installed theme', { exact: true }).selectOption('ade:graphite')

  const report = library.getByTestId('contrast-row-app-primary-default')
  await expect(report).toBeVisible()
  await expect(library.getByText(/Diagnostics only, not accessibility certification/)).toBeVisible()
  await expect(report).toContainText('4.5 : 1')
  await expect(report).toContainText('primary-foreground')
  await expect(library.getByTestId('contrast-row-app-menu-focus')).toContainText('app / accent-foreground')
  const codeSelectionRow = library.getByTestId('contrast-row-code-selection')
  await expect(codeSelectionRow).toContainText('syntax / accent-foreground')
  await expect(library.getByTestId('contrast-row-diff-addition-syntax-default')).toContainText('Pierre diff preview')
  await expect(library.getByTestId('contrast-row-diff-deletion-syntax-number')).toContainText('syntax-number')
  await expect(library.getByTestId('contrast-row-diff-addition-word')).toContainText('25% mixed in sRGB')
  await expect(library.getByTestId('contrast-row-terminal-selected')).toContainText('selection background composited')
  const unavailableProductionDiff = library.getByTestId('contrast-row-diff-lines')
  await expect(unavailableProductionDiff).toContainText('unavailable')
  await expect(unavailableProductionDiff).toContainText(
    'measured Pierre preview does not certify a production consumer',
  )
  await expect(library.getByTestId('contrast-row-diff-selection')).toContainText('Browser-native text selection')
  expect(await profile.call('themes.inspect', { id: 'ade:graphite' })).toEqual(graphiteBefore)
  expect(await profile.call('settings.appearance', {})).toEqual(appearanceBefore)

  await library.getByLabel('Installed theme', { exact: true }).selectOption('user:inspector-imported')
  await expect(library.getByTestId('contrast-row-app-primary-default')).toBeVisible()
  expect(await profile.call('themes.inspect', { id: 'user:inspector-imported' })).toEqual(importedBefore)
  expect(await profile.call('settings.appearance', {})).toEqual(appearanceBefore)
  await library.getByLabel('Installed theme', { exact: true }).selectOption('ade:graphite')
  await codeSelectionRow.getByRole('button', { name: 'Create draft and edit role', exact: true }).click()
  const editor = window.getByRole('dialog').filter({ hasText: 'Edit theme draft' })
  const selectionRole = editor.locator('#theme-role-syntax-accent-foreground')
  await expect(selectionRole).toBeFocused()
  const definitionEditor = editor.locator('#theme-draft-json')
  const draftDefinition = JSON.parse(await definitionEditor.inputValue())
  const selectionAccent = draftDefinition.syntax.tokens.accent
  draftDefinition.mode = 'dark'
  draftDefinition.app.defaults = 'ade:graphite'
  draftDefinition.app.tokens = {
    foreground: '#00ffff',
    primary: '#202020',
    'primary-foreground': '#202020',
    secondary: '#ffff00',
    'secondary-foreground': '#717171',
    input: '#818b9a',
    muted: '#30343b',
    card: '#272a30',
    accent: '#ff00ff',
    'extension/role': '#ff0000',
  }
  await definitionEditor.fill(JSON.stringify(draftDefinition, null, 2))
  const draftReport = editor.getByTestId('contrast-row-app-primary-default')
  await expect(draftReport).toContainText('Contrast: 1.00 : 1')
  await expect(editor.getByTestId('contrast-row-app-menu-focus')).toContainText(
    'Source: Not declared; inherited resolved value',
  )
  await expect(editor.getByTestId('contrast-row-app-outline-hover')).toContainText('dark:hover:bg-input/50')
  const extension = editor.getByTestId('contrast-row-unmeasured-app-extension/role')
  await expect(extension).toContainText('Contrast unavailable')
  await expect(extension).toContainText('Unsupported token is retained without applying it')
  await expect(editor.getByTestId('contrast-diagnostic')).toContainText('warning — unsupported_extension')

  const darkSample = editor.locator('[data-appearance-preview="dark"]')
  const codeSample = darkSample.getByTestId('appearance-code')
  const diffSample = darkSample.getByTestId('appearance-diff')
  await expect.poll(() => codeSample.evaluate((element) => Boolean(element.querySelector('.shiki')))).toBe(true)
  await expect
    .poll(() => renderedDiffColor(diffSample, '[data-line][data-line-type="change-addition"]', 'backgroundColor'))
    .not.toBeNull()
  const codeSelectionStyle = await codeSample.evaluate((element) =>
    getComputedStyle(element).getPropertyValue('--ade-code-selection').trim(),
  )
  expect(codeSelectionStyle).toBe(selectionAccent)
  await expect(editor.getByTestId('contrast-row-code-selection')).toContainText('surface: ' + selectionAccent)
  const additionBg = await renderedDiffColor(
    diffSample,
    '[data-line][data-line-type="change-addition"]',
    'backgroundColor',
  )
  const additionFg = await renderedDiffColor(diffSample, '[data-line][data-line-type="change-addition"]', 'color')
  await expect(editor.getByTestId('contrast-row-diff-addition-syntax-default')).toContainText('surface: ' + additionBg)
  await expect(editor.getByTestId('contrast-row-diff-addition-syntax-default')).toContainText(
    'Foreground: ' + additionFg,
  )
  const additionGutterFg = await renderedDiffColor(
    diffSample,
    '[data-column-number][data-line-type="change-addition"]',
    'color',
  )
  await expect(editor.getByTestId('contrast-row-diff-addition-gutter')).toContainText('Foreground: ' + additionGutterFg)
  const additionWord = await renderedDiffColor(
    diffSample,
    '[data-line-type="change-addition"] [data-diff-span]',
    'backgroundColor',
  )
  await expectSurfaceWithinRoundingPixel(editor.getByTestId('contrast-row-diff-addition-word'), additionWord!)

  const outline = darkSample.getByTestId('appearance-outline')
  await outline.hover()
  const outlineBase = await outline.evaluate((element) => getComputedStyle(element).getPropertyValue('--card').trim())
  await expectRenderedSurface(outline, editor.getByTestId('contrast-row-app-outline-hover'), outlineBase)
  const toggle = darkSample.getByTestId('appearance-toggle')
  await toggle.hover()
  await expectRenderedSurface(toggle, editor.getByTestId('contrast-row-app-toggle-hover'))
  const secondary = darkSample.getByRole('button', { name: 'Secondary action' })
  await secondary.hover()
  const secondaryRow = editor.getByTestId('contrast-row-app-secondary-hover')
  await expectRenderedSurface(secondary, secondaryRow)
  const computedSecondary = await computedSrgbChannels(secondary, 'backgroundColor')
  expect(computedSecondary.channels).toHaveLength(3)
  expect(computedSecondary.channels[0]).toBeCloseTo(0.9520561114372627, 5)
  expect(computedSecondary.channels[1]).toBeCloseTo(1.0104382825805314, 5)
  expect(computedSecondary.channels[2]).toBeCloseTo(0.17672727575259722, 4)
  const computedHex =
    '#' +
    computedSecondary.channels
      .map((channel) =>
        Math.round(Math.max(0, Math.min(1, channel)) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  expect(computedHex).toBe('#f3ff2d')
  await expect(secondaryRow).toContainText('surface: ' + computedHex)
  const secondaryForeground = await renderedTextColor(secondary)
  await expect(secondaryRow).toContainText('Foreground: ' + secondaryForeground)
  const beforeSecondaryRatio = Number((await secondaryRow.innerText()).match(/Contrast: ([0-9.]+)/)?.[1])
  expect(beforeSecondaryRatio).toBeLessThan(4.5)
  await secondaryRow.getByRole('button', { name: 'Improve contrast in draft', exact: true }).click()
  await expect
    .poll(async () => Number((await secondaryRow.innerText()).match(/Contrast: ([0-9.]+)/)?.[1]))
    .toBeGreaterThanOrEqual(4.5)
  const afterSecondaryText = await secondaryRow.innerText()
  const afterSecondaryForeground = await renderedTextColor(secondary)
  expect(afterSecondaryText).toContain('Foreground: ' + afterSecondaryForeground)
  await draftReport.getByRole('button', { name: 'Improve contrast in draft', exact: true }).click()
  await expect.poll(() => draftReport.innerText()).not.toContain('Contrast: 1.00 : 1')
  const repairedText = await draftReport.innerText()
  const repairedRatio = Number(repairedText.match(/Contrast: ([0-9.]+)/)?.[1])
  expect(repairedRatio).toBeGreaterThanOrEqual(4.5)
  expect(repairedText).toMatch(/Source: #[0-9a-f]{6}; resolved: #[0-9a-f]{6}/i)

  const primaryRole = editor.locator('#theme-role-app-primary-foreground')
  await primaryRole.fill('not-a-color')
  const invalidDiagnostic = editor.getByRole('alert')
  await expect(invalidDiagnostic).toContainText('invalid_color')
  await expect(invalidDiagnostic).toContainText('/app/tokens/primary-foreground')
  await expect(draftReport).toHaveCount(0)
  expect(await profile.call('themes.inspect', { id: 'ade:graphite' })).toEqual(graphiteBefore)
  expect(await profile.call('settings.appearance', {})).toEqual(appearanceBefore)

  await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await profile.call('themes.inspect', { id: 'ade:graphite' })).toEqual(graphiteBefore)
  expect(await profile.call('themes.inspect', { id: 'user:inspector-imported' })).toEqual(importedBefore)
  expect(await profile.call('settings.appearance', {})).toEqual(appearanceBefore)
})
