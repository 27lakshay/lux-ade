import * as React from 'react'
import { useMemo, useSyncExternalStore, type ComponentType } from 'react'
import type { PluginComposerContribution, PluginTimelineContribution } from '@ade/contracts'
import type { ConversationsBridge, PluginUiEntry } from '../../../shared/bridge/conversations'

// The plugin UI host: the one place the renderer loads plugin UI entry points and keeps what they
// register. The daemon owns plugin lifecycle; this follows its enabled set (main lists it from
// `plugin.list`) and keeps each plugin's registrations under the activation generation that made
// them. A disabled, upgraded or reloaded plugin loses only its departing generation's
// registrations, so cleanup never removes a successor's. Registration is accepted only for
// contributions the plugin's manifest declares. Safe mode loads no plugin code.
//
// Plugin UI code is trusted application code running in this renderer. The rules here (frozen
// input, validated output, error boundaries) keep failures local and drafts recoverable; they are
// not a sandbox for hostile code.

/** A draft context reference as the draft stores it. */
export type ContextNode = { id: string; kind: string; data: unknown }
/** What a composer transform reads and returns. */
export type ComposerInput = { text: string; context_nodes: ContextNode[] }
/** A side-effect-free, synchronous transform. Its input is deeply frozen. */
export type ComposerTransform = (input: Readonly<ComposerInput>) => ComposerInput
/** The message a timeline renderer receives: its canonical text and the plugin's payload. */
export type TimelineItem = Readonly<{
  id: string
  kind: string
  role: string
  status: string
  text: string
  data: unknown
}>
export type TimelineRendererProps = { item: TimelineItem }

/** What a plugin's UI entry point receives: `export default function activate(api)`. */
export type PluginUiApi = Readonly<{
  apiVersion: 1
  pluginId: string
  /** The host's React. A plugin renders with it and never bundles its own. */
  React: typeof React
  registerTimelineRenderer(contributionId: string, component: ComponentType<TimelineRendererProps>): void
  registerComposerTransform(contributionId: string, transform: ComposerTransform): void
}>

type Activation = { entry: PluginUiEntry; status: 'loading' | 'active' | 'failed'; error: string | null }
type Owner = { pluginId: string; pluginName: string; generation: number }
export type TimelineRegistration = Owner & {
  contribution: PluginTimelineContribution
  component: ComponentType<TimelineRendererProps>
}
type ComposerRegistration = Owner & { contribution: PluginComposerContribution; transform: ComposerTransform }

/** How a timeline message of a plugin kind is shown: by its renderer, or as text with the reason. */
export type TimelineView = { renderer: TimelineRegistration } | { reason: string }

/** The prompt a send delivers, prepared from the draft before admission. */
export type PreparedInput = {
  text: string
  context_nodes: ContextNode[]
  /** Explanations of fallbacks and skipped transforms, shown with the prepared prompt. */
  notes: string[]
  /** Why the draft cannot be sent as it is; null when it can. */
  blocked: string | null
}

/** The largest prepared prompt, matching the daemon's prompt text limit. */
const MAX_PREPARED_BYTES = 1024 * 1024

/** A node kind or message kind a plugin owns: namespaced under a plugin ID. */
const isPluginKind = (kind: unknown): kind is string => typeof kind === 'string' && kind.includes('.')

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key])
  }
  return value
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Why a transform's output cannot be used, or null when it can. */
function outputProblem(output: unknown, input: ComposerInput): string | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return 'it returned no prepared input'
  const { text, context_nodes: nodes } = output as Partial<ComposerInput>
  if (typeof text !== 'string') return 'its prepared text is not a string'
  if (!text.trim()) return 'it prepared an empty prompt'
  if (new TextEncoder().encode(text).length > MAX_PREPARED_BYTES) return 'its prepared text exceeds 1 MiB'
  let same = false
  try {
    same = JSON.stringify(nodes) === JSON.stringify(input.context_nodes)
  } catch {
    same = false
  }
  // References stay exactly as the draft holds them; they are recorded with the send.
  if (!same) return "it changed the draft's context references"
  return null
}

export class PluginUiHost {
  private mode: 'loading' | 'on' | 'safe' = 'loading'
  private activations = new Map<string, Activation>()
  private timeline = new Map<string, TimelineRegistration>()
  private composer = new Map<string, ComposerRegistration>()
  private version = 0
  private listeners = new Set<() => void>()

  constructor(private readonly load: (url: string) => Promise<unknown> = (url) => import(/* @vite-ignore */ url)) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getVersion = (): number => this.version
  /** `prepare` under the current registrations; a new function whenever they change. */
  private preparer = (input: { text: string; context_nodes: unknown[] }): PreparedInput => this.prepare(input)
  getPreparer = (): ((input: { text: string; context_nodes: unknown[] }) => PreparedInput) => this.preparer
  private emit(): void {
    this.version++
    this.preparer = (input) => this.prepare(input)
    for (const listener of this.listeners) listener()
  }

  /** Safe mode: no plugin code loads in this renderer. */
  enterSafeMode(): void {
    this.mode = 'safe'
    for (const [id, activation] of this.activations) this.drop(id, activation.entry.generation)
    this.emit()
  }

  /** Follows the daemon's enabled set: loads new generations and drops departed ones. */
  sync(entries: PluginUiEntry[]): void {
    if (this.mode === 'safe') return
    let changed = this.mode === 'loading'
    this.mode = 'on'
    const next = new Map(entries.map((entry) => [entry.plugin_id, entry]))
    for (const [id, activation] of this.activations) {
      if (next.get(id)?.generation !== activation.entry.generation) {
        this.drop(id, activation.entry.generation)
        changed = true
      }
    }
    for (const entry of entries) {
      if (this.activations.get(entry.plugin_id)?.entry.generation === entry.generation) continue
      void this.activate(entry)
      changed = true
    }
    if (changed) this.emit()
  }

  /** Removes one generation's registrations and activation; a successor's stay. */
  private drop(pluginId: string, generation: number): void {
    for (const [key, registration] of this.timeline) {
      if (registration.pluginId === pluginId && registration.generation === generation) this.timeline.delete(key)
    }
    for (const [key, registration] of this.composer) {
      if (registration.pluginId === pluginId && registration.generation === generation) this.composer.delete(key)
    }
    if (this.activations.get(pluginId)?.entry.generation === generation) this.activations.delete(pluginId)
  }

  private current(entry: PluginUiEntry): boolean {
    return this.activations.get(entry.plugin_id)?.entry.generation === entry.generation
  }

  private async activate(entry: PluginUiEntry): Promise<void> {
    this.activations.set(entry.plugin_id, { entry, status: 'loading', error: null })
    try {
      const module = (await this.load(entry.url)) as { default?: unknown } | null
      if (!this.current(entry)) return
      const activate = module?.default
      if (typeof activate !== 'function') throw new Error('its UI entry point has no default activate function')
      await (activate as (api: PluginUiApi) => unknown)(this.api(entry))
      if (!this.current(entry)) return
      this.activations.set(entry.plugin_id, { entry, status: 'active', error: null })
    } catch (error) {
      if (!this.current(entry)) return
      console.error(`Plugin ${entry.plugin_id} generation ${entry.generation} UI failed to activate`, error)
      this.drop(entry.plugin_id, entry.generation)
      this.activations.set(entry.plugin_id, { entry, status: 'failed', error: messageOf(error) })
    }
    this.emit()
  }

  private api(entry: PluginUiEntry): PluginUiApi {
    const owner: Owner = { pluginId: entry.plugin_id, pluginName: entry.name, generation: entry.generation }
    return Object.freeze({
      apiVersion: 1 as const,
      pluginId: entry.plugin_id,
      React,
      registerTimelineRenderer: (contributionId: string, component: ComponentType<TimelineRendererProps>) => {
        const contribution = entry.timeline.find((item) => item.id === contributionId)
        if (!contribution) throw new Error(`${entry.plugin_id} does not declare timeline renderer ${contributionId}`)
        if (typeof component !== 'function' && (typeof component !== 'object' || component === null))
          throw new Error(`Timeline renderer ${contributionId} is not a component`)
        // A departed generation registers nothing.
        if (!this.current(entry)) return
        this.timeline.set(contribution.item_kind, { ...owner, contribution, component })
        this.emit()
      },
      registerComposerTransform: (contributionId: string, transform: ComposerTransform) => {
        const contribution = entry.composer.find((item) => item.id === contributionId)
        if (!contribution)
          throw new Error(`${entry.plugin_id} does not declare composer contribution ${contributionId}`)
        if (typeof transform !== 'function') throw new Error(`Composer transform ${contributionId} is not a function`)
        if (!this.current(entry)) return
        this.composer.set(contribution.id, { ...owner, contribution, transform })
        this.emit()
      },
    })
  }

  /** Why no working contribution of `kind` is available, from the declared and loaded plugins. */
  private unavailable(kind: string, declares: (entry: PluginUiEntry) => boolean): string {
    if (this.mode === 'safe') return 'plugin views are off in safe mode'
    if (this.mode === 'loading') return 'plugins are still loading'
    const activation = [...this.activations.values()].find((item) => declares(item.entry))
    if (!activation) return `no enabled plugin provides ${kind}`
    const name = activation.entry.name
    if (activation.status === 'loading') return `${name} is still loading`
    if (activation.status === 'failed') return `${name} failed to load (${activation.error ?? 'unknown error'})`
    return `${name} did not register it`
  }

  /**
   * The enabled plugin's declaration for a message of `kind`, whether or not its renderer loaded:
   * its actions run through the daemon and stay available when the view is not.
   */
  timelineDeclaration(kind: string): { pluginId: string; contribution: PluginTimelineContribution } | null {
    if (this.mode === 'safe') return null
    for (const activation of this.activations.values()) {
      const contribution = activation.entry.timeline.find((item) => item.item_kind === kind)
      if (contribution) return { pluginId: activation.entry.plugin_id, contribution }
    }
    return null
  }

  /** How to show a message of `kind`; null for core kinds, which have no plugin view. */
  timelineView(kind: string): TimelineView | null {
    const renderer = this.timeline.get(kind)
    if (renderer) return { renderer }
    if (!isPluginKind(kind)) return null
    return { reason: this.unavailable(kind, (entry) => entry.timeline.some((item) => item.item_kind === kind)) }
  }

  /**
   * Prepares the prompt a send delivers. Every registered transform runs in contribution order on
   * deeply frozen input; an output that is not a valid prepared input is skipped with a note. A
   * plugin context node that no working transform prepared contributes its plain text
   * (`data.text`), with a note; one without plain text blocks sending with an explanation.
   */
  prepare(input: { text: string; context_nodes: unknown[] }): PreparedInput {
    const notes: string[] = []
    const nodes = input.context_nodes as ContextNode[]
    // An empty draft has nothing to prepare.
    if (!input.text.trim() && nodes.length === 0)
      return { text: input.text, context_nodes: nodes, notes, blocked: null }
    let current: ComposerInput = deepFreeze(structuredClone({ text: input.text, context_nodes: nodes }))
    const prepared = new Set<string>()
    const transforms = [...this.composer.values()].toSorted((a, b) =>
      a.contribution.id.localeCompare(b.contribution.id),
    )
    for (const registration of transforms) {
      try {
        const output = registration.transform(current)
        const problem = outputProblem(output, current)
        if (problem) throw new Error(problem)
        current = deepFreeze(structuredClone({ text: output.text, context_nodes: output.context_nodes }))
        prepared.add(registration.contribution.node_kind)
      } catch (error) {
        console.error(
          `Plugin ${registration.pluginId} composer transform ${registration.contribution.id} failed`,
          error,
        )
        notes.push(
          `${registration.contribution.title} could not prepare this prompt (${messageOf(error)}); it was skipped.`,
        )
      }
    }
    let text = current.text
    let blocked: string | null = null
    for (const node of nodes) {
      const kind = (node as Partial<ContextNode> | null)?.kind
      if (!isPluginKind(kind) || prepared.has(kind)) continue
      const reason = this.unavailable(kind, (entry) => entry.composer.some((item) => item.node_kind === kind))
      const data = (node as Partial<ContextNode>).data
      const fallback =
        data && typeof data === 'object' && typeof (data as { text?: unknown }).text === 'string'
          ? (data as { text: string }).text
          : null
      if (fallback === null) {
        blocked = `This draft holds a ${kind} reference with no plain text, and ${reason}. Remove the reference or enable its plugin to send.`
        continue
      }
      text = text ? `${text}\n\n${fallback}` : fallback
      notes.push(`${kind}: ${reason}; its plain text is included in the prompt.`)
    }
    return { text, context_nodes: current.context_nodes, notes, blocked }
  }
}

export const pluginUi = new PluginUiHost()

const REFRESH_MS = 3_000
let refreshing: (() => Promise<void>) | null = null

/** Starts following the daemon's enabled plugins in this window; safe mode loads none. */
export function startPluginUi(conversations: ConversationsBridge, { safeMode }: { safeMode: boolean }): () => void {
  if (safeMode) {
    pluginUi.enterSafeMode()
    return () => undefined
  }
  const refresh = async (): Promise<void> => {
    try {
      pluginUi.sync(await conversations.pluginUiEntries())
    } catch {
      // The daemon is unavailable or the profile is switching; keep what is loaded until it answers.
    }
  }
  refreshing = refresh
  void refresh()
  // The daemon publishes no plugin feed event; follow its enabled set on focus and on an interval.
  const timer = setInterval(() => void refresh(), REFRESH_MS)
  window.addEventListener('focus', refresh)
  return () => {
    clearInterval(timer)
    window.removeEventListener('focus', refresh)
    refreshing = null
  }
}

/** Re-reads the enabled set now, after this window enabled or disabled a plugin. */
export const refreshPluginUi = (): Promise<void> => refreshing?.() ?? Promise.resolve()

/** Re-renders when plugin registrations change. */
const usePluginUiVersion = (): number => useSyncExternalStore(pluginUi.subscribe, pluginUi.getVersion)

/** Prepares `text` and `nodes` for sending, again whenever plugin registrations change. */
export function usePreparedInput(text: string, nodes: unknown[]): PreparedInput {
  const prepare = useSyncExternalStore(pluginUi.subscribe, pluginUi.getPreparer)
  return useMemo(() => prepare({ text, context_nodes: nodes }), [prepare, text, nodes])
}

/** How to show a message of `kind`, following registration changes. */
export function useTimelineView(kind: string): TimelineView | null {
  usePluginUiVersion()
  return pluginUi.timelineView(kind)
}

/** The plugin declaration for `kind`, following registration changes. */
export function useTimelineDeclaration(kind: string) {
  usePluginUiVersion()
  return pluginUi.timelineDeclaration(kind)
}
