import './code-theme.css'
import { codeThemeVariables } from '../../../../shared/code-theme'
import type { ThemeRegistration } from 'shiki'

// Stable variable names let a palette change repaint already-tokenized content.
// ADE currently has five semantic syntax roles. Unmapped TextMate scopes retain
// the default role; language grammars decide which scopes a token receives.
export const adeCodeTheme: ThemeRegistration = {
  name: 'ade-semantic',
  type: 'dark',
  colors: {
    'editor.foreground': 'var(--ade-code-default)',
    'editor.background': 'var(--ade-code-background)',
    'editor.selectionBackground': 'var(--ade-code-selection)',
    'editor.selectionForeground': 'var(--ade-code-selection-foreground)',
    'editorLineNumber.foreground': 'var(--ade-code-gutter)',
    'editorLineNumber.activeForeground': 'var(--ade-code-default)',
    'editor.lineHighlightBackground': 'var(--ade-code-active-line)',
    'editor.findMatchBackground': 'var(--ade-code-search)',
    'editorError.foreground': 'var(--ade-code-error)',
    'editorWarning.foreground': 'var(--ade-code-warning)',
    'editorInfo.foreground': 'var(--ade-code-info)',
    'diffEditor.insertedTextBackground': 'var(--ade-code-added-background)',
    'diffEditor.removedTextBackground': 'var(--ade-code-removed-background)',
  },
  tokenColors: [
    { scope: ['keyword', 'storage'], settings: { foreground: 'var(--ade-code-keyword)' } },
    { scope: ['string'], settings: { foreground: 'var(--ade-code-string)' } },
    { scope: ['constant.numeric'], settings: { foreground: 'var(--ade-code-number)' } },
    { scope: ['comment'], settings: { foreground: 'var(--ade-code-comment)' } },
    { scope: ['markup.inserted'], settings: { foreground: 'var(--ade-code-added)' } },
    { scope: ['markup.deleted'], settings: { foreground: 'var(--ade-code-removed)' } },
  ],
}

/** Apply a complete resolved code palette without modifying app or terminal tokens. */
export function applyCodeTheme(target: HTMLElement, tokens: Record<string, string>): void {
  for (const [variable, value] of Object.entries(codeThemeVariables(tokens))) {
    if (value) target.style.setProperty(variable, value)
    else target.style.removeProperty(variable)
  }
}
