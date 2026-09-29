// Real-terminal benchmark: 4 workspaces × 6 live daemon terminals streaming output, set up through
// the CLI against the dev daemon, then workspace switches driven by clicking the navigator.
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import * as d from './driver.mjs'

const root = '/Users/lakshyakumar/work/lux-ade'
const socket = process.argv[2]
const scratch = join(process.env.TMPDIR ?? '/tmp', 'ade-realbench-folders')
const ade = (...args) =>
  JSON.parse(execFileSync('node', [join(root, 'apps/cli/dist/index.js'), '--socket', socket, ...args], { encoding: 'utf8' }))

const window = ade('window', 'list').windows.find((w) => w.state === 'open').id
const run = Date.now().toString(36)
const names = ['bench-a', 'bench-b', 'bench-c', 'bench-d']
const workspaces = []
for (const name of names) {
  mkdirSync(join(scratch, name), { recursive: true })
  const ws = ade('workspace', 'open', realpathSync(join(scratch, name))).workspace
  workspaces.push(ws)
  ade('window', 'show', window, ws.id)
  const first = ade('layout', 'get', '--window', window).layout.layout.root.id
  ade('pane', 'split', first, '--direction', 'row', '--id', `${name}-b`, '--window', window)
  ade('pane', 'split', `${name}-b`, '--direction', 'column', '--id', `${name}-c`, '--window', window)
  const panes = [first, first, `${name}-b`, `${name}-b`, `${name}-c`, `${name}-c`]
  for (const [index, pane] of panes.entries()) {
    const id = ade('--operation-id', `${name}-t${index}-${run}`, 'terminal', 'create', ws.id, '--title', `${name} ${index}`).terminal_id
    ade('tab', 'open', 'terminal', id, '--pane', pane, '--id', `${name}-tab${index}`, '--window', window)
    ade('terminal', 'send', ws.id, id, `while true; do seq 1 60; sleep 0.1; done\n`)
  }
}
console.log('set up', workspaces.length, 'workspaces × 6 terminals')

const row = (name) => `[...document.querySelectorAll('[aria-label="Projects"] button')].find((b) => b.textContent === '${name}')`
const clickRow = async (name) => {
  const box = await d.evaluate(`(() => { const r = ${row(name)}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  for (const type of ['mousePressed', 'mouseReleased'])
    await d.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 })
}
for (const name of names) { await clickRow(name); await d.sleep(1500) }
await d.sleep(2000)

await d.evaluate(`window.__long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration) }).observe({ type: 'longtask', buffered: false })`)
const start = () => d.evaluate(`window.__long.length = 0; window.__f = []; { let last = performance.now(); const tick = (t) => { window.__f.push(t - last); last = t; window.__raf = requestAnimationFrame(tick) }; window.__raf = requestAnimationFrame(tick) }`)
const stop = () => d.evaluate(`(() => { cancelAnimationFrame(window.__raf); const f = window.__f.slice(1).sort((a, b) => a - b); const n = f.length; const p = (q) => f[Math.min(n - 1, Math.floor(q * n))]; return { frames: n, avg: +(f.reduce((a, b) => a + b, 0) / n).toFixed(1), p95: +p(0.95).toFixed(1), worst: +f[n - 1].toFixed(1), over20: f.filter((x) => x > 20).length, over33: f.filter((x) => x > 33.4).length, longestTask: Math.round(Math.max(0, ...window.__long)) } })()`)
const rows = []
async function scenario(name, action) {
  await d.sleep(500)
  await start()
  await action()
  await d.sleep(300)
  rows.push({ scenario: name, ...(await stop()), canvases: await d.evaluate(`document.querySelectorAll('[data-terminal] canvas').length`) })
}
await scenario('idle, 3 terminals shown, all 24 streaming', () => d.sleep(3000))
await scenario('switch workspace every 400ms (×8)', async () => { for (const n of [...names, ...names]) { await clickRow(n); await d.sleep(400) } })
await scenario('switch workspace every 100ms (×12)', async () => { for (const n of [...names, ...names, ...names]) { await clickRow(n); await d.sleep(100) } })
console.table(rows)
console.log('errors', d.errors.slice(0, 5))
const rss = execFileSync('sh', ['-c', "ps -axo rss,command | grep 'Electron' | grep lux-ade | grep -v grep | awk '{s+=$1} END {print s}'"], { encoding: 'utf8' })
console.log('Electron processes RSS MB', Math.round(Number(rss) / 1024))

// Clean up: stop the benchmark terminals and remove the workspaces.
for (const ws of workspaces) {
  for (const t of ade('terminal', 'list', ws.id).terminals.filter((t) => !t.primary)) ade('terminal', 'close', t.id, '--force')
  ade('--operation-id', `rm-${ws.id}-${run}`, 'workspace', 'remove', ws.id)
}
d.close()
