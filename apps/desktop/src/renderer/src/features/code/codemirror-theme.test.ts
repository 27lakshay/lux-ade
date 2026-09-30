import { setDiagnostics, openLintPanel } from '@codemirror/lint'
import { openSearchPanel, SearchQuery, setSearchQuery } from '@codemirror/search'
import { expect, it } from 'vitest'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view'
import { history, undo } from '@codemirror/commands'
import { languages } from '@codemirror/language-data'
import palettes from '../../../../../../../crates/ade-core/src/appearance/builtin.json'
import { applyCodeTheme } from './code-theme'
import { codeMirrorTheme } from './codemirror-theme'

it('recolors a real CodeMirror document without losing caret, scroll or undo history', async () => {
  const language = await languages.find((item) => item.name === 'JavaScript')!.load()
  const host = document.createElement('div')
  document.body.append(host)
  applyCodeTheme(host, palettes.graphite)
  const original = 'const answer = "hello"; // comment\n'.repeat(40)
  const appearance = new Compartment()
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: original,
      extensions: [
        language,
        history(),
        appearance.of(codeMirrorTheme('dark')),
        EditorView.theme({ '&': { height: '100px' }, '.cm-scroller': { overflow: 'auto' } }),
      ],
    }),
  })
  try {
    const keyword = () => [...view.dom.querySelectorAll('.cm-line span')].find((node) => node.textContent === 'const')!
    await expect.poll(() => keyword() && getComputedStyle(keyword()).color).toBe('rgb(138, 180, 248)')
    view.dispatch({ changes: { from: 0, insert: '// edited\n' }, selection: { anchor: 10 } })
    view.scrollDOM.scrollTop = 30
    await expect.poll(() => view.scrollDOM.scrollTop).toBe(30)
    const state = view.state
    const dom = view.dom
    applyCodeTheme(host, palettes.chalk)
    expect(getComputedStyle(keyword()).color).toBe('rgb(36, 91, 168)')
    expect(getComputedStyle(view.dom).backgroundColor).toBe('rgb(232, 235, 239)')
    expect(view.state).toBe(state)
    view.dispatch({ effects: appearance.reconfigure(codeMirrorTheme('light')) })
    expect(view.state.doc).toBe(state.doc)
    expect(view.state.facet(EditorView.darkTheme)).toBe(false)
    expect(view.dom).toBe(dom)
    expect(view.state.selection.main.anchor).toBe(10)
    expect(view.scrollDOM.scrollTop).toBe(30)
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(original)
  } finally {
    view.destroy()
    host.remove()
  }
})

it('recolors real search matches, gutters and diagnostic underlines and panels in place', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  applyCodeTheme(host, palettes.graphite)
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: 'first second third\nfirst\n',
      extensions: [codeMirrorTheme('dark'), lineNumbers(), highlightActiveLine(), highlightActiveLineGutter()],
    }),
  })
  try {
    view.dispatch(
      setDiagnostics(view.state, [
        { from: 0, to: 5, severity: 'error', message: 'First error' },
        { from: 6, to: 12, severity: 'warning', message: 'Second warning' },
        { from: 13, to: 18, severity: 'info', message: 'Third info' },
        { from: 23, to: 23, severity: 'error', message: 'End error' },
      ]),
    )
    openLintPanel(view)
    openSearchPanel(view)
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'first' })) })
    const underline = (severity: string) => view.dom.querySelector(`.cm-lintRange-${severity}`)!
    await expect.poll(() => underline('error')).toBeTruthy()
    const error = underline('error')
    const warning = underline('warning')
    const info = underline('info')
    const search = view.dom.querySelector('.cm-searchMatch')!
    const point = view.dom.querySelector('.cm-lintPoint-error')!
    expect(point).toBeTruthy()
    const state = view.state
    expect(search).toBeTruthy()
    for (const [palette, colors] of [
      [
        palettes.graphite,
        {
          error: 'rgb(255, 154, 154)',
          warning: 'rgb(230, 193, 122)',
          info: 'rgb(157, 187, 255)',
          search: 'rgb(53, 50, 45)',
        },
      ],
      [
        palettes.chalk,
        {
          error: 'rgb(166, 48, 58)',
          warning: 'rgb(128, 80, 0)',
          info: 'rgb(36, 91, 168)',
          search: 'rgb(240, 237, 232)',
        },
      ],
    ] as const) {
      applyCodeTheme(host, palette)
      for (const [node, color] of [
        [error, colors.error],
        [warning, colors.warning],
        [info, colors.info],
      ] as const) {
        expect(getComputedStyle(node).backgroundImage).toBe('none')
        expect(getComputedStyle(node).textDecorationColor).toBe(color)
        expect(getComputedStyle(node).textDecorationStyle).toBe('wavy')
      }
      expect(getComputedStyle(search).backgroundColor).toBe(colors.search)
      const gutter = view.dom.querySelector('.cm-gutters')!
      const diagnostic = view.dom.querySelector('.cm-diagnostic-error')!
      expect(getComputedStyle(gutter).color).toBe(
        palette === palettes.graphite ? 'rgb(169, 176, 188)' : 'rgb(83, 93, 107)',
      )
      expect(getComputedStyle(diagnostic).borderLeftColor).toBe(colors.error)
      expect(getComputedStyle(view.dom.querySelector('.cm-panels')!).backgroundColor).toBe(
        palette === palettes.graphite ? 'rgb(16, 17, 19)' : 'rgb(232, 235, 239)',
      )
      expect(underline('error')).toBe(error)
      expect(getComputedStyle(point, '::after').borderBottomColor).toBe(colors.error)
      expect(view.dom.querySelector('.cm-searchMatch')).toBe(search)
      expect(view.state).toBe(state)
    }
  } finally {
    view.destroy()
    host.remove()
  }
})
