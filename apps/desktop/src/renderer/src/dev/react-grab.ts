// Development only, loaded unless ADE_REACT_GRAB=0 (electron.vite.config.ts). Hover an element and
// press ⌘C to copy its component stack and source location, to paste into an agent.
//
// Initialised by hand to turn off its version check, a request to react-grab.com that the app's
// content security policy blocks anyway. The flag stops the import from initialising with defaults.
declare global {
  interface Window {
    __REACT_GRAB_DISABLED__?: boolean
  }
}
window.__REACT_GRAB_DISABLED__ = true
const { init } = await import('react-grab')
init({ telemetry: false })

export {}
