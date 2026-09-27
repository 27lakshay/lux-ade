// Pure cores for agent browser automation (F095): request checks, the
// debugger attachment decision, evaluation result bounding, the wait rule and
// the in-page scripts. Nothing here touches Electron (AGENTS.md test policy).
// The page is untrusted: everything it returns is re-checked here.
//
// Portions adapted from Paseo packages/desktop/src/features/browser-automation/actionability.ts
// (Apache-2.0, © 2025-present Mohamed Boudra): the actionability loop in
// `actionabilityScript` (visible, enabled, editable, stable, not covered, then
// the clamped centre point). Changed: selector lookup instead of snapshot
// refs, a `not_found` result, and a bounded result reader.

/** The isolated world automation scripts run in, apart from page scripts. */
export const AUTOMATION_WORLD = 1095
export const AUTOMATION_LIMITS = {
  selector: 1024, text: 4096, expression: 8192,
  /** The largest evaluation value, as JSON bytes, that is returned. */
  valueBytes: 64 * 1024,
  exception: 1024,
}

export type AutomationOp = 'browser.click' | 'browser.type'
export type WaitState = 'attached' | 'visible' | 'detached' | 'hidden'

/** Why a check failed, or null when it passed. Mirrors the daemon's checks. */
export function selectorProblem(value: unknown): string | null {
  if (typeof value !== 'string') return 'selector must be a string'
  const count = [...value].length
  if (count === 0 || count > AUTOMATION_LIMITS.selector) return `selector must be 1 to ${AUTOMATION_LIMITS.selector} characters`
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return 'selector must not contain control characters'
  if (!value.trim()) return 'selector must not be blank'
  const open: string[] = []
  let quote: string | null = null
  const chars = [...value]
  for (let index = 0; index < chars.length; index += 1) {
    const c = chars[index]
    if (c === '\\') {
      if (index + 1 >= chars.length) return 'selector ends inside an escape'
      index += 1
      continue
    }
    if (quote) { if (c === quote) quote = null; continue }
    if (c === '"' || c === "'") quote = c
    else if (c === '[' || c === '(') open.push(c)
    else if (c === ']' || c === ')') {
      if (open.pop() !== (c === ']' ? '[' : '(')) return 'selector has unbalanced brackets'
    }
  }
  if (quote) return 'selector has an unclosed quote'
  if (open.length) return 'selector has unbalanced brackets'
  return null
}

export function textProblem(value: unknown): string | null {
  if (typeof value !== 'string') return 'text must be a string'
  const count = [...value].length
  if (count === 0 || count > AUTOMATION_LIMITS.text) return `text must be 1 to ${AUTOMATION_LIMITS.text} characters`
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(value)) {
    return 'text may contain no control characters but tab and line feed'
  }
  return null
}

export function expressionProblem(value: unknown): string | null {
  if (typeof value !== 'string') return 'expression must be a string'
  const count = [...value].length
  if (count === 0 || count > AUTOMATION_LIMITS.expression) {
    return `expression must be 1 to ${AUTOMATION_LIMITS.expression} characters`
  }
  if (value.includes('\0')) return 'expression must not contain NUL'
  return null
}

/** A timeout within `min..max`, the default when absent, or null when out of range. */
export function timeoutWithin(value: unknown, min: number, max: number, fallback: number): number | null {
  if (value === undefined) return fallback
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : null
}

/**
 * The fields a click or type appends to the fingerprinted payload
 * `[op, profile, owner, tab, null, ...]`, in the daemon's order
 * (crates/ade-daemon/src/bin/daemon/server/browser_automation.rs).
 */
export function automationPayloadTail(op: AutomationOp, selector: string, text?: string, replace?: boolean): unknown[] {
  return op === 'browser.click' ? [selector] : [selector, text, replace === true]
}

/** What the owner can observe about who holds a tab's debugger. */
export type AttachmentFacts = {
  devtoolsOpen: boolean
  /** Any client, ADE or not, is attached through `webContents.debugger`. */
  debuggerAttached: boolean
  /** ADE diagnostics or a recording holds that attachment. */
  heldByDiagnostics: boolean
}
export type AttachmentDecision =
  | { action: 'attach' }
  | { action: 'reuse' }
  | { action: 'refuse'; reason: 'devtools_open' | 'foreign_debugger'; message: string }

/**
 * Decides how automation gets the tab's debugger. DevTools always wins: an
 * open DevTools refuses automation rather than being detached, and a
 * debugger client outside ADE refuses it too. ADE's own diagnostics
 * attachment is shared, never taken over.
 */
export function decideAttachment(facts: AttachmentFacts): AttachmentDecision {
  if (facts.devtoolsOpen) {
    return { action: 'refuse', reason: 'devtools_open',
      message: 'DevTools is open on this tab and holds its debugger; close DevTools and retry' }
  }
  if (facts.debuggerAttached && !facts.heldByDiagnostics) {
    return { action: 'refuse', reason: 'foreign_debugger',
      message: 'another debugger client holds this tab; detach it and retry' }
  }
  return facts.debuggerAttached ? { action: 'reuse' } : { action: 'attach' }
}

export type Evaluation = { value_type: string | null; value: unknown; truncated: boolean; exception: string | null }
export type EvaluationOutcome = { ok: true; evaluation: Evaluation } | { ok: false; code: 'invalid_request' | 'unavailable'; message: string }

const clip = (text: string, limit: number): string => [...text].slice(0, limit).join('')
const VALUE_TYPES = new Set(['undefined', 'boolean', 'number', 'string', 'bigint', 'object', 'function', 'symbol'])

/**
 * Bounds a CDP `Runtime.evaluate` reply. A side-effect refusal becomes an
 * `invalid_request`; a thrown exception is reported with its text; a value
 * whose JSON exceeds the byte bound is left out and marked truncated.
 */
export function boundEvaluation(reply: unknown, limit = AUTOMATION_LIMITS.valueBytes): EvaluationOutcome {
  if (!reply || typeof reply !== 'object') return { ok: false, code: 'unavailable', message: 'the debugger returned no result' }
  const { result, exceptionDetails } = reply as { result?: Record<string, unknown>; exceptionDetails?: Record<string, unknown> }
  if (exceptionDetails && typeof exceptionDetails === 'object') {
    const exception = exceptionDetails.exception as Record<string, unknown> | undefined
    const description = typeof exception?.description === 'string' ? exception.description
      : typeof exceptionDetails.text === 'string' ? exceptionDetails.text : 'exception'
    // V8 reports a refused side effect as an EvalError from debug-evaluate.
    if (/EvalError: Possible side-effect in debug-evaluate/.test(description)) {
      return { ok: false, code: 'invalid_request', message: 'the expression may have side effects; only read-only expressions run' }
    }
    return { ok: true, evaluation: { value_type: null, value: null, truncated: false,
      exception: clip(description, AUTOMATION_LIMITS.exception) } }
  }
  if (!result || typeof result !== 'object' || typeof result.type !== 'string' || !VALUE_TYPES.has(result.type)) {
    return { ok: false, code: 'unavailable', message: 'the debugger returned no result' }
  }
  const type = result.type
  if (result.subtype === 'promise') {
    return { ok: false, code: 'invalid_request', message: 'the expression returned a promise; promises are not awaited' }
  }
  // `unserializableValue` carries NaN, Infinity, -0 and bigint as text.
  if (typeof result.unserializableValue === 'string') {
    return { ok: true, evaluation: { value_type: type, value: clip(result.unserializableValue, 64), truncated: false, exception: null } }
  }
  if (!('value' in result) || type === 'undefined' || type === 'function' || type === 'symbol') {
    return { ok: true, evaluation: { value_type: type, value: null, truncated: false, exception: null } }
  }
  let json: string | undefined
  try { json = JSON.stringify(result.value) } catch { json = undefined }
  if (json === undefined) return { ok: true, evaluation: { value_type: type, value: null, truncated: false, exception: null } }
  if (Buffer.byteLength(json) > limit) {
    return { ok: true, evaluation: { value_type: type, value: null, truncated: true, exception: null } }
  }
  return { ok: true, evaluation: { value_type: type, value: JSON.parse(json), truncated: false, exception: null } }
}

/** What one wait probe saw. */
export type Probe = { present: boolean; visible: boolean }

export function readProbe(raw: unknown): Probe | 'invalid_selector' | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (value.error === 'invalid_selector') return 'invalid_selector'
  if (typeof value.present !== 'boolean' || typeof value.visible !== 'boolean') return null
  return { present: value.present, visible: value.present && value.visible }
}

export function waitSatisfied(state: WaitState, probe: Probe): boolean {
  switch (state) {
    case 'attached': return probe.present
    case 'visible': return probe.visible
    case 'detached': return !probe.present
    case 'hidden': return !probe.visible
  }
}

/** Probes whether any element matches, and whether one of the first 64 is visible. */
export function probeScript(selector: string): string {
  return `(() => {
  let elements;
  try { elements = document.querySelectorAll(${JSON.stringify(selector)}); } catch { return { error: 'invalid_selector' }; }
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' &&
      Number(style.opacity || '1') !== 0;
  };
  const first = Array.prototype.slice.call(elements, 0, 64);
  return { present: elements.length > 0, visible: first.some(visible) };
})()`
}

export type ActionPoint = { x: number; y: number }
export type Actionability = { ok: true; point: ActionPoint } |
  { ok: false; code: 'invalid_request' | 'unavailable'; message: string }

/**
 * Waits in the page until the selector's first match is visible, enabled,
 * editable when required, stable for two layout samples and not covered at
 * its centre. Scrolling it into view is the only change it makes.
 */
export function actionabilityScript(selector: string, editable: boolean, timeoutMs: number): string {
  return String.raw`(async () => {
  const deadline = performance.now() + ${JSON.stringify(timeoutMs)};
  const selector = ${JSON.stringify(selector)};
  const requiresEditable = ${JSON.stringify(editable)};
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const near = (a, b) => Math.abs(a - b) < 0.25;
  const same = (a, b) => near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);
  const centre = (rect) => ({
    x: Math.min(Math.max(rect.left + rect.width / 2, 0), Math.max(window.innerWidth - 1, 0)),
    y: Math.min(Math.max(rect.top + rect.height / 2, 0), Math.max(window.innerHeight - 1, 0)),
  });
  const disabled = (element) => Boolean(element.closest?.('[aria-disabled="true"]')) ||
    ('disabled' in element && element.disabled) || Boolean(element.closest?.('fieldset[disabled]'));
  const isEditable = (element) => {
    if (element.isContentEditable) return true;
    const tag = element.tagName?.toLowerCase();
    if (tag === 'textarea') return !element.readOnly && !disabled(element);
    if (tag !== 'input') return false;
    const type = (element.getAttribute('type') || 'text').toLowerCase();
    if (['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type)) return false;
    return !element.readOnly && !disabled(element);
  };
  const visible = (element, rect) => {
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' &&
      Number(style.opacity || '1') !== 0;
  };
  let detail = 'not found';
  while (performance.now() <= deadline) {
    let element;
    try { element = document.querySelector(selector); } catch { return { ok: false, reason: 'invalid_selector' }; }
    if (!element || !element.isConnected) { detail = 'not found'; await sleep(50); continue; }
    const rect = element.getBoundingClientRect();
    if (!visible(element, rect)) { detail = 'not visible'; await sleep(25); continue; }
    if (disabled(element)) { detail = 'disabled'; await sleep(25); continue; }
    if (requiresEditable && !isEditable(element)) { detail = 'not editable'; await sleep(25); continue; }
    element.scrollIntoView?.({ block: 'center', inline: 'center' });
    await sleep(16);
    const first = element.getBoundingClientRect();
    await sleep(16);
    const second = element.getBoundingClientRect();
    if (!same(first, second)) { detail = 'moving'; continue; }
    const point = centre(second);
    const hit = document.elementFromPoint(point.x, point.y);
    if (!hit || (hit !== element && !element.contains(hit))) { detail = 'covered'; await sleep(25); continue; }
    return { ok: true, point };
  }
  return { ok: false, reason: 'timeout', detail };
})()`
}

const DETAILS = new Set(['not found', 'not visible', 'disabled', 'not editable', 'moving', 'covered'])

export function readActionability(raw: unknown): Actionability {
  if (!raw || typeof raw !== 'object') return { ok: false, code: 'unavailable', message: 'the page gave no answer' }
  const value = raw as Record<string, unknown>
  if (value.ok === true) {
    const point = value.point as Record<string, unknown> | undefined
    if (point && typeof point.x === 'number' && typeof point.y === 'number' && Number.isFinite(point.x) &&
      Number.isFinite(point.y) && point.x >= 0 && point.y >= 0) {
      return { ok: true, point: { x: point.x, y: point.y } }
    }
    return { ok: false, code: 'unavailable', message: 'the page returned an invalid point' }
  }
  if (value.reason === 'invalid_selector') return { ok: false, code: 'invalid_request', message: 'the page rejected the selector' }
  const detail = typeof value.detail === 'string' && DETAILS.has(value.detail) ? value.detail : 'not actionable'
  return { ok: false, code: 'unavailable', message: `the element did not become actionable in time: ${detail}` }
}

/**
 * Focuses the first match and places the caret: at the end, or over all of
 * its content when `replace` is true. Answers whether it now has focus.
 */
export function focusScript(selector: string, replace: boolean): string {
  return `(() => {
  let element;
  try { element = document.querySelector(${JSON.stringify(selector)}); } catch { return { focused: false }; }
  if (!element) return { focused: false };
  element.focus({ preventScroll: true });
  const replace = ${JSON.stringify(replace)};
  if (element.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(element);
    if (!replace) range.collapse(false);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  } else if (typeof element.value === 'string') {
    try {
      if (replace) element.select();
      else element.setSelectionRange(element.value.length, element.value.length);
    } catch { if (replace) return { focused: false, reason: 'unselectable' }; }
  }
  return { focused: document.activeElement === element };
})()`
}
