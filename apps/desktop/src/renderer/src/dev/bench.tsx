import { faker } from '@faker-js/faker'
import { mountTerminal } from '@ade/terminal'
import { benchTerminalBridge } from '@ade/terminal/bench'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef, useState } from 'react'
import { Streamdown } from 'streamdown'
import { Caption } from '@/components/Typography'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { RenderContent } from '../features/workspace/content/ContentHosts'

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

function BenchTerminal({ id }: { id: string }) {
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!container.current) return
    const view = mountTerminal(container.current, bridge, 'bench', id, { onStatus: (message) => console.warn(message) })
    return () => view.dispose()
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
  tab.kind === 'terminal' ? <BenchTerminal id={tab.id} /> : <BenchConversation id={tab.id} />
