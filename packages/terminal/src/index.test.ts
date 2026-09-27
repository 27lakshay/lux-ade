import { afterEach, describe, expect, it, vi } from 'vitest'
import { GHOSTTY_SNAPSHOT_FORMAT, type TerminalFrame } from './feed'
import { GhosttyTerminalCore } from './ghostty/core'
import { encodeSnapshot } from './ghostty/testing'
import { mountTerminal, type TerminalBridge, type TerminalChannel } from './index'
import { terminalThemeFrom } from './theme'

const theme = {
  foreground: { r: 255, g: 255, b: 255 },
  background: { r: 0, g: 0, b: 0 },
  cursor: { r: 255, g: 255, b: 255 },
}
const cleanups: Array<() => void> = []

function container(): HTMLElement {
  const element = document.createElement('div')
  element.style.cssText = 'position:relative;width:400px;height:200px;color:rgb(10 20 30);background:rgb(200 210 220)'
  document.body.append(element)
  cleanups.push(() => element.remove())
  return element
}

/** A bridge whose attachment receives the frames the test sends and records what the view sent. */
function fakeBridge() {
  const sent = { input: [] as string[], resize: [] as number[][], disposed: 0 }
  let deliver: ((frame: TerminalFrame) => void) | null = null
  const bridge: TerminalBridge = {
    attach: async (_workspace, _terminal, onFrame) => {
      deliver = onFrame
      const channel: TerminalChannel = {
        input: (data) => sent.input.push(data),
        binary: () => {},
        resize: (...size) => sent.resize.push(size),
        dispose: () => (sent.disposed += 1),
      }
      return channel
    },
  }
  return {
    bridge,
    sent,
    attached: () => deliver !== null,
    send: (frame: TerminalFrame) => deliver?.(frame),
  }
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('mountTerminal', () => {
  it('restores the snapshot, reports its grid, and sends typed input', async () => {
    const source = await GhosttyTerminalCore.create(40, 5, 8, 16, theme)
    source.write('hello')
    const snapshot: TerminalFrame = {
      type: 'snapshot',
      terminal_snapshot_format: GHOSTTY_SNAPSHOT_FORMAT,
      terminal_snapshot_base64: btoa(String.fromCharCode(...(await encodeSnapshot(source)))),
      metrics: { terminal_bytes: 5 },
    }
    source.dispose()

    const mount = container()
    const fake = fakeBridge()
    const statuses: string[] = []
    const view = mountTerminal(mount, fake.bridge, 'ws', 'term', { onStatus: (message) => statuses.push(message) })
    cleanups.push(() => view.dispose())
    await vi.waitFor(() => expect(fake.attached()).toBe(true))

    fake.send(snapshot)
    await vi.waitFor(() => expect(fake.sent.resize.length).toBeGreaterThan(0))
    const [cols, rows, width, height] = fake.sent.resize.at(-1)!
    expect(cols).toBeGreaterThan(10)
    expect(rows).toBeGreaterThan(2)
    expect([width, height]).toEqual([400, 200])

    const input = mount.querySelector('textarea')!
    input.focus()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true }))
    input.value = 'a'
    input.dispatchEvent(new InputEvent('input', { data: 'a', inputType: 'insertText', bubbles: true }))
    await vi.waitFor(() => expect(fake.sent.input.join('')).toContain('a'))
    expect(statuses).toEqual([])

    view.dispose()
    expect(fake.sent.disposed).toBe(1)
    expect(mount.querySelector('canvas')).toBeNull()
  })

  it('sends no input before the screen is restored', async () => {
    const mount = container()
    const fake = fakeBridge()
    const view = mountTerminal(mount, fake.bridge, 'ws', 'term', { onStatus: () => {} })
    cleanups.push(() => view.dispose())
    await vi.waitFor(() => expect(fake.attached()).toBe(true))
    const input = mount.querySelector('textarea')!
    input.value = 'a'
    input.dispatchEvent(new InputEvent('input', { data: 'a', inputType: 'insertText', bubbles: true }))
    expect(fake.sent.input).toEqual([])
  })
})

describe('terminalThemeFrom', () => {
  it("reads the text colour and the nearest opaque ancestor's background", () => {
    const outer = container()
    const inner = document.createElement('div')
    outer.append(inner)
    expect(terminalThemeFrom(inner)).toMatchObject({
      foreground: { r: 10, g: 20, b: 30 },
      background: { r: 200, g: 210, b: 220 },
      cursor: { r: 10, g: 20, b: 30 },
    })
  })
})
