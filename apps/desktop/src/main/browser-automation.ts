// Agent browser automation (F095) on one exact tab's page. Every operation
// resolves the named tab under the live owner lease, never the selected or
// focused one. Click, type and evaluate drive the page through its debugger;
// DevTools and debugger clients outside ADE refuse them before anything
// reaches the page. The pure checks and scripts live in browser-automation-core.ts.
import type { WebContents } from 'electron'
import { browserTabPage, mutateBrowserOwner } from './browser'
import {
  AUTOMATION_WORLD,
  actionabilityScript,
  boundEvaluation,
  decideAttachment,
  expressionProblem,
  focusScript,
  probeScript,
  readActionability,
  readProbe,
  selectorProblem,
  timeoutWithin,
  waitSatisfied,
  type WaitState,
} from './browser-automation-core'
import { fitWithin, pickEncoding, recordUrl } from './browser-capture-core'
import { diagnosticsHoldsDebugger } from './browser-diagnostics'

/** Bounds one debugger round trip or short page script. */
const STEP_MS = 2000
const WAIT_STATES = new Set(['attached', 'visible', 'detached', 'hidden'])

function within<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

/** One automation step at a time per page, so two callers never share a debugger turn. */
const queues = new WeakMap<WebContents, Promise<unknown>>()
function serialized<T>(contents: WebContents, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(contents) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(task)
  queues.set(
    contents,
    next.catch(() => undefined),
  )
  return next
}

async function livePage(profileId: string, tabId: unknown): Promise<{ tabId: string; contents: WebContents }> {
  const page = await browserTabPage(profileId, tabId)
  const contents = page.contents
  if (!contents || contents.isDestroyed())
    throw new Error('unavailable: the browser tab has no live page; show or navigate it first')
  if (contents.isCrashed()) throw new Error('unavailable: the tab page crashed')
  return { tabId: page.tabId, contents }
}

type Debugger = { send: (method: string, params?: Record<string, unknown>) => Promise<unknown>; release: () => void }

/** Takes the page's debugger as `decideAttachment` allows, or throws `conflict:`. */
function takeDebugger(contents: WebContents): Debugger {
  const debug = contents.debugger
  const decision = decideAttachment({
    devtoolsOpen: contents.isDevToolsOpened(),
    debuggerAttached: debug.isAttached(),
    heldByDiagnostics: diagnosticsHoldsDebugger(contents),
  })
  if (decision.action === 'refuse') throw new Error(`conflict: ${decision.message}`)
  let attached = false
  if (decision.action === 'attach') {
    try {
      debug.attach('1.3')
    } catch (error) {
      throw new Error(`conflict: the debugger could not attach, as when DevTools holds the tab: ${String(error)}`)
    }
    attached = true
  }
  let detachedReason: string | null = null
  const onDetach = (_event: unknown, reason: string): void => {
    detachedReason = reason || 'detached'
  }
  debug.on('detach', onDetach)
  return {
    send: async (method, params) => {
      if (detachedReason) throw new Error(`conflict: the debugger detached (${detachedReason}), as when DevTools opens`)
      try {
        return await within(debug.sendCommand(method, params), STEP_MS, `the debugger did not answer ${method}`)
      } catch (error) {
        if (detachedReason)
          throw new Error(`conflict: the debugger detached (${detachedReason}), as when DevTools opens`)
        throw error
      }
    },
    release: () => {
      if (contents.isDestroyed()) return
      debug.removeListener('detach', onDetach)
      if (attached && debug.isAttached()) {
        try {
          debug.detach()
        } catch {
          /* Already detached. */
        }
      }
    },
  }
}

/** Watches for a main-frame navigation or the page going away. */
function watchPage(contents: WebContents): { moved: () => boolean; stop: () => void } {
  let moved = false
  const onNavigate = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>): void => {
    if (details.isMainFrame && !details.isSameDocument) moved = true
  }
  const onGone = (): void => {
    moved = true
  }
  contents.on('did-start-navigation', onNavigate)
  contents.once('destroyed', onGone)
  contents.once('render-process-gone', onGone)
  return {
    moved: () => moved || contents.isDestroyed(),
    stop: () => {
      if (contents.isDestroyed()) return
      contents.off('did-start-navigation', onNavigate)
      contents.off('destroyed', onGone)
      contents.off('render-process-gone', onGone)
    },
  }
}

function isolated(contents: WebContents, code: string, ms: number, message: string): Promise<unknown> {
  return within(contents.executeJavaScriptInIsolatedWorld(AUTOMATION_WORLD, [{ code }], false), ms, message)
}

/**
 * Runs a click or type on one exact tab. Everything before `commit` only
 * prepares: it resolves the page, waits for the element and takes the
 * debugger, and a failure there sends no input. `commit` durably marks the
 * receipt dispatching; only then does input reach the page.
 */
async function runInput(
  profileId: string,
  op: 'browser.click' | 'browser.type',
  tabId: unknown,
  selector: string,
  text: string | undefined,
  replace: boolean,
  timeoutMs: number,
  commit: () => Promise<void>,
): Promise<string> {
  const page = await livePage(profileId, tabId)
  const { contents } = page
  return serialized(contents, async () => {
    const watch = watchPage(contents)
    let debug: Debugger | null = null
    try {
      // Refuse a DevTools or foreign debugger before waiting on the page.
      debug = takeDebugger(contents)
      const raw = await isolated(
        contents,
        actionabilityScript(selector, op === 'browser.type', timeoutMs),
        timeoutMs + STEP_MS,
        'unavailable: the page did not answer in time',
      )
      const target = readActionability(raw)
      if (!target.ok) throw new Error(`${target.code}: ${target.message}`)
      if (op === 'browser.type') {
        const focus = await isolated(
          contents,
          focusScript(selector, replace),
          STEP_MS,
          'unavailable: the page did not focus in time',
        )
        if (!focus || typeof focus !== 'object' || (focus as { focused?: unknown }).focused !== true) {
          throw new Error('unavailable: the element did not take focus')
        }
      }
      if (watch.moved()) throw new Error('unavailable: the page navigated or closed before input; nothing was sent')
      await commit()
      if (op === 'browser.click') {
        const { x, y } = target.point
        await debug.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
        await debug.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x,
          y,
          button: 'left',
          buttons: 1,
          clickCount: 1,
        })
        await debug.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x,
          y,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        })
      } else {
        await debug.send('Input.insertText', { text })
      }
      return page.tabId
    } finally {
      debug?.release()
      watch.stop()
    }
  })
}

/** The click or type action `mutateBrowserOwner` runs under its receipt. */
export function browserInputMutation(
  browserProfileId: string,
  profileId: string,
  ownerId: string,
  op: 'browser.click' | 'browser.type',
  value: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const timeoutMs = timeoutWithin(value.timeout_ms, 100, 10_000, 5000)
  if (timeoutMs === null)
    throw new Error('Invalid browser automation request: timeout_ms must be between 100 and 10000')
  if (op === 'browser.type' && value.replace !== undefined && typeof value.replace !== 'boolean') {
    throw new Error('Invalid browser automation request: replace must be true or false')
  }
  const selector = value.selector as string
  const text = op === 'browser.type' ? (value.text as string) : undefined
  const replace = value.replace === true
  return mutateBrowserOwner(
    browserProfileId,
    profileId,
    ownerId,
    op,
    value.operation_id,
    value.payload_fingerprint,
    value.tab_id,
    undefined,
    undefined,
    {
      selector,
      text,
      replace: op === 'browser.type' ? replace : undefined,
      run: (commit) => runInput(browserProfileId, op, value.tab_id, selector, text, replace, timeoutMs, commit),
    },
  )
}

/** `browser.evaluate`: a read-only expression, refused by V8 when it may have side effects. */
export async function evaluateInTab(
  profileId: string,
  tabId: unknown,
  expression: unknown,
  timeout: unknown,
): Promise<Record<string, unknown>> {
  const problem = expressionProblem(expression)
  if (problem) throw new Error(`invalid_request: ${problem}`)
  const timeoutMs = timeoutWithin(timeout, 50, 5000, 1000)
  if (timeoutMs === null) throw new Error('invalid_request: timeout_ms must be between 50 and 5000')
  const page = await livePage(profileId, tabId)
  const { contents } = page
  return serialized(contents, async () => {
    const debug = takeDebugger(contents)
    try {
      const reply = await debug.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        throwOnSideEffect: true,
        timeout: timeoutMs,
        silent: true,
        awaitPromise: false,
        includeCommandLineAPI: false,
        userGesture: false,
      })
      const outcome = boundEvaluation(reply)
      if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`)
      return {
        type: 'browser_evaluation',
        tab_id: page.tabId,
        url: recordUrl(contents.getURL()) ?? '',
        ...outcome.evaluation,
      }
    } finally {
      debug.release()
    }
  })
}

/** `browser.wait`: polls the selector's state until it holds or time runs out. */
export async function waitInTab(
  profileId: string,
  tabId: unknown,
  selector: unknown,
  state: unknown,
  timeout: unknown,
): Promise<Record<string, unknown>> {
  const problem = selectorProblem(selector)
  if (problem) throw new Error(`invalid_request: ${problem}`)
  if (state !== undefined && !WAIT_STATES.has(state as string)) throw new Error('invalid_request: unknown wait state')
  const timeoutMs = timeoutWithin(timeout, 0, 10_000, 5000)
  if (timeoutMs === null) throw new Error('invalid_request: timeout_ms must be between 0 and 10000')
  const wanted = (state ?? 'visible') as WaitState
  const page = await livePage(profileId, tabId)
  const { contents } = page
  const started = Date.now()
  // A navigation is not an error: the wait keeps probing the tab's new document.
  for (;;) {
    if (contents.isDestroyed()) throw new Error('unavailable: the tab page closed during the wait')
    const probe = readProbe(
      await isolated(
        contents,
        probeScript(selector as string),
        STEP_MS,
        'unavailable: the page did not answer in time',
      ),
    )
    if (probe === 'invalid_selector') throw new Error('invalid_request: the page rejected the selector')
    if (!probe) throw new Error('unavailable: the page gave no answer')
    const elapsed = Date.now() - started
    const satisfied = waitSatisfied(wanted, probe)
    if (satisfied || elapsed >= timeoutMs) {
      return {
        type: 'browser_wait',
        tab_id: page.tabId,
        selector,
        state: wanted,
        satisfied,
        elapsed_ms: elapsed,
        url: recordUrl(contents.getURL()) ?? '',
      }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, timeoutMs - elapsed)))
  }
}

/** `browser.screenshot`: the visible viewport, scaled and encoded within bounds. */
export async function screenshotTab(profileId: string, tabId: unknown): Promise<Record<string, unknown>> {
  const page = await livePage(profileId, tabId)
  const { contents } = page
  let image: Electron.NativeImage
  try {
    image = await within(contents.capturePage(undefined, { stayHidden: true }), STEP_MS, 'capture timed out')
  } catch {
    throw new Error('unavailable: the page could not be captured')
  }
  // A page no window has painted yields no bitmap.
  if (image.isEmpty()) throw new Error('unavailable: the page is not painted; show the tab and retry')
  const size = image.getSize()
  const fit = fitWithin(size.width, size.height)
  const scaled = fit.width !== size.width || fit.height !== size.height
  const shown = scaled ? image.resize({ width: fit.width, height: fit.height, quality: 'good' }) : image
  const bytes = pickEncoding((format, quality) => (format === 'png' ? shown.toPNG() : shown.toJPEG(quality)))
  if (!bytes) throw new Error('unavailable: the screenshot does not fit the reply bound')
  const png = bytes[0] === 0x89 && bytes[1] === 0x50
  return {
    type: 'browser_screenshot',
    tab_id: page.tabId,
    url: recordUrl(contents.getURL()) ?? '',
    media_type: png ? 'image/png' : 'image/jpeg',
    data: Buffer.from(bytes).toString('base64'),
    width: fit.width,
    height: fit.height,
    scaled,
    captured_at_ms: Date.now(),
  }
}
