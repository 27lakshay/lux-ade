// Portions adapted from t3code apps/web/src/terminal/ghostty/runtimeAbi.test.ts (MIT).
//
// Guards the raw libghostty-vt ABI the core relies on: option and data numbers, struct sizes and
// field offsets. A Ghostty upgrade that moves any of them fails here before it corrupts memory.
import { describe, expect, it } from 'vitest'
import dependencies from '../../../../native/dependencies.json'
import { ghosttyKeyForCode } from './keyCodes'
import { GhosttyRuntime } from './runtime'
import wasmUrl from './vendor/ghostty-vt.wasm?url'
import vendoredVersion from './vendor/VERSION?raw'

const OPT_SCROLLBACK_MAX_BYTES = 27
const OPT_SELECTION = 21
const OPT_DEFAULT_CURSOR_BLINK = 23
const DATA_SCROLLBAR = 9
const DATA_MOUSE_TRACKING = 11
const DATA_MODE = 37
const RENDER_STATE_DATA_CURSOR_BLINKING = 12
const OUT_OF_SPACE = -3

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/** A fresh module instance per test, with the helpers every raw ABI test needs. */
async function harness() {
  const response = await fetch(wasmUrl)
  const bytes = await response.arrayBuffer()
  const runtime = await GhosttyRuntime.fromBytes(bytes)
  const call = runtime.call.bind(runtime)
  const u32 = (pointer: number) => runtime.view(pointer, 4).getUint32(0, true)

  const newTerminal = (cols: number, rows: number) => {
    const slot = runtime.allocOpaque()
    expect(call('ghostty_terminal_new', 0, slot, cols, rows)).toBe(0)
    return { terminal: runtime.readPointer(slot), slot }
  }
  const freeTerminal = ({ terminal, slot }: { terminal: number; slot: number }) => {
    call('ghostty_terminal_free', terminal)
    runtime.freeOpaque(slot)
  }
  const write = (terminal: number, data: string) => {
    const input = textEncoder.encode(data)
    const pointer = runtime.alloc(Math.max(1, input.length))
    runtime.bytes(pointer, input.length).set(input)
    call('ghostty_terminal_vt_write', terminal, pointer, input.length)
    runtime.free(pointer, Math.max(1, input.length))
  }
  /** Calls a `(…, buffer, length, written)` export twice: once to size, once to fill. */
  const readString = (fill: (buffer: number, length: number, written: number) => number) => {
    const written = runtime.alloc(4)
    try {
      expect(fill(0, 0, written)).toBe(OUT_OF_SPACE)
      const size = u32(written)
      const buffer = runtime.alloc(size)
      try {
        expect(fill(buffer, size, written)).toBe(0)
        return textDecoder.decode(runtime.bytes(buffer, u32(written)))
      } finally {
        runtime.free(buffer, size)
      }
    } finally {
      runtime.free(written, 4)
    }
  }
  const formatSelection = (terminal: number) => {
    const options = runtime.alloc(16)
    const view = runtime.view(options, 16)
    view.setUint32(0, 16, true)
    view.setUint8(8, 1)
    view.setUint8(9, 1)
    try {
      return readString((buffer, length, written) =>
        call('ghostty_terminal_selection_format_buf', terminal, options, buffer, length, written),
      )
    } finally {
      runtime.free(options, 16)
    }
  }
  const modeEnabled = (terminal: number, mode: number) => {
    const config = runtime.alloc(4)
    runtime.view(config, 4).setUint16(0, mode, true)
    expect(call('ghostty_terminal_get', terminal, DATA_MODE, config)).toBe(0)
    const enabled = runtime.bytes(config, 4)[2] !== 0
    runtime.free(config, 4)
    return enabled
  }

  return {
    runtime,
    call,
    u32,
    newTerminal,
    freeTerminal,
    write,
    readString,
    formatSelection,
    modeEnabled,
  }
}

describe('vendored libghostty-vt WebAssembly', () => {
  it('is built from the Ghostty revision the daemon pins, within the size budget', async () => {
    const response = await fetch(wasmUrl)
    const wasm = await response.arrayBuffer()
    expect(wasm.byteLength).toBeLessThan(900_000)

    // The build embeds no revision, so the VERSION file written next to the module by
    // scripts/build-ghostty-wasm.mjs is checked against the daemon's pin instead.
    const revision = /^herdr ([0-9a-f]{40})$/m.exec(vendoredVersion)?.[1]
    expect(revision).toBeDefined()
    expect(dependencies.sources['libghostty-vt'].url).toContain(revision)
  })

  it('reads its struct layouts from the module', async () => {
    const { runtime } = await harness()
    expect(runtime.layout('GhosttyTerminalModeConfig').size).toBe(4)
    expect(runtime.layout('GhosttyTerminalModeConfig').fields.mode?.offset).toBe(0)
    expect(runtime.layout('GhosttyTerminalModeConfig').fields.value?.offset).toBe(2)
  })

  it('creates, writes multi-codepoint graphemes, and frees repeated terminals', async () => {
    const { newTerminal, freeTerminal, write } = await harness()
    for (let iteration = 0; iteration < 25; iteration += 1) {
      const handle = newTerminal(80, 24)
      write(handle.terminal, 'é 👨‍👩‍👧‍👦 العربية\r\n')
      freeTerminal(handle)
    }
  })

  it('blinks the default cursor until a program asks for a steady one', async () => {
    const { runtime, call, newTerminal, freeTerminal, write } = await harness()
    const handle = newTerminal(80, 24)
    const { terminal } = handle
    const renderStateSlot = runtime.allocOpaque()
    expect(call('ghostty_render_state_new', 0, renderStateSlot)).toBe(0)
    const renderState = runtime.readPointer(renderStateSlot)
    const scratch = runtime.alloc(4)

    const blinking = () => {
      expect(call('ghostty_render_state_update', renderState, terminal)).toBe(0)
      expect(call('ghostty_render_state_get', renderState, RENDER_STATE_DATA_CURSOR_BLINKING, scratch)).toBe(0)
      return runtime.bytes(scratch, 1)[0] !== 0
    }
    const setDefaultCursorBlink = (blink: boolean) => {
      const value = runtime.alloc(1)
      runtime.bytes(value, 1)[0] = blink ? 1 : 0
      expect(call('ghostty_terminal_set', terminal, OPT_DEFAULT_CURSOR_BLINK, value)).toBe(0)
      runtime.free(value, 1)
    }

    // Ghostty's own default is a steady cursor; the blink exists only because the option asks.
    expect(blinking()).toBe(false)
    setDefaultCursorBlink(true)
    expect(blinking()).toBe(true)

    // Programs still own the cursor: DECSCUSR steady block and DEC mode 12 both stop the blink,
    // and DECSCUSR reset returns to the embedder default.
    write(terminal, '\u001b[2 q')
    expect(blinking()).toBe(false)
    write(terminal, '\u001b[0 q')
    expect(blinking()).toBe(true)
    write(terminal, '\u001b[?12l')
    expect(blinking()).toBe(false)
    write(terminal, '\u001b[?12h')
    expect(blinking()).toBe(true)

    // RIS keeps the embedder default in this Ghostty (t3code's older pin dropped it). A terminal
    // decoded from a snapshot is new, though, so the core still reapplies the option after one.
    call('ghostty_terminal_reset', terminal)
    expect(blinking()).toBe(true)

    runtime.free(scratch, 4)
    call('ghostty_render_state_free', renderState)
    runtime.freeOpaque(renderStateSlot)
    freeTerminal(handle)
  })

  it("reports and scrolls the viewport with Ghostty's scrollbar state", async () => {
    const { runtime, call, newTerminal, freeTerminal, write } = await harness()
    const handle = newTerminal(80, 10)
    const { terminal } = handle
    const limit = runtime.alloc(4)
    runtime.view(limit, 4).setUint32(0, 4 * 1024 * 1024, true)
    expect(call('ghostty_terminal_set', terminal, OPT_SCROLLBACK_MAX_BYTES, limit)).toBe(0)
    runtime.free(limit, 4)
    write(terminal, Array.from({ length: 50 }, (_, index) => `${index + 1}\r\n`).join(''))

    const scrollbar = runtime.alloc(24)
    const scrollbarView = () => runtime.view(scrollbar, 24)
    expect(call('ghostty_terminal_get', terminal, DATA_SCROLLBAR, scrollbar)).toBe(0)
    expect([0, 8, 16].map((offset) => Number(scrollbarView().getBigUint64(offset, true)))).toEqual([51, 41, 10])

    const scroll = runtime.alloc(24)
    runtime.view(scroll, 24).setUint32(0, 2, true)
    runtime.view(scroll, 24).setInt32(8, -5, true)
    call('ghostty_terminal_scroll_viewport', terminal, scroll)
    expect(call('ghostty_terminal_get', terminal, DATA_SCROLLBAR, scrollbar)).toBe(0)
    expect(Number(scrollbarView().getBigUint64(8, true))).toBe(36)

    runtime.free(scroll, 24)
    runtime.free(scrollbar, 24)
    freeTerminal(handle)
  })

  it('parses terminal queries without a reply callback (decision D06)', async () => {
    // The daemon's Ghostty answers queries; the window's has no write-PTY callback installed, and
    // a query must not reach a missing function-table entry.
    const { newTerminal, freeTerminal, write } = await harness()
    const handle = newTerminal(80, 24)
    expect(() => write(handle.terminal, '\u001b[5n\u001b[c\u001b[6n\u001b[>q')).not.toThrow()
    freeTerminal(handle)
  })

  it("formats the active selection with Ghostty's copy semantics", async () => {
    const { runtime, call, newTerminal, freeTerminal, write, formatSelection } = await harness()
    const handle = newTerminal(80, 24)
    write(handle.terminal, 'a\r\n\r\nb')
    const selection = runtime.alloc(32)
    runtime.view(selection, 32).setUint32(0, 32, true)
    expect(call('ghostty_terminal_select_all', handle.terminal, selection)).toBe(0)
    expect(call('ghostty_terminal_set', handle.terminal, OPT_SELECTION, selection)).toBe(0)
    expect(formatSelection(handle.terminal)).toBe('a\n\nb')
    runtime.free(selection, 32)
    freeTerminal(handle)
  })

  it('formats a cell-drag selection installed from screen grid refs', async () => {
    const { runtime, call, newTerminal, freeTerminal, write, formatSelection } = await harness()
    const handle = newTerminal(80, 24)
    const { terminal } = handle
    write(terminal, 'hello\r\nworld')

    const gridRefAt = (x: number, y: number) => {
      const point = runtime.alloc(24)
      const pointView = runtime.view(point, 24)
      pointView.setUint32(0, 2, true)
      pointView.setUint16(8, x, true)
      pointView.setUint32(12, y, true)
      const ref = runtime.alloc(12)
      runtime.view(ref, 12).setUint32(0, 12, true)
      expect(call('ghostty_terminal_grid_ref', terminal, point, ref)).toBe(0)
      runtime.free(point, 24)
      return ref
    }
    const start = gridRefAt(0, 0)
    const end = gridRefAt(4, 1)
    const selection = runtime.alloc(32)
    runtime.view(selection, 32).setUint32(0, 32, true)
    runtime.bytes(selection, 32).set(runtime.bytes(start, 12), 4)
    runtime.bytes(selection, 32).set(runtime.bytes(end, 12), 16)
    expect(call('ghostty_terminal_set', terminal, OPT_SELECTION, selection)).toBe(0)
    expect(formatSelection(terminal)).toBe('hello\nworld')

    runtime.free(selection, 32)
    runtime.free(end, 12)
    runtime.free(start, 12)
    freeTerminal(handle)
  })

  it('uses Ghostty for mouse encoding, word selection, and OSC 8 hit testing', async () => {
    const { runtime, call, u32, newTerminal, freeTerminal, write, readString, formatSelection, modeEnabled } =
      await harness()
    const handle = newTerminal(80, 24)
    const { terminal } = handle
    write(
      terminal,
      '\u001b[?1000h\u001b[?1006h\u001b]8;;https://example.com/docs\u001b\\linked\u001b]8;;\u001b\\ plain',
    )

    const tracking = runtime.alloc(1)
    expect(call('ghostty_terminal_get', terminal, DATA_MOUSE_TRACKING, tracking)).toBe(0)
    expect(runtime.bytes(tracking, 1)[0]).toBe(1)
    runtime.free(tracking, 1)
    expect(modeEnabled(terminal, 1003)).toBe(false)
    write(terminal, '\u001b[?1003h')
    expect(modeEnabled(terminal, 1003)).toBe(true)
    write(terminal, '\u001b[?1003l\u001b[?1000h')
    expect(modeEnabled(terminal, 1003)).toBe(false)

    const point = runtime.alloc(24)
    const pointView = runtime.view(point, 24)
    pointView.setUint32(0, 1, true)
    pointView.setUint16(8, 1, true)
    pointView.setUint32(12, 0, true)
    const gridRef = runtime.alloc(12)
    runtime.view(gridRef, 12).setUint32(0, 12, true)
    expect(call('ghostty_terminal_grid_ref', terminal, point, gridRef)).toBe(0)
    expect(
      readString((buffer, length, written) => call('ghostty_grid_ref_hyperlink_uri', gridRef, buffer, length, written)),
    ).toBe('https://example.com/docs')

    const selection = runtime.alloc(32)
    runtime.view(selection, 32).setUint32(0, 32, true)
    const wordOptions = runtime.alloc(24)
    runtime.view(wordOptions, 24).setUint32(0, 24, true)
    runtime.bytes(wordOptions + 4, 12).set(runtime.bytes(gridRef, 12))
    expect(call('ghostty_terminal_select_word', terminal, wordOptions, selection)).toBe(0)
    expect(call('ghostty_terminal_set', terminal, OPT_SELECTION, selection)).toBe(0)
    expect(formatSelection(terminal)).toBe('linked')

    const lineOptions = runtime.alloc(28)
    runtime.view(lineOptions, 28).setUint32(0, 28, true)
    runtime.bytes(lineOptions + 4, 12).set(runtime.bytes(gridRef, 12))
    expect(call('ghostty_terminal_select_line', terminal, lineOptions, selection)).toBe(0)
    expect(call('ghostty_terminal_set', terminal, OPT_SELECTION, selection)).toBe(0)
    expect(formatSelection(terminal)).toBe('linked plain')

    const mouseEncoderSlot = runtime.allocOpaque()
    const mouseEventSlot = runtime.allocOpaque()
    expect(call('ghostty_mouse_encoder_new', 0, mouseEncoderSlot)).toBe(0)
    expect(call('ghostty_mouse_event_new', 0, mouseEventSlot)).toBe(0)
    const mouseEncoder = runtime.readPointer(mouseEncoderSlot)
    const mouseEvent = runtime.readPointer(mouseEventSlot)
    call('ghostty_mouse_encoder_setopt_from_terminal', mouseEncoder, terminal)
    const mouseSize = runtime.alloc(36)
    for (const [offset, value] of [
      [0, 36],
      [4, 800],
      [8, 480],
      [12, 10],
      [16, 20],
    ] as const) {
      runtime.view(mouseSize, 36).setUint32(offset, value, true)
    }
    call('ghostty_mouse_encoder_setopt', mouseEncoder, 2, mouseSize)
    call('ghostty_mouse_event_set_action', mouseEvent, 0)
    call('ghostty_mouse_event_set_button', mouseEvent, 1)
    const mousePosition = runtime.alloc(8)
    runtime.view(mousePosition, 8).setFloat32(0, 15, true)
    runtime.view(mousePosition, 8).setFloat32(4, 25, true)
    call('ghostty_mouse_event_set_position', mouseEvent, mousePosition)
    const mouseOutput = runtime.alloc(128)
    const written = runtime.alloc(4)
    expect(call('ghostty_mouse_encoder_encode', mouseEncoder, mouseEvent, mouseOutput, 128, written)).toBe(0)
    expect(textDecoder.decode(runtime.bytes(mouseOutput, u32(written)))).toBe('\u001b[<0;2;2M')

    call('ghostty_mouse_event_free', mouseEvent)
    call('ghostty_mouse_encoder_free', mouseEncoder)
    runtime.freeOpaque(mouseEventSlot)
    runtime.freeOpaque(mouseEncoderSlot)
    runtime.free(written, 4)
    runtime.free(mouseOutput, 128)
    runtime.free(mousePosition, 8)
    runtime.free(mouseSize, 36)
    runtime.free(lineOptions, 28)
    runtime.free(wordOptions, 24)
    runtime.free(selection, 32)
    runtime.free(gridRef, 12)
    runtime.free(point, 24)
    freeTerminal(handle)
  })

  it('encodes modified printable keys in Kitty keyboard mode', async () => {
    const { runtime, call, newTerminal, freeTerminal, write, readString } = await harness()
    const handle = newTerminal(80, 24)
    const { terminal } = handle
    write(terminal, '\u001b[>1u')

    const encoderSlot = runtime.allocOpaque()
    const eventSlot = runtime.allocOpaque()
    expect(call('ghostty_key_encoder_new', 0, encoderSlot)).toBe(0)
    expect(call('ghostty_key_event_new', 0, eventSlot)).toBe(0)
    const keyEncoder = runtime.readPointer(encoderSlot)
    const keyEvent = runtime.readPointer(eventSlot)
    call('ghostty_key_encoder_setopt_from_terminal', keyEncoder, terminal)
    call('ghostty_key_event_set_action', keyEvent, 1)
    call('ghostty_key_event_set_key', keyEvent, ghosttyKeyForCode('KeyC'))
    call('ghostty_key_event_set_mods', keyEvent, 1 << 1)
    call('ghostty_key_event_set_consumed_mods', keyEvent, 0)
    call('ghostty_key_event_set_composing', keyEvent, 0)

    const setText = (text: string) => {
      const input = textEncoder.encode(text)
      const pointer = runtime.alloc(input.length)
      runtime.bytes(pointer, input.length).set(input)
      call('ghostty_key_event_set_unshifted_codepoint', keyEvent, text.codePointAt(0)!)
      call('ghostty_key_event_set_utf8', keyEvent, pointer, input.length)
      return () => runtime.free(pointer, input.length)
    }
    const encode = () =>
      readString((buffer, length, written) =>
        call('ghostty_key_encoder_encode', keyEncoder, keyEvent, buffer, length, written),
      )

    const freeC = setText('c')
    expect(encode()).toBe('\u001b[99;5u')
    const freeJ = setText('j')
    expect(encode()).toBe('\u001b[106;5u')

    // Without the Kitty report-event-types flag a release encodes nothing, so the surface's keyup
    // handler stays silent for legacy sessions.
    call('ghostty_key_event_set_action', keyEvent, 0)
    const written = runtime.alloc(4)
    expect(call('ghostty_key_encoder_encode', keyEncoder, keyEvent, 0, 0, written)).toBe(0)
    expect(runtime.view(written, 4).getUint32(0, true)).toBe(0)
    runtime.free(written, 4)

    // With report-event-types enabled the same release encodes an event-typed code.
    write(terminal, '\u001b[>3u')
    call('ghostty_key_encoder_setopt_from_terminal', keyEncoder, terminal)
    expect(encode()).toBe('\u001b[106;5:3u')

    freeJ()
    freeC()
    call('ghostty_key_event_free', keyEvent)
    call('ghostty_key_encoder_free', keyEncoder)
    runtime.freeOpaque(eventSlot)
    runtime.freeOpaque(encoderSlot)
    freeTerminal(handle)
  })
})
