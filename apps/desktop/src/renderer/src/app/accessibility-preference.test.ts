import { afterEach, expect, test } from 'vitest'
import './app.css'
import { applyAccessibilityPreferences, resolveAccessibilityPreference } from './accessibility-preference'

afterEach(() => {
  const root = document.documentElement
  root.classList.remove('dark')
  root.removeAttribute('data-high-contrast')
  root.removeAttribute('data-reduced-transparency')
  root.removeAttribute('data-differentiate-without-color')
  root.removeAttribute('style')
})

test('system follows available native signals while explicit choices override them', () => {
  expect(resolveAccessibilityPreference('system', true)).toBe(true)
  expect(resolveAccessibilityPreference('system', false)).toBe(false)
  expect(resolveAccessibilityPreference('system', null)).toBe(false)
  expect(resolveAccessibilityPreference('on', false)).toBe(true)
  expect(resolveAccessibilityPreference('off', true)).toBe(false)
})

test('applies resolved accessibility settings to semantic root attributes', () => {
  applyAccessibilityPreferences(
    { high_contrast: 'system', reduced_transparency: 'on', differentiate_without_color: 'off' },
    { highContrast: true, reducedTransparency: null, differentiateWithoutColor: true },
  )

  expect(document.documentElement.hasAttribute('data-high-contrast')).toBe(true)
  expect(document.documentElement.hasAttribute('data-reduced-transparency')).toBe(true)
  expect(document.documentElement.hasAttribute('data-differentiate-without-color')).toBe(false)
})

test.each([false, true])('strengthens focus and makes tinted surfaces opaque (dark=%s)', (dark) => {
  const root = document.documentElement
  root.classList.toggle('dark', dark)
  root.style.setProperty('--border', '#111111')
  root.style.setProperty('--input', '#222222')
  root.style.setProperty('--ring', '#333333')
  root.style.setProperty('--sidebar-border', '#444444')
  root.style.setProperty('--sidebar-ring', '#555555')
  root.setAttribute('data-high-contrast', '')
  root.setAttribute('data-reduced-transparency', '')

  const button = document.createElement('button')
  button.className = 'bg-destructive/30 backdrop-blur-xs'
  button.textContent = 'Remove'
  document.body.append(button)
  button.focus()

  const tokenProbe = document.createElement('span')
  tokenProbe.style.backgroundColor = 'var(--destructive-muted)'
  document.body.append(tokenProbe)
  const opaqueDestructive = getComputedStyle(tokenProbe).backgroundColor
  const fillProbe = document.createElement('button')
  fillProbe.className = 'dark:bg-input/30 dark:hover:bg-input/50'
  document.body.append(fillProbe)
  const inputFillWithHighContrast = getComputedStyle(fillProbe).backgroundColor
  const borderProbe = document.createElement('button')
  borderProbe.className = 'dark:border-input'
  document.body.append(borderProbe)
  const inputBorder = getComputedStyle(borderProbe).borderColor
  root.removeAttribute('data-high-contrast')
  const inputFillWithoutHighContrast = getComputedStyle(fillProbe).backgroundColor
  root.setAttribute('data-high-contrast', '')
  const foregroundProbe = document.createElement('span')
  foregroundProbe.style.color = 'var(--foreground)'
  document.body.append(foregroundProbe)
  const foregroundColor = getComputedStyle(foregroundProbe).color
  const rootStyle = getComputedStyle(root)
  const buttonStyle = getComputedStyle(button)

  expect(rootStyle.getPropertyValue('--ring').trim()).toBe(rootStyle.getPropertyValue('--foreground').trim())
  expect(rootStyle.getPropertyValue('--border').trim()).toBe(rootStyle.getPropertyValue('--foreground').trim())
  expect(rootStyle.getPropertyValue('--input').trim()).toBe('#222222')
  expect(rootStyle.getPropertyValue('--sidebar-border').trim()).toBe(
    rootStyle.getPropertyValue('--sidebar-foreground').trim(),
  )
  expect(rootStyle.getPropertyValue('--sidebar-ring').trim()).toBe(
    rootStyle.getPropertyValue('--sidebar-foreground').trim(),
  )
  expect(buttonStyle.outlineWidth).toBe('2px')
  expect(buttonStyle.outlineStyle).toBe('solid')
  expect(buttonStyle.backgroundColor).toBe(opaqueDestructive)
  expect(buttonStyle.backdropFilter).toBe('none')
  expect(inputFillWithHighContrast).toBe(inputFillWithoutHighContrast)
  expect(inputBorder).toBe(foregroundColor)

  button.remove()
  tokenProbe.remove()
  fillProbe.remove()
  borderProbe.remove()
  foregroundProbe.remove()
})
