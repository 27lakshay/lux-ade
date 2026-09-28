// The renderer's entry. It loads the app through a dynamic import, so a module that fails to load
// or throws while loading shows an error with a Reload button instead of a blank window.

const RELOADED = 'ade.reloaded-for-missing-chunk'

// A lazily loaded chunk can go missing when the app is rebuilt under a running window. Reload once
// to pick up the new build; if that fails as well, the error surfaces normally.
window.addEventListener('vite:preloadError', (event) => {
  if (sessionStorage.getItem(RELOADED)) return
  sessionStorage.setItem(RELOADED, '1')
  event.preventDefault()
  location.reload()
})

import('./app/start')
  .then(({ start }) => start())
  .then(() => sessionStorage.removeItem(RELOADED))
  .catch(showBootError)

// Plain DOM: React, the stylesheet or the kit may be what failed to load.
function showBootError(error: unknown): void {
  console.error('ADE could not start', error)
  const root = document.getElementById('root') ?? document.body
  const screen = document.createElement('main')
  screen.style.cssText = 'display:grid;place-content:center;gap:12px;height:100%;padding:24px;font:14px system-ui'
  const title = document.createElement('h1')
  title.textContent = 'ADE could not start'
  title.style.cssText = 'margin:0;font-size:18px'
  const detail = document.createElement('pre')
  detail.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error)
  detail.style.cssText = 'margin:0;max-width:640px;max-height:240px;overflow:auto;white-space:pre-wrap;opacity:.7'
  const reload = document.createElement('button')
  reload.type = 'button'
  reload.textContent = 'Reload'
  reload.style.cssText = 'justify-self:start'
  reload.addEventListener('click', () => location.reload())
  screen.append(title, detail, reload)
  root.replaceChildren(screen)
}
