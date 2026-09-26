import React from 'react'

export type BrowserTab = { id: string; profileId: string; requestedUrl: string; observedUrl: string; title: string; loading: boolean; error: string }
export type BrowserState = { profileId: string; selectedId: string | null; tabs: BrowserTab[] }
export type BrowserBridge = {
  list(): Promise<BrowserState>
  open(url: string): Promise<BrowserState>
  select(id: string): Promise<BrowserState>
  newTab(): Promise<BrowserState>
  navigate(id: string, url: string): Promise<BrowserState>
  history(id: string, direction: 'back' | 'forward'): Promise<BrowserState>
  close(id: string): Promise<BrowserState>
  bounds(id: string, rect: { x: number; y: number; width: number; height: number }): Promise<void>
  hide(): Promise<void>
  onState(listener: (state: BrowserState) => void): () => void
  onLeaseLost(listener: (profileId: string) => void): () => void
}

export function BrowserPane({ profileId }: { profileId: string }): React.JSX.Element {
  const [state, setState] = React.useState<BrowserState | null>(null)
  const [address, setAddress] = React.useState('')
  const [error, setError] = React.useState('')
  const [expanded, setExpanded] = React.useState(false)
  const surface = React.useRef<HTMLDivElement>(null)
  const selected = state?.tabs.find((tab) => tab.id === state.selectedId)
  React.useEffect(() => {
    let alive = true
    setState(null)
    setError('')
    const unsubscribe = window.adeHost.browser.onState((next) => {
      if (alive && next.profileId === profileId) setState(next)
    })
    const unsubscribeLease = window.adeHost.browser.onLeaseLost((id) => {
      if (alive && id === profileId) {
        setState(null)
        setError('Browser session ownership was lost. Restart ADE before using this profile browser.')
      }
    })
    void window.adeHost.browser.list().then((next) => {
      if (alive && next.profileId === profileId) { setState(next); if (next.tabs.length) setExpanded(true) }
    }).catch((reason) => { if (alive) setError(String(reason)) })
    return () => { alive = false; unsubscribe(); unsubscribeLease(); void window.adeHost.browser.hide() }
  }, [profileId])
  React.useEffect(() => { setAddress(selected?.requestedUrl || '') }, [selected?.id, selected?.requestedUrl])
  React.useEffect(() => {
    if (!expanded || !selected || !surface.current) { void window.adeHost.browser.hide(); return }
    const element = surface.current
    let disposed = false
    let pending = false
    let frame = 0
    const update = (): void => {
      if (disposed || pending) return
      pending = true
      frame = requestAnimationFrame(() => {
        if (disposed) return
        pending = false
        const rect = element.getBoundingClientRect()
        const top = Math.max(0, rect.top)
        const bottom = Math.min(window.innerHeight, rect.bottom)
        const left = Math.max(0, rect.left)
        const right = Math.min(window.innerWidth, rect.right)
        void window.adeHost.browser.bounds(selected.id, { x: left, y: top, width: Math.max(0, right - left),
          height: Math.max(0, bottom - top) }).catch((reason) => setError(String(reason)))
      })
    }
    const resize = new ResizeObserver(update)
    resize.observe(element)
    const pane = element.closest('.browser-pane')
    if (pane) {
      resize.observe(pane)
      if (pane.previousElementSibling) resize.observe(pane.previousElementSibling)
    }
    const main = element.closest('main')
    const header = main?.querySelector('header')
    const profileBar = main?.querySelector('.profile-bar')
    if (header) resize.observe(header)
    if (profileBar) resize.observe(profileBar)
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    update()
    return () => { disposed = true; cancelAnimationFrame(frame); resize.disconnect(); window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update); void window.adeHost.browser.hide() }
  }, [expanded, profileId, selected?.id])
  const run = async (work: () => Promise<BrowserState>): Promise<void> => {
    try {
      const next = await work()
      if (next.profileId === profileId) setState(next)
      setError('')
    } catch (reason) { setError(String(reason)) }
  }
  const open = (event: React.FormEvent): void => {
    event.preventDefault()
    if (!address.trim()) return
    setExpanded(true)
    void run(() => selected ? window.adeHost.browser.navigate(selected.id, address.trim()) : window.adeHost.browser.open(address.trim()))
  }
  return <section className="browser-pane" aria-label="Browser preview">
    <div className="browser-heading"><h2>Browser preview</h2><button type="button" onClick={() => setExpanded((value) => !value)}>
      {expanded ? 'Hide preview' : 'Show preview'}</button></div>
    {expanded && <>
      <nav className="browser-tabs" aria-label="Browser tabs">
        {state?.tabs.map((tab) => <span className="browser-tab" key={tab.id}>
          <button type="button" aria-current={tab.id === state.selectedId ? 'page' : undefined}
            onClick={() => void run(() => window.adeHost.browser.select(tab.id))}>{tab.title || tab.requestedUrl}</button>
          <button type="button" aria-label={`Close ${tab.title || tab.requestedUrl}`} onClick={() => void run(() => window.adeHost.browser.close(tab.id))}>×</button>
        </span>)}
        <button type="button" onClick={() => void run(async () => {
          const next = await window.adeHost.browser.newTab()
          setAddress('')
          return next
        })}>New tab</button>
      </nav>
      <form className="browser-toolbar" onSubmit={open}>
        <button type="button" disabled={!selected} onClick={() => selected && void run(() => window.adeHost.browser.history(selected.id, 'back'))}>Back</button>
        <button type="button" disabled={!selected} onClick={() => selected && void run(() => window.adeHost.browser.history(selected.id, 'forward'))}>Forward</button>
        <label htmlFor="browser-address">Address</label>
        <input id="browser-address" value={address} placeholder="http://localhost:3000" onChange={(event) => setAddress(event.target.value)} />
        <button type="submit">{selected ? 'Go' : 'Open tab'}</button>
      </form>
      <div className="browser-meta" aria-live="polite">
        {selected ? <><span>Tab ID: {selected.id}</span><span>{selected.loading ? 'Loading…' : selected.requestedUrl}</span></>
          : <span>Enter an HTTP(S) URL to open a tab.</span>}
      </div>
      {(error || selected?.error) && <p role="alert" className="inline-error">{error || selected?.error}</p>}
      <div className="browser-surface" ref={surface} aria-label="Web page preview" />
    </>}
  </section>
}
