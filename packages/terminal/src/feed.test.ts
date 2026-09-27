import { afterEach, describe, expect, it } from 'vitest'
import { GHOSTTY_SNAPSHOT_FORMAT, TerminalFeed, type TerminalFrame } from './feed'
import { GhosttyTerminalCore } from './ghostty/core'
import { encodeSnapshot } from './ghostty/testing'
import vendoredVersion from './ghostty/vendor/VERSION?raw'

const theme = {
  foreground: { r: 255, g: 255, b: 255 },
  background: { r: 0, g: 0, b: 0 },
  cursor: { r: 255, g: 255, b: 255 },
}
const cores = new Set<GhosttyTerminalCore>()

async function newCore(): Promise<GhosttyTerminalCore> {
  const core = await GhosttyTerminalCore.create(40, 5, 8, 16, theme)
  cores.add(core)
  return core
}

const lineText = (core: GhosttyTerminalCore, row: number): string =>
  core
    .snapshot()
    .rowData[row]!.cells.map((cell) => cell.text || ' ')
    .join('')
    .trimEnd()

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))

/** A snapshot frame as the runtime sends it to a viewer that asked for base64 Ghostty state. */
async function snapshotFrame(text: string, extra: Record<string, unknown> = {}): Promise<TerminalFrame> {
  const source = await newCore()
  source.write(text)
  return {
    type: 'snapshot',
    terminal_snapshot_format: GHOSTTY_SNAPSHOT_FORMAT,
    terminal_snapshot_base64: toBase64(await encodeSnapshot(source)),
    metrics: { terminal_bytes: new TextEncoder().encode(text).length },
    ...extra,
  }
}

const output = (text: string, offset: number): TerminalFrame => ({
  type: 'terminal',
  offset,
  bytes: Array.from(new TextEncoder().encode(text)),
})

function feedInto(core: GhosttyTerminalCore) {
  const log = { statuses: [] as string[], ready: 0, failed: 0 }
  const feed = new TerminalFeed(core, {
    status: (message) => log.statuses.push(message),
    ready: () => (log.ready += 1),
    failed: () => (log.failed += 1),
  })
  return { feed, log }
}

afterEach(() => {
  for (const core of cores) core.dispose()
  cores.clear()
})

describe('TerminalFeed', () => {
  it('names the snapshot format of the Ghostty it was built from', () => {
    const revision = /^herdr ([0-9a-f]{40})$/m.exec(vendoredVersion)?.[1]
    expect(GHOSTTY_SNAPSHOT_FORMAT).toBe(`ghostty-snapshot-v1-herdr-${revision?.slice(0, 7)}`)
  })

  it('restores the snapshot, then writes live output from its offset', async () => {
    const snapshot = await snapshotFrame('hello\r\n')
    const core = await newCore()
    const { feed, log } = feedInto(core)
    expect(feed.ready).toBe(false)

    feed.push(snapshot)
    expect(feed.ready).toBe(true)
    expect(log.ready).toBe(1)
    expect(lineText(core, 0)).toBe('hello')

    feed.push(output('world', 7))
    expect(lineText(core, 1)).toBe('world')
    expect(log.statuses).toEqual([])
  })

  it('reports a gap and skips output that does not start at the expected offset', async () => {
    const core = await newCore()
    const { feed, log } = feedInto(core)
    feed.push(await snapshotFrame('hello\r\n'))
    feed.push(output('lost', 9))
    expect(lineText(core, 1)).toBe('')
    expect(log.statuses).toEqual(['Terminal output is incomplete. Reconnect to restore it.'])
  })

  it('holds output that arrives before the snapshot and applies it after', async () => {
    const snapshot = await snapshotFrame('hello\r\n')
    const core = await newCore()
    const { feed } = feedInto(core)
    feed.push(output('late', 7))
    feed.push(snapshot)
    expect(lineText(core, 1)).toBe('late')
  })

  it('replaces the screen with a resync snapshot and continues from its offset', async () => {
    const core = await newCore()
    const { feed, log } = feedInto(core)
    feed.push(await snapshotFrame('stale\r\n'))
    feed.push(output('skipped', 7))
    feed.push(await snapshotFrame('\x1b[2J\x1b[Hfresh\r\n', { resync: true }))
    expect(lineText(core, 0)).toBe('fresh')
    feed.push(output('next', new TextEncoder().encode('\x1b[2J\x1b[Hfresh\r\n').length))
    expect(lineText(core, 1)).toBe('next')
    expect(log.ready).toBe(2)
  })

  it('fails on a snapshot from another Ghostty, keeping the screen', async () => {
    const core = await newCore()
    core.write('kept')
    const { feed, log } = feedInto(core)
    feed.push({ ...(await snapshotFrame('other')), terminal_snapshot_format: 'ghostty-snapshot-v1-herdr-0000000' })
    expect(feed.ready).toBe(false)
    expect(log.failed).toBe(1)
    expect(lineText(core, 0)).toBe('kept')
  })

  it('fails on a corrupt snapshot, keeping the screen', async () => {
    const core = await newCore()
    core.write('kept')
    const { feed, log } = feedInto(core)
    feed.push({ ...(await snapshotFrame('other')), terminal_snapshot_base64: toBase64(new Uint8Array([1, 2, 3, 4])) })
    expect(log.failed).toBe(1)
    expect(log.statuses).toEqual(['Terminal state could not be restored; reopen this view to try again.'])
    expect(lineText(core, 0)).toBe('kept')
  })
})
