import { expect, test } from 'vitest'
import { APP_THEME_ROLES } from '../../../shared/app-theme-roles'
import builtins from '../../../../../../crates/ade-core/src/appearance/builtin.json'
import { deriveSimpleTheme } from './simple-theme'

const appRoles = APP_THEME_ROLES.filter(
  (role) => role !== 'terminal' && !role.startsWith('terminal-') && !role.startsWith('syntax-'),
)
const input = { id: 'user:generated', name: 'Generated', mode: 'dark' as const, surface: '#20242a', accent: '#5479bd' }

test('derives every app role deterministically without editing bundled source', () => {
  const before = JSON.stringify(builtins.graphite)
  const first = deriveSimpleTheme(input)
  const second = deriveSimpleTheme(input)
  expect(first).toEqual(second)
  expect(Object.keys(first.app!.tokens).sort()).toEqual([...appRoles].sort())
  expect(Object.values(first.app!.tokens)).toEqual(expect.arrayContaining([input.surface, input.accent]))
  expect(Object.values(first.app!.tokens).every((value) => /^#[0-9a-f]{6}$/.test(value))).toBe(true)
  expect(first.app!.tokens).not.toHaveProperty('terminal')
  expect(first.app!.defaults).toBeNull()
  expect(first.terminal).toBeNull()
  expect(first.syntax).toBeNull()
  expect(first.provenance.kind).toBe('user')
  expect(JSON.stringify(builtins.graphite)).toBe(before)
})

test('uses the requested light/dark mode and explicit mode semantics', () => {
  const light = deriveSimpleTheme({ ...input, mode: 'light', surface: '#ffffff' })
  const dark = deriveSimpleTheme({ ...input, mode: 'dark', surface: '#101113' })
  expect(light.mode).toBe('light')
  expect(dark.mode).toBe('dark')
  expect(light.app!.tokens.attention).not.toBe(dark.app!.tokens.attention)
  expect(light.app!.tokens.background).toBe('#ffffff')
  expect(dark.app!.tokens.background).toBe('#101113')
  expect(light.app!.tokens['chart-2']).toBe(light.app!.tokens.success)
  expect(light.app!.tokens['chart-3']).toBe(light.app!.tokens.attention)
  expect(light.app!.tokens['chart-4']).toBe(light.app!.tokens.destructive)
})

test('normalizes equivalent CSS colors and clips valid wide-gamut inputs across all roles', () => {
  const shorthand = deriveSimpleTheme({ ...input, surface: '#fff', accent: '#2456a6' })
  const expanded = deriveSimpleTheme({ ...input, surface: ' rgb(100% 100% 100%) ', accent: '#2456a6' })
  expect(shorthand).toEqual(expanded)

  const wideGamut = deriveSimpleTheme({
    ...input,
    surface: 'color(display-p3 1 0.2 0.1)',
    accent: 'oklch(60% 0.7 200)',
  })
  for (const value of Object.values(wideGamut.app!.tokens)) expect(value).toMatch(/^#[0-9a-f]{6}$/)
  expect(wideGamut.app!.tokens.background).not.toBe('#ffffff')
})

test.each([
  ['not-a-color', 'invalid'],
  ['rgba(10 20 30 / 50%)', 'translucent'],
  ['#ffffff80', 'alpha hex'],
  ['var(--surface)', 'unresolved variable'],
  ['currentColor', 'backdrop-dependent'],
  ['rgb(1e999 0 0)', 'non-finite channel'],
  ['', 'empty'],
])('rejects %s surface input (%s)', (surface) => {
  expect(() => deriveSimpleTheme({ ...input, surface })).toThrow(/Surface/)
})

test.each(['transparent', 'rgba(1 2 3 / 20%)', 'rgb(NaN 0 0)'])('rejects invalid accent input: %s', (accent) => {
  expect(() => deriveSimpleTheme({ ...input, accent })).toThrow(/Accent/)
})

test('returns independent editable draft objects', () => {
  const first = deriveSimpleTheme(input)
  const second = deriveSimpleTheme(input)
  first.app!.tokens.border = '#aabbcc'
  expect(second.app!.tokens.border).not.toBe('#aabbcc')
  expect(builtins.graphite.border).not.toBe('#aabbcc')
})
