// Decides what an interrupted browser mutation did, from the intent its pending
// receipt recorded and the tabs the owner holds now. It never re-runs the effect.

export type BrowserMutationOp = 'browser.open' | 'browser.navigate' | 'browser.close' | 'browser.click' | 'browser.type'

/** What a pending receipt recorded before its effect ran. */
export type BrowserIntent = {
  op: BrowserMutationOp
  /** The planned tab ID for an open; the target tab for navigate and close. */
  target: string | null
  /** The requested URL for open and navigate. */
  url: string | null
  /** The target tab's requested URL when a navigate was admitted. */
  priorUrl: string | null
  /**
   * For click and type: `prepared` until input is about to reach the page,
   * then `dispatching`. Input leaves no trace in the tabs, so this is the
   * only evidence.
   */
  stage?: 'prepared' | 'dispatching' | null
}

export type BrowserVerdict =
  | { outcome: 'applied'; tabId: string; evidence: string }
  | { outcome: 'not_applied'; evidence: string }
  | { outcome: 'unknown'; evidence: string }

/**
 * Settles an interrupted mutation against the owner's durable tabs.
 *
 * `intent` is null when the receipt predates recorded intent. `inFlight` is
 * true while this process is still running the same request; its outcome is
 * not yet observable, so nothing is decided.
 */
export function reconcileBrowserEffect(
  intent: BrowserIntent | null,
  inFlight: boolean,
  tabs: ReadonlyMap<string, { requestedUrl: string }>,
): BrowserVerdict {
  if (inFlight) return { outcome: 'unknown', evidence: 'effect_in_progress' }
  if (!intent || !intent.target) return { outcome: 'unknown', evidence: 'intent_not_recorded' }
  const tab = tabs.get(intent.target)
  switch (intent.op) {
    case 'browser.open':
      if (!intent.url) return { outcome: 'unknown', evidence: 'intent_not_recorded' }
      // The planned ID is fresh, so only this request can have created it.
      return tab
        ? { outcome: 'applied', tabId: intent.target, evidence: 'planned_tab_present' }
        : { outcome: 'not_applied', evidence: 'planned_tab_absent' }
    case 'browser.navigate':
      if (!intent.url || intent.priorUrl === null) return { outcome: 'unknown', evidence: 'intent_not_recorded' }
      if (!tab) return { outcome: 'unknown', evidence: 'target_tab_absent' }
      if (tab.requestedUrl === intent.url) {
        return { outcome: 'applied', tabId: intent.target, evidence: 'tab_at_requested_url' }
      }
      if (tab.requestedUrl === intent.priorUrl) return { outcome: 'not_applied', evidence: 'tab_at_prior_url' }
      return { outcome: 'unknown', evidence: 'tab_at_other_url' }
    case 'browser.close':
      // Admission checked that the target existed before recording intent.
      return tab
        ? { outcome: 'not_applied', evidence: 'target_tab_present' }
        : { outcome: 'applied', tabId: intent.target, evidence: 'target_tab_absent' }
    case 'browser.click':
    case 'browser.type':
      // The dispatching mark is durable before any input is sent, so a
      // receipt still prepared proves the page received nothing.
      if (intent.stage === 'prepared') return { outcome: 'not_applied', evidence: 'input_not_dispatched' }
      if (intent.stage === 'dispatching') return { outcome: 'unknown', evidence: 'input_unobservable' }
      return { outcome: 'unknown', evidence: 'intent_not_recorded' }
  }
}
