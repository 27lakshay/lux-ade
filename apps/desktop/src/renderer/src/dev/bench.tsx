import { faker } from '@faker-js/faker'
import { mountTerminal } from '@ade/terminal'
import { benchTerminalBridge } from '@ade/terminal/bench'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef, useState } from 'react'
import { Streamdown } from 'streamdown'
import { Caption } from '@/components/Typography'
import { ScrollArea } from '@/components/ui/scroll-area'
import { commandService } from '../app/commands'
import type { RenderContent } from '../features/workspace/content/ContentHosts'
import { defaultLayout, type Layout, type Tab } from '../features/workspace/model/layout'
import { selectWorkspace, startLayoutSync } from '../features/workspace/model/layout-sync'
import { createFakeLayouts } from './layout-double/fake-layouts'

// Benchmark content, development only (open the app with ?bench): real terminals fed by a fake
// connection with a long scrollback and streaming output, and long conversations rendered the way
// the real view will (a virtual list of Markdown messages), the last one still streaming. Not a
// design: just enough to measure the workspace under load.

const params = new URLSearchParams(window.location.search)
const number = (name: string, fallback: number): number => Number(params.get(name) ?? fallback)
const SCROLLBACK = number('scrollback', 10_000)
const LINES_PER_SECOND = number('lines', 600)
const MESSAGES = number('messages', 800)

const bridge = benchTerminalBridge({ scrollback: SCROLLBACK, linesPerSecond: LINES_PER_SECOND })

const WORKSPACES = number('workspaces', 4)

/**
 * A benchmark workspace: conversations in one pane, terminals stacked in two beside it. Its tab
 * targets are synthetic (the real daemon would refuse them), so the bench serves its layouts from
 * the layout double (dev/layout-double) instead of the daemon.
 */
function benchLayout(workspace: string): Layout {
  const tab = (kind: 'conversation' | 'terminal', n: number): Tab => ({
    id: `${workspace}-${kind}-${n}`,
    target: { kind, id: `${workspace}-${kind}-${n}` },
  })
  const conversations = [1, 2, 3, 4].map((n) => tab('conversation', n))
  const terminals = [1, 2, 3, 4, 5, 6].map((n) => tab('terminal', n))
  const pane = (id: string, tabs: Tab[]) => ({
    type: 'pane' as const,
    id: `${workspace}-${id}`,
    tabs: tabs.map((item) => item.id),
    active: tabs[0]!.id,
  })
  return {
    ...defaultLayout(),
    tabs: Object.fromEntries([...conversations, ...terminals].map((item) => [item.id, item])),
    root: {
      type: 'split',
      id: `${workspace}-row`,
      direction: 'row',
      sizes: [50, 50],
      children: [
        pane('chat', conversations),
        {
          type: 'split',
          id: `${workspace}-column`,
          direction: 'column',
          sizes: [50, 50],
          children: [pane('top', terminals.slice(0, 3)), pane('bottom', terminals.slice(3))],
        },
      ],
    },
    focused_pane: `${workspace}-chat`,
  }
}

/** Serves the bench workspaces w1, w2, … from a fake daemon; Ctrl+1 to Ctrl+9 switch between them. */
export function startBenchLayouts(): void {
  const workspaces = Array.from({ length: WORKSPACES }, (_, index) => `w${index + 1}`)
  const fake = createFakeLayouts({
    workspaceId: workspaces[0]!,
    windowId: 'bench',
    layouts: Object.fromEntries(workspaces.map((id) => [id, benchLayout(id)])),
  })
  startLayoutSync(fake.connection)
  workspaces.slice(0, 9).forEach((id, index) => {
    commandService.registerCommand({
      id: `bench.${id}`,
      title: `Bench: open workspace ${index + 1}`,
      category: 'Bench',
      run: () => selectWorkspace(id),
    })
    commandService.registerKeybinding({ key: `Control+${index + 1}`, command: `bench.${id}` })
  })
}

/** How much benchmark content is mounted now, for the measuring script. */
const mounted = { terminals: 0, conversations: 0 }
;(window as unknown as { __bench: typeof mounted }).__bench = mounted

function BenchTerminal({ id }: { id: string }) {
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!container.current) return
    const view = mountTerminal(container.current, bridge, 'bench', id, { onStatus: (message) => console.warn(message) })
    mounted.terminals++
    return () => {
      mounted.terminals--
      view.dispose()
    }
  }, [id])
  return <div ref={container} className="h-full bg-terminal" />
}

function message(seed: number): string {
  faker.seed(seed)
  const parts = [faker.lorem.paragraph({ min: 2, max: 6 })]
  if (seed % 3 === 0) parts.push(faker.helpers.multiple(() => `- ${faker.lorem.sentence()}`, { count: 4 }).join('\n'))
  if (seed % 4 === 0)
    parts.push(
      '```ts\n' +
        faker.helpers
          .multiple(() => `const ${faker.word.noun()} = ${faker.number.int(999)} // ${faker.lorem.words(5)}`, {
            count: 8,
          })
          .join('\n') +
        '\n```',
    )
  if (seed % 5 === 0) parts.push(`${faker.lorem.paragraph()} \`${faker.system.filePath()}\` ${faker.lorem.sentence()}`)
  return parts.join('\n\n')
}

function BenchConversation({ id }: { id: string }) {
  const root = useRef<HTMLDivElement>(null)
  const [messages] = useState(() => Array.from({ length: MESSAGES }, (_, i) => message(i + id.length * 1000)))
  // The last message streams in, a few words at a time.
  const [tail, setTail] = useState('')
  useEffect(() => {
    const words = message(99_999).split(' ')
    let n = 0
    const timer = setInterval(() => {
      n = (n + 3) % words.length
      setTail(words.slice(0, n).join(' '))
    }, 50)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    mounted.conversations++
    return () => {
      mounted.conversations--
    }
  }, [])
  const rows = [...messages, tail]
  // eslint-disable-next-line react/incompatible-library -- TanStack Virtual's virtualizer is mutable; the compiler leaves this component unmemoised, which is what it needs.
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => root.current?.querySelector('[data-slot=scroll-area-viewport]') ?? null,
    estimateSize: () => 240,
    overscan: 4,
  })
  return (
    <ScrollArea ref={root} className="h-full">
      <div className="relative w-full" style={{ height: virtual.getTotalSize() }}>
        {virtual.getVirtualItems().map((item) => (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtual.measureElement}
            className="absolute inset-x-0 top-0 px-3 py-2"
            style={{ transform: `translateY(${item.start}px)` }}
          >
            <Caption tone="muted">{item.index % 2 ? 'Agent' : 'You'}</Caption>
            <Streamdown>{rows[item.index]}</Streamdown>
          </div>
        ))}
      </div>
    </ScrollArea>
  )
}

export const benchContent: RenderContent = (tab) =>
  tab.target.kind === 'terminal' ? <BenchTerminal id={tab.id} /> : <BenchConversation id={tab.id} />
