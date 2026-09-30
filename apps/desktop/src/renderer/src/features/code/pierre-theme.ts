import { adeCodeTheme } from './code-theme'

let registration: Promise<string> | undefined

/** Load the diff library only when a diff consumer needs its shared theme. */
export function registerPierreTheme(): Promise<string> {
  return (registration ??= import('@pierre/diffs')
    .then(({ registerCustomTheme }) => {
      const name = adeCodeTheme.name!
      registerCustomTheme(name, async () => adeCodeTheme)
      return name
    })
    .catch((error: unknown) => {
      registration = undefined
      throw error
    }))
}

// These overrides inherit into Pierre's shadow root. The static adapter rule
// below disables a second tint of ADE's already-composited diff fills. It leaves
// Pierre's later hover, selection and decoration layers intact.
export const pierreThemeCSS = `
[data-line-type="change-addition"], [data-line-type="change-deletion"],
[data-merge-conflict="current"], [data-merge-conflict="incoming"] {
  --mix-light: 0%;
  --mix-dark: 0%;
}
[data-column-number][data-merge-conflict="incoming"] {
  color: var(--ade-code-gutter);
}
`

// Imported themes supply data only; this adapter owns the fixed CSS above.
const overrides = {
  'addition-color': 'var(--ade-code-added)',
  'deletion-color': 'var(--ade-code-removed)',
  'modified-color': 'var(--ade-code-info)',
  'bg-context': 'var(--ade-code-background)',
  'bg-context-gutter': 'var(--ade-code-background)',
  'bg-addition': 'var(--ade-code-added-background)',
  'bg-deletion': 'var(--ade-code-removed-background)',
  'bg-addition-number': 'var(--ade-code-added-background)',
  'bg-deletion-number': 'var(--ade-code-removed-background)',
  'bg-addition-emphasis': 'color-mix(in srgb, var(--ade-code-added) 25%, var(--ade-code-background))',
  'bg-deletion-emphasis': 'color-mix(in srgb, var(--ade-code-removed) 25%, var(--ade-code-background))',
  'fg-number': 'var(--ade-code-gutter)',
  'fg-number-addition': 'var(--ade-code-gutter)',
  'fg-number-deletion': 'var(--ade-code-gutter)',
  'fg-conflict-marker': 'var(--ade-code-comment)',
  'bg-selection': 'var(--ade-code-selection)',
  'bg-selection-number': 'var(--ade-code-selection)',
  'bg-hover': 'var(--ade-code-active-line)',
  'bg-buffer': 'var(--ade-code-background)',
  'bg-separator': 'var(--ade-code-active-line)',
} as const

export function applyPierreTheme(target: HTMLElement): void {
  for (const region of ['current', 'incoming']) {
    const value = region === 'current' ? 'var(--ade-code-added-background)' : 'var(--ade-code-info-background)'
    target.style.setProperty(`--conflict-bg-${region}-override`, value)
    target.style.setProperty(`--conflict-bg-${region}-number-override`, value)
  }
  for (const [role, value] of Object.entries(overrides)) target.style.setProperty(`--diffs-${role}-override`, value)
}
