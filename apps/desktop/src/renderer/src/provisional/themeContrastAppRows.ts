import { clampRgb, converter, interpolate, type Rgb } from 'culori'
import type { ThemeDraftPreview } from '@ade/contracts'
import { color, composite, type Color } from './themeContrastRows'
import { TEXT_THRESHOLD, NON_TEXT_THRESHOLD, type ContrastRowAdder } from './themeContrastRowAdder'

const rgb = converter('rgb')
function secondaryHoverBackground(secondary: Color, foreground: Color): Rgb | null {
  const base = color(secondary)
  const accent = color(foreground)
  if (!base || !accent) return null
  const mixed = interpolate([base, accent], 'oklch')(0.05)
  const srgb = rgb(mixed)
  return srgb ? clampRgb(srgb) : null
}

export function appendAppContrastRows(preview: ThemeDraftPreview, add: ContrastRowAdder): void {
  const app = preview.app?.tokens ?? {}
  const appBackground = color(app.background)
  const cardSurface = color(app.card) ?? appBackground
  const primary = color(app.primary)
  const primaryForeground = color(app['primary-foreground'])
  if (primary && primaryForeground && appBackground) {
    add(
      'app-primary-default',
      'App primary button',
      'default',
      'app',
      'primary-foreground',
      primaryForeground,
      primary,
      TEXT_THRESHOLD,
    )
    const hover = composite({ ...primary, alpha: 0.8 }, cardSurface ?? appBackground)
    add(
      'app-primary-hover',
      'App primary button',
      'hover',
      'app',
      'primary-foreground',
      primaryForeground,
      hover,
      TEXT_THRESHOLD,
      'Button default variant: hover:bg-primary/80 over card surface',
    )
    const ring = color(app.ring)
    if (ring)
      add(
        'app-primary-focus',
        'App primary button',
        'focus-visible ring',
        'app',
        'ring',
        composite({ ...ring, alpha: 0.5 }, cardSurface ?? appBackground),
        cardSurface ?? appBackground,
        NON_TEXT_THRESHOLD,
        'ring at 50% over card surface',
        ring,
      )
  }
  const secondary = color(app.secondary)
  const secondaryForeground = color(app['secondary-foreground'])
  if (secondary && secondaryForeground) {
    add(
      'app-secondary-default',
      'App secondary button',
      'default',
      'app',
      'secondary-foreground',
      secondaryForeground,
      secondary,
      TEXT_THRESHOLD,
    )
    const secondaryHover = secondaryHoverBackground(secondary, color(app.foreground) ?? secondary)
    if (secondaryHover)
      add(
        'app-secondary-hover',
        'App secondary button',
        'hover',
        'app',
        'secondary-foreground',
        secondaryForeground,
        secondaryHover,
        TEXT_THRESHOLD,
        'secondary button hover: color-mix(in oklch, secondary, foreground 5%)',
      )
    add(
      'app-secondary-open',
      'App secondary button',
      'aria-expanded',
      'app',
      'secondary-foreground',
      secondaryForeground,
      secondary,
      TEXT_THRESHOLD,
      'secondary button aria-expanded:bg-secondary',
    )
  }
  const muted = color(app.muted)
  const foreground = color(app.foreground)
  if (muted && foreground && cardSurface) {
    const input = color(app.input)
    const outlineHover =
      preview.app?.mode === 'dark' ? input && composite({ ...input, alpha: 0.5 }, cardSurface) : muted
    if (outlineHover)
      add(
        'app-outline-hover',
        'App outline button on card',
        'hover',
        'app',
        'foreground',
        foreground,
        outlineHover,
        TEXT_THRESHOLD,
        preview.app?.mode === 'dark' ? 'dark:hover:bg-input/50 over card surface' : 'hover:bg-muted',
      )
    add(
      'app-outline-open',
      'App outline button on card',
      'aria-expanded',
      'app',
      'foreground',
      foreground,
      muted,
      TEXT_THRESHOLD,
      'outline button aria-expanded:bg-muted',
    )
    add(
      'app-toggle-hover',
      'App toggle',
      'hover',
      'app',
      'foreground',
      foreground,
      muted,
      TEXT_THRESHOLD,
      'toggle hover:bg-muted (opaque in both modes)',
    )
    add(
      'app-toggle-pressed',
      'App toggle',
      'aria-pressed',
      'app',
      'foreground',
      foreground,
      muted,
      TEXT_THRESHOLD,
      'toggle aria-pressed:bg-muted',
    )
  }
  const accent = color(app.accent)
  const accentForeground = color(app['accent-foreground'])
  if (accent && accentForeground) {
    add(
      'app-menu-hover',
      'Dropdown menu item',
      'pointer hover',
      'app',
      'accent-foreground',
      accentForeground,
      accent,
      TEXT_THRESHOLD,
      'dropdown menu item focus:bg-accent focus:text-accent-foreground',
    )
    add(
      'app-menu-focus',
      'Dropdown menu item',
      'keyboard focus',
      'app',
      'accent-foreground',
      accentForeground,
      accent,
      TEXT_THRESHOLD,
      'dropdown menu item focus:bg-accent focus:text-accent-foreground',
    )
  }
  const destructive = color(app.destructive)
  if (destructive && cardSurface) {
    const dark = preview.definition.mode === 'dark'
    const defaultOpacity = dark ? 0.2 : 0.1
    const hoverOpacity = dark ? 0.3 : 0.2
    add(
      'app-destructive-default',
      'App destructive button',
      'default',
      'app',
      'destructive',
      destructive,
      composite({ ...destructive, alpha: defaultOpacity }, cardSurface),
      TEXT_THRESHOLD,
      'destructive button bg-destructive/10 (dark mode 20%) over card surface',
    )
    add(
      'app-destructive-hover',
      'App destructive button',
      'hover',
      'app',
      'destructive',
      destructive,
      composite({ ...destructive, alpha: hoverOpacity }, cardSurface),
      TEXT_THRESHOLD,
      'destructive button hover:bg-destructive/20 (dark mode 30%) over card surface',
    )
    add(
      'app-destructive-focus',
      'App destructive button',
      'focus-visible ring',
      'app',
      'destructive',
      composite({ ...destructive, alpha: dark ? 0.4 : 0.2 }, cardSurface),
      cardSurface,
      NON_TEXT_THRESHOLD,
      'destructive focus-visible ring at 20% (dark mode 40%) over card surface',
      destructive,
    )
  }
}
