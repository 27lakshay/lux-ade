import { converter, interpolate } from 'culori'
import type { ThemeDraftPreview } from '@ade/contracts'
import { color } from './themeContrastRows'
import { TEXT_THRESHOLD, NON_TEXT_THRESHOLD, type ContrastRowAdder } from './themeContrastRowAdder'

const rgb = converter('rgb')

export function appendCodeContrastRows(preview: ThemeDraftPreview, add: ContrastRowAdder): void {
  const syntax = preview.syntax?.tokens ?? {}
  for (const role of ['syntax-default', 'syntax-keyword', 'syntax-string', 'syntax-number', 'syntax-comment']) {
    const foreground = syntax[role]
    if (foreground && syntax.base)
      add(
        'syntax-' + role,
        'Shiki code preview',
        role.slice('syntax-'.length),
        'syntax',
        role,
        foreground,
        syntax.base,
        TEXT_THRESHOLD,
      )
  }
  const codeSelection = color(syntax.accent)
  const codeSelectionForeground = color(syntax['accent-foreground'])
  if (codeSelection && codeSelectionForeground)
    add(
      'code-selection',
      'Shiki code preview',
      'selected text',
      'syntax',
      'accent-foreground',
      codeSelectionForeground,
      codeSelection,
      TEXT_THRESHOLD,
      'Shiki ::selection uses syntax accent background and accent-foreground text',
    )

  // The visible unified JavaScript diff has default/keyword/number tokens, gutter
  // numbers and changed-word emphasis. Pierre's adapter removes its second line tint.
  const codeBase = color(syntax.base)
  if (codeBase) {
    for (const [state, markerRole, fillRole] of [
      ['addition', 'diff-add', 'diff-add-muted'],
      ['deletion', 'diff-remove', 'diff-remove-muted'],
    ] as const) {
      const fill = color(syntax[fillRole])
      const marker = color(syntax[markerRole])
      if (!fill) continue
      for (const role of ['syntax-default', 'syntax-keyword', 'syntax-number']) {
        if (syntax[role])
          add(
            'diff-' + state + '-' + role,
            'Pierre diff preview',
            state + ' line',
            'syntax',
            role,
            syntax[role],
            fill,
            TEXT_THRESHOLD,
            fillRole + ' with the adapter second tint disabled',
          )
      }
      if (syntax['muted-foreground'])
        add(
          'diff-' + state + '-gutter',
          'Pierre diff preview',
          state + ' gutter',
          'syntax',
          'muted-foreground',
          syntax['muted-foreground'],
          fill,
          TEXT_THRESHOLD,
        )
      if (marker) {
        add(
          'diff-' + state + '-marker',
          'Pierre diff preview',
          state + ' indicator',
          'syntax',
          markerRole,
          marker,
          fill,
          NON_TEXT_THRESHOLD,
        )
        const emphasis = rgb(interpolate([codeBase, marker], 'rgb')(0.25))!
        if (syntax['syntax-number'])
          add(
            'diff-' + state + '-word',
            'Pierre diff preview',
            state + ' changed word',
            'syntax',
            'syntax-number',
            syntax['syntax-number'],
            emphasis,
            TEXT_THRESHOLD,
            markerRole + ' at 25% mixed in sRGB with syntax base',
          )
      }
      // For changed lines Pierre targets the same fill on hover, not panel.
      if (syntax['syntax-default'])
        add(
          'diff-' + state + '-hover',
          'Pierre diff preview',
          state + ' hover',
          'syntax',
          'syntax-default',
          syntax['syntax-default'],
          fill,
          TEXT_THRESHOLD,
          'Pierre hover targets the same changed-line fill',
        )
    }
  }
}
