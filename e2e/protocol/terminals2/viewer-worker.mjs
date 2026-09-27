// A desktop-shaped terminal viewer on a worker thread: the SDK's terminal
// connection feeding the adapter's TerminalFeed and a real xterm core, with
// input from xterm sent back as the adapter sends it. While `gate[0]` is 0
// every output frame blocks the thread for one millisecond per
// `bytesPerMs` bytes, so the viewer reads its stream slower than a flood
// produces it; the test sets `gate[0]` to 1
// to let it read freely. It runs on its own thread so its blocked loop never
// stalls the test.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parentPort, workerData } from 'node:worker_threads'

const { clientPath, feedPath, terminalPackage, socket, workspaceId, terminalId, gateBuffer, bytesPerMs } = workerData
const gate = new Int32Array(gateBuffer)
const { openTerminalConnection } = await import(pathToFileURL(clientPath).href)
const { TerminalFeed, suppressReplies } = await import(pathToFileURL(feedPath).href)
const { Terminal } = createRequire(join(terminalPackage, 'package.json'))('@xterm/xterm')

const terminal = new Terminal({ cols: 100, rows: 30, convertEol: false, scrollback: 10_000, allowProposedApi: true })
suppressReplies(terminal)
const statuses = []
const errors = []
let closed = null
let snapshots = 0
let resyncs = 0
let failed = false
let connection = null
const feed = new TerminalFeed(terminal, {
  status: (message) => statuses.push(message),
  ready: () => {},
  failed: () => { failed = true; connection?.dispose() },
})
terminal.onData((data) => { if (feed.ready) connection?.input(data) })
connection = openTerminalConnection(socket, workspaceId, terminalId, (frame) => {
  if (Atomics.load(gate, 0) === 0 && Array.isArray(frame.bytes)) {
    Atomics.wait(gate, 0, 0, Math.max(1, frame.bytes.length / bytesPerMs))
  }
  if (frame.type === 'snapshot') snapshots += 1
  if (frame.type === 'snapshot' && frame.resync === true) resyncs += 1
  if (frame.type === 'error') errors.push(frame)
  feed.push(frame)
}, (reason) => { closed = reason })

function screen() {
  const buffer = terminal.buffer.active
  const lines = []
  for (let row = 0; row < terminal.rows; row++) {
    lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '')
  }
  return { buffer: buffer.type, cols: terminal.cols, rows: terminal.rows, cursor: [buffer.cursorX, buffer.cursorY],
    lines, modes: { ...terminal.modes } }
}

parentPort.on('message', (message) => {
  if (message.type === 'report') {
    terminal.write('', () => parentPort.postMessage({
      sdk: { offset: connection.offset(), resyncs: connection.resyncs(), incarnation: connection.incarnation() },
      feed: { ready: feed.ready, failed },
      snapshots, resyncs, errors, statuses, closed, screen: screen(),
    }))
  } else if (message.type === 'close') {
    connection.dispose()
    feed.dispose()
    terminal.dispose()
    parentPort.close()
  }
})
parentPort.postMessage({ started: true })
