// Drives the running ADE window with real input over its DevTools port: mouse presses and moves
// hit-tested by Chromium, the engine's own drag session (intercepted, then fed drag events at screen
// points), and key events. Collects console errors and exceptions.
const targets = await (await fetch('http://127.0.0.1:9333/json/list')).json()
const page = targets.find((t) => t.type === 'page' && t.url.startsWith(process.env.PAGE_PREFIX ?? 'http://localhost:5173'))
if (!page) throw new Error('No app window')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => socket.addEventListener('open', r))
let id = 0
const waiting = new Map()
const listeners = new Set()
export const errors = []
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && waiting.has(message.id)) {
    waiting.get(message.id)(message)
    waiting.delete(message.id)
    return
  }
  if (message.method === 'Runtime.exceptionThrown')
    errors.push('exception: ' + (message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text))
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error')
    errors.push('console.error: ' + message.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300))
  for (const listen of listeners) listen(message)
})
export const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mine = ++id
    waiting.set(mine, (m) => (m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result)))
    socket.send(JSON.stringify({ id: mine, method, params }))
  })
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await send('Runtime.enable')

export async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error('evaluate: ' + (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text))
  return result.result.value
}

/** Centre (or an offset from the top-left, or fractions of the size) of the index-th match. */
export async function point(selector, { index = 0, x, y, fx, fy } = {}) {
  const r = await evaluate(`(() => { const e = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height } })()`)
  if (!r) throw new Error('no element ' + selector + ' #' + index)
  return {
    x: r.left + (x ?? (fx ?? 0.5) * r.width),
    y: r.top + (y ?? (fy ?? 0.5) * r.height),
  }
}

const mouse = (type, { x, y }, extra = {}) =>
  send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra })

export async function click(at) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, button: 'none', buttons: 0 })
  await mouse('mousePressed', at)
  await mouse('mouseReleased', at)
  await sleep(50)
}

const KEYS = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Escape: 27 }
/** modifiers: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export async function key(name, modifiers = 0) {
  const base = { key: name, code: name, windowsVirtualKeyCode: KEYS[name], modifiers }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  await sleep(50)
}

const steps = (from, to, n) => Array.from({ length: n }, (_, i) => ({ x: from.x + ((to.x - from.x) * (i + 1)) / n, y: from.y + ((to.y - from.y) * (i + 1)) / n }))

/**
 * A real drag: press at `from`, move until Chromium starts a drag session, then move through
 * `path` (each entry a point, or { at, hold } to linger, or { at, check } to run a check there).
 * Ends with a drop at the last point, or cancels (what Esc does) with end: 'cancel'.
 * Returns whether the engine started a drag.
 */
export async function drag(from, path, { end = 'drop' } = {}) {
  await send('Input.setInterceptDrags', { enabled: true })
  let data
  const got = new Promise((resolve) => {
    const listen = (m) => {
      if (m.method === 'Input.dragIntercepted') {
        data = m.params.data
        listeners.delete(listen)
        resolve(true)
      }
    }
    listeners.add(listen)
    setTimeout(() => {
      listeners.delete(listen)
      resolve(false)
    }, 1500)
  })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0 })
  await mouse('mousePressed', from)
  for (const p of steps(from, { x: from.x + 12, y: from.y + 6 }, 4)) await mouse('mouseMoved', p)
  const started = await got
  if (!started) {
    await mouse('mouseReleased', from)
    await send('Input.setInterceptDrags', { enabled: false })
    return false
  }
  const dragEvent = (type, at) => send('Input.dispatchDragEvent', { type, x: at.x, y: at.y, data })
  let last = { x: from.x + 12, y: from.y + 6 }
  await dragEvent('dragEnter', last)
  const results = []
  for (const entry of path) {
    const at = entry.at ?? entry
    for (const p of steps(last, at, 6)) {
      await dragEvent('dragOver', p)
      await sleep(8)
    }
    last = at
    // Chromium sends dragover every ~50ms while the pointer rests.
    const until = Date.now() + (entry.hold ?? 60)
    while (Date.now() < until) {
      await dragEvent('dragOver', at)
      await sleep(50)
    }
    if (entry.check) results.push(await entry.check())
  }
  if (end === 'drop') await dragEvent('drop', last)
  else await dragEvent('dragCancel', last)
  await mouse('mouseReleased', last)
  await send('Input.setInterceptDrags', { enabled: false })
  // The user's pointer moves on, which clears the library's post-drop shield.
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: last.x + 3, y: last.y + 3, button: 'none', buttons: 0 })
  await sleep(120)
  return { started: true, results }
}

// ---- Page state ----
export const shape = (node) =>
  node.type === 'pane' ? node.id : `${node.direction}(${node.children.map(shape).join(',')})`
export const panesOf = (node) => (node.type === 'pane' ? [node] : node.children.flatMap(panesOf))

export async function seed(layoutValue) {
  await evaluate(`localStorage.setItem('ade.layouts:main', ${JSON.stringify(JSON.stringify({ state: { layouts: { default: layoutValue }, keepMounted: 3 }, version: 1 }))}); location.reload()`).catch(() => {})
  for (let i = 0; i < 100; i++) {
    await sleep(100)
    const ready = await evaluate(`document.querySelectorAll('[data-pane-drop]').length`).catch(() => 0)
    if (ready >= panesOf(layoutValue.root).length) break
  }
  // React Scan's dev toolbar floats over the navigator's grip; tests need the grip.
  await evaluate(`(() => { const s = document.createElement('style'); s.textContent = '#react-scan-root { display: none !important }'; document.head.append(s) })()`)
  await sleep(300)
}

/** A layout with panes given as lists of tab titles; `shape` 'row' or 'column' of them. */
export function makeLayout(paneTabs, direction = 'row', extra = {}) {
  const tabs = {}
  const panes = paneTabs.map((titles, i) => {
    const ids = titles.map((title) => {
      const tabId = 'tab-' + title
      tabs[tabId] = { id: tabId, kind: 'terminal', title }
      return tabId
    })
    return { type: 'pane', id: 'p' + (i + 1), tabs: ids, active: ids[0] ?? null }
  })
  const root =
    panes.length === 1
      ? panes[0]
      : { type: 'split', id: 'split-root', direction, children: panes, sizes: panes.map(() => 100 / panes.length) }
  return {
    version: 1,
    sidebars: ['navigator', 'inspector'],
    collapsed: { navigator: false, inspector: false },
    widths: { navigator: 260, inspector: 340 },
    tabs,
    root,
    focusedPane: panes[0].id,
    ...extra,
  }
}

/** Titles in each pane, in order: [['A','B'], ['C']]. */
export async function titles() {
  const l = await layout()
  return panesOf(l.root).map((p) => p.tabs.map((t) => l.tabs[t].title))
}

export const close = () => socket.close()

/** A point on the element an expression returns. */
export async function at(expression, { x, y, fx, fy } = {}) {
  const r = await evaluate(`(() => { const e = ${expression}; if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height } })()`)
  if (!r) throw new Error('no element: ' + expression)
  return { x: r.left + (x ?? (fx ?? 0.5) * r.width), y: r.top + (y ?? (fy ?? 0.5) * r.height) }
}
export const tabEl = (title) => `[...document.querySelectorAll('[role=tab]')].find((e) => e.textContent.trim() === ${JSON.stringify(title)})`
export const bodyEl = (i) => `document.querySelectorAll('[data-pane-drop]')[${i}]`
export const paneGripEl = (i) => `document.querySelectorAll('[aria-label="Move pane"]')[${i}]`
export const dockEl = (edge) => `document.querySelector('[data-dock-edge=${edge}]')`

/** Hidden pages draw no frames and run no resize observers; keep the window visible while testing. */
export async function ensureVisible() {
  const visible = await evaluate('document.visibilityState')
  if (visible === 'visible') return
  await send('Page.enable')
  await send('Page.bringToFront')
  await sleep(400)
}
