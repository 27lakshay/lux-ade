// Development only, loaded before React unless ADE_REACT_SCAN=0 (electron.vite.config.ts).
// Outlines components as they re-render, to find wasted renders, and its toolbar shows the frame
// rate.
import { scan } from 'react-scan'

scan({ enabled: true, showToolbar: true, showFPS: true })
