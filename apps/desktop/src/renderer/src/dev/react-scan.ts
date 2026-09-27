// Development only, loaded before React when ADE_REACT_SCAN=1 (electron.vite.config.ts).
// Outlines components as they re-render, to find wasted renders.
import { scan } from 'react-scan'

scan({ enabled: true })
