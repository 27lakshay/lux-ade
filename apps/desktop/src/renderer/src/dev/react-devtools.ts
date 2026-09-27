// Development only, loaded before React when ADE_REACT_DEVTOOLS=1 (electron.vite.config.ts).
// Connects to the standalone React DevTools app: run `pnpm --dir apps/desktop exec react-devtools`.
import { connectToDevTools } from 'react-devtools-core'

connectToDevTools({ port: 8097 })
