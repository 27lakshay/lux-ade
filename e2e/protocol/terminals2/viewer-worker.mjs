// A desktop-shaped terminal viewer on a worker thread: the SDK's terminal connection, asking for
// Ghostty snapshots, feeding the adapter's TerminalFeed and the window's Ghostty WebAssembly core.
// While `gate[0]` is 0 every output frame blocks the thread for one millisecond per `bytesPerMs`
// bytes, so the viewer reads its stream slower than a flood produces it; the test sets `gate[0]`
// to 1 to let it read freely. It runs on its own thread so its blocked loop never stalls the test.
import { readFile } from 'node:fs/promises'
import { register } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parentPort, workerData } from 'node:worker_threads'

register('./ts-resolve.mjs', import.meta.url)

const { clientPath, terminalSource, socket, workspaceId, terminalId, gateBuffer, bytesPerMs } = workerData
const gate = new Int32Array(gateBuffer)
const source = (path) => import(pathToFileURL(join(terminalSource, path)).href)
const { openTerminalConnection } = await import(pathToFileURL(clientPath).href)
const { TerminalFeed } = await source('feed.ts')
const { GHOSTTY_CELL_WIDE, GhosttyTerminalCore } = await source('ghostty/core.ts')
const { setGhosttyWasmSource } = await source('ghostty/runtime.ts')

setGhosttyWasmSource(() => readFile(join(terminalSource, 'ghostty/vendor/ghostty-vt.wasm')))
const white = { r: 255, g: 255, b: 255 }
const core = await GhosttyTerminalCore.create(100, 30, 8, 16, {
  foreground: white,
  background: { r: 0, g: 0, b: 0 },
  cursor: white,
})
const statuses = []
const errors = []
let closed = null
let snapshots = 0
let resyncs = 0
let failed = false
let connection = null
const feed = new TerminalFeed(core, {
  status: (message) => statuses.push(message),
  ready: () => {},
  failed: () => {
    failed = true
    connection?.dispose()
  },
})
connection = openTerminalConnection(
  socket,
  workspaceId,
  terminalId,
  (frame) => {
    if (Atomics.load(gate, 0) === 0 && Array.isArray(frame.bytes)) {
      Atomics.wait(gate, 0, 0, Math.max(1, frame.bytes.length / bytesPerMs))
    }
    if (frame.type === 'snapshot') snapshots += 1
    if (frame.type === 'snapshot' && frame.resync === true) resyncs += 1
    if (frame.type === 'error') errors.push(frame)
    feed.push(frame)
  },
  (reason) => {
    closed = reason
  },
  { snapshotFormat: 'ghostty' },
)

/** The same shape as `screenOf` in viewer.ts. */
function screen() {
  const snapshot = core.snapshot()
  const mode = (number) => core.isModeEnabled(number)
  return {
    buffer: core.isAlternateScreen() ? 'alternate' : 'normal',
    cols: snapshot.cols,
    rows: snapshot.rows,
    cursor: [snapshot.cursorX, snapshot.cursorY],
    lines: snapshot.rowData.map((row) =>
      row.cells
        .filter((cell) => cell.wide !== GHOSTTY_CELL_WIDE.spacerTail && cell.wide !== GHOSTTY_CELL_WIDE.spacerHead)
        .map((cell) => cell.text || ' ')
        .join('')
        .trimEnd(),
    ),
    modes: {
      bracketedPasteMode: mode(2004),
      applicationCursorKeysMode: mode(1),
      mouseTrackingMode: mode(1003) ? 'any' : mode(1002) ? 'drag' : mode(1000) ? 'vt200' : mode(9) ? 'x10' : 'none',
    },
  }
}

parentPort.on('message', (message) => {
  if (message.type === 'report') {
    parentPort.postMessage({
      sdk: { offset: connection.offset(), resyncs: connection.resyncs(), incarnation: connection.incarnation() },
      feed: { ready: feed.ready, failed },
      snapshots,
      resyncs,
      errors,
      statuses,
      closed,
      screen: screen(),
    })
  } else if (message.type === 'close') {
    connection.dispose()
    feed.dispose()
    core.dispose()
    parentPort.close()
  }
})
parentPort.postMessage({ started: true })
