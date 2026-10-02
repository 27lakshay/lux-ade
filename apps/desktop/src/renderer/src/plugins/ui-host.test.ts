import { expect, test, vi } from 'vitest'
import type { PluginUiEntry } from '../../../shared/bridge/conversations'
import { PluginUiHost, type PluginUiApi } from './ui-host'

const entry = (generation: number, overrides: Partial<PluginUiEntry> = {}): PluginUiEntry => ({
  plugin_id: 'acme.notes',
  name: 'Notes',
  version: '1.0.0',
  generation,
  url: `ade-plugin://acme.notes/${generation}/ui.mjs`,
  timeline: [{ id: 'acme.notes.card', version: 1, item_kind: 'acme.notes.card', title: 'Note card' }],
  composer: [{ id: 'acme.notes.snippet', version: 1, node_kind: 'acme.notes.snippet', title: 'Snippets' }],
  ...overrides,
})

/** A host whose entry points are these activate functions, by URL. */
function hostWith(modules: Record<string, (api: PluginUiApi) => unknown>) {
  return new PluginUiHost(async (url) => {
    const activate = modules[url]
    if (!activate) throw new Error(`no module at ${url}`)
    return { default: activate }
  })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const Card = () => null

test('registration is accepted only for declared contributions and follows the enabled set', async () => {
  const refusals: string[] = []
  const host = hostWith({
    'ade-plugin://acme.notes/1/ui.mjs': (api) => {
      api.registerTimelineRenderer('acme.notes.card', Card)
      for (const register of [
        () => api.registerTimelineRenderer('acme.notes.other', Card),
        () => api.registerComposerTransform('acme.notes.card', (input) => input),
      ]) {
        try {
          register()
        } catch (error) {
          refusals.push((error as Error).message)
        }
      }
    },
  })
  expect(host.timelineView('acme.notes.card')).toEqual({ reason: 'plugins are still loading' })
  host.sync([entry(1)])
  expect(host.timelineView('acme.notes.card')).toEqual({ reason: 'Notes is still loading' })
  await settle()
  expect(refusals).toEqual([
    'acme.notes does not declare timeline renderer acme.notes.other',
    'acme.notes does not declare composer contribution acme.notes.card',
  ])
  const view = host.timelineView('acme.notes.card')
  expect(view && 'renderer' in view && view.renderer.component).toBe(Card)
  // Core kinds have no plugin view.
  expect(host.timelineView('message')).toBeNull()

  host.sync([])
  expect(host.timelineView('acme.notes.card')).toEqual({ reason: 'no enabled plugin provides acme.notes.card' })
})

test("a departing generation's late registration and cleanup never touch its successor", async () => {
  let releaseOld: () => void = () => undefined
  const OldCard = () => null
  const NewCard = () => null
  const host = hostWith({
    'ade-plugin://acme.notes/1/ui.mjs': async (api) => {
      await new Promise<void>((resolve) => (releaseOld = resolve))
      api.registerTimelineRenderer('acme.notes.card', OldCard)
    },
    'ade-plugin://acme.notes/2/ui.mjs': (api) => api.registerTimelineRenderer('acme.notes.card', NewCard),
  })
  host.sync([entry(1)])
  await settle()
  host.sync([entry(2)])
  await settle()
  releaseOld()
  await settle()
  const view = host.timelineView('acme.notes.card')
  expect(view && 'renderer' in view && view.renderer).toMatchObject({ generation: 2, component: NewCard })
})

test('an entry point that fails to activate leaves a readable reason', async () => {
  const host = hostWith({
    'ade-plugin://acme.notes/1/ui.mjs': () => {
      throw new Error('boom')
    },
  })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  host.sync([entry(1)])
  await settle()
  expect(host.timelineView('acme.notes.card')).toEqual({ reason: 'Notes failed to load (boom)' })
})

test('safe mode loads nothing and says so', () => {
  const load = vi.fn()
  const host = new PluginUiHost(load)
  host.enterSafeMode()
  host.sync([entry(1)])
  expect(load).not.toHaveBeenCalled()
  expect(host.timelineView('acme.notes.card')).toEqual({ reason: 'plugin views are off in safe mode' })
})

const snippet = { id: 'n1', kind: 'acme.notes.snippet', data: { label: 'Notes', text: 'Ship it.' } }

test('transforms get frozen input and prepare the text; invalid output is skipped with a note', async () => {
  const seen: boolean[] = []
  const host = hostWith({
    'ade-plugin://acme.notes/1/ui.mjs': (api) =>
      api.registerComposerTransform('acme.notes.snippet', (input) => {
        seen.push(Object.isFrozen(input), Object.isFrozen(input.context_nodes[0]!.data))
        if (input.text === 'mutate') (input as { text: string }).text = 'changed'
        if (input.text === 'drop') return { text: 'x', context_nodes: [] }
        if (input.text === 'empty') return { text: ' ', context_nodes: input.context_nodes }
        return { text: `${input.text} + ${input.context_nodes.length}`, context_nodes: input.context_nodes }
      }),
  })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  host.sync([entry(1)])
  await settle()
  expect(host.prepare({ text: 'Plan', context_nodes: [snippet] })).toEqual({
    text: 'Plan + 1',
    context_nodes: [snippet],
    notes: [],
    blocked: null,
  })
  expect(seen).toEqual([true, true])
  for (const [text, problem] of [
    ['mutate', "Cannot assign to read only property 'text'"],
    ['drop', "it changed the draft's context references"],
    ['empty', 'it prepared an empty prompt'],
  ]) {
    const prepared = host.prepare({ text: text!, context_nodes: [snippet] })
    // A skipped transform leaves its node to the plain-text fallback.
    expect(prepared.text).toBe(`${text}\n\nShip it.`)
    expect(prepared.notes[0]).toContain(`Snippets could not prepare this prompt (${problem}`)
    expect(prepared.notes[1]).toBe(
      'acme.notes.snippet: Notes did not register it; its plain text is included in the prompt.',
    )
  }
  // An empty draft runs nothing.
  expect(host.prepare({ text: '', context_nodes: [] })).toEqual({
    text: '',
    context_nodes: [],
    notes: [],
    blocked: null,
  })
})

test('a plugin node without a working contribution sends its plain text, or blocks without one', () => {
  const host = new PluginUiHost(async () => ({}))
  host.sync([])
  expect(host.prepare({ text: 'Review', context_nodes: [snippet] })).toMatchObject({
    text: 'Review\n\nShip it.',
    notes: [
      'acme.notes.snippet: no enabled plugin provides acme.notes.snippet; its plain text is included in the prompt.',
    ],
    blocked: null,
  })
  const bare = { id: 'n2', kind: 'acme.notes.snippet', data: { label: 'Notes' } }
  expect(host.prepare({ text: 'Review', context_nodes: [bare] }).blocked).toBe(
    'This draft holds a acme.notes.snippet reference with no plain text, and no enabled plugin provides acme.notes.snippet. Remove the reference or enable its plugin to send.',
  )
  // Core kinds are not plugin nodes; they travel as the draft holds them.
  const file = { id: 'f', kind: 'file_range', data: { provenance: { path: 'a.ts' } } }
  expect(host.prepare({ text: 'Review', context_nodes: [file] })).toMatchObject({
    text: 'Review',
    notes: [],
    blocked: null,
  })
})
