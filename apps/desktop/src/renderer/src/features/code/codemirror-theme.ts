import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'

const highlighting = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [tags.keyword, tags.operator], color: 'var(--ade-code-keyword)' },
    { tag: tags.string, color: 'var(--ade-code-string)' },
    { tag: tags.number, color: 'var(--ade-code-number)' },
    { tag: tags.comment, color: 'var(--ade-code-comment)' },
    { tag: tags.inserted, color: 'var(--ade-code-added)' },
    { tag: tags.deleted, color: 'var(--ade-code-removed)' },
  ]),
)

const surfaces = EditorView.theme({
  '&': { color: 'var(--ade-code-default)', backgroundColor: 'var(--ade-code-background)' },
  '.cm-content': { caretColor: 'var(--ade-code-default)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ade-code-default)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--ade-code-selection)',
  },
  '.cm-content ::selection': { color: 'var(--ade-code-selection-foreground)' },
  '.cm-gutters': { color: 'var(--ade-code-gutter)', backgroundColor: 'var(--ade-code-background)', border: 'none' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--ade-code-active-line)' },
  '.cm-searchMatch': { backgroundColor: 'var(--ade-code-search)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--ade-code-selection)' },
  '.cm-matchingBracket': {
    backgroundColor: 'var(--ade-code-selection)',
    color: 'var(--ade-code-selection-foreground)',
  },
  '.cm-panels, .cm-tooltip': { color: 'var(--ade-code-default)', backgroundColor: 'var(--ade-code-background)' },
  '.cm-lintRange': {
    backgroundImage: 'none',
    textDecorationLine: 'underline',
    textDecorationStyle: 'wavy',
    textDecorationThickness: '1px',
    textUnderlineOffset: '3px',
  },
  '.cm-lintRange-error': { textDecorationColor: 'var(--ade-code-error)' },
  '.cm-lintRange-warning': { textDecorationColor: 'var(--ade-code-warning)' },
  '.cm-lintRange-info': { textDecorationColor: 'var(--ade-code-info)' },
  '.cm-lintRange-hint': { textDecorationColor: 'var(--ade-code-comment)' },
  '.cm-lintRange-active': { backgroundColor: 'var(--ade-code-selection)' },
  '.cm-lintPoint-error:after': { borderBottomColor: 'var(--ade-code-error)' },
  '.cm-lintPoint-warning:after': { borderBottomColor: 'var(--ade-code-warning)' },
  '.cm-lintPoint-info:after': { borderBottomColor: 'var(--ade-code-info)' },
  '.cm-lintPoint-hint:after': { borderBottomColor: 'var(--ade-code-comment)' },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--ade-code-error)' },
  '.cm-diagnostic-warning': { borderLeftColor: 'var(--ade-code-warning)' },
  '.cm-diagnostic-info': { borderLeftColor: 'var(--ade-code-info)' },
})

/** Put this extension in a Compartment; reconfigure only when the selected mode changes. */
export function codeMirrorTheme(mode: 'light' | 'dark') {
  return [surfaces, highlighting, EditorView.darkTheme.of(mode === 'dark')]
}
