import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { App } from './App'
import { applyTokens, DEFAULT_GLASS, DEFAULT_THEME, REDUCED_TRANSPARENCY, type Theme } from './tokens'
import { readPersisted } from './persist'

// Set the colour variables before the first paint, from the saved dev-panel settings, so a saved
// light theme or glass setting never flashes the defaults. App keeps them current afterwards.
applyTokens(readPersisted<Theme>('theme', DEFAULT_THEME), {
  on: readPersisted<boolean | null>('glass', null) ?? !matchMedia(REDUCED_TRANSPARENCY).matches,
  ...readPersisted('glassTuning', DEFAULT_GLASS),
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
