import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'

// Development-only renderer helpers, injected ahead of the app's entry by the dev server and never
// built into the app. See docs/agents/desktop-debugging.md.
//   ADE_REACT_DEVTOOLS=1  connect to the standalone React DevTools app on port 8097
//   ADE_REACT_SCAN=1      outline components as they re-render
//   ADE_REACT_GRAB=0      turn off react-grab (on by default: hover, then ⌘C copies source context)
function devHelpers(): Plugin {
  const helpers = [
    process.env.ADE_REACT_DEVTOOLS === '1' && '/src/dev/react-devtools.ts',
    process.env.ADE_REACT_SCAN === '1' && '/src/dev/react-scan.ts',
    process.env.ADE_REACT_GRAB !== '0' && '/src/dev/react-grab.ts',
  ].filter((path): path is string => Boolean(path))
  return {
    name: 'ade-dev-helpers',
    apply: 'serve',
    transformIndexHtml(html) {
      const scripts = helpers.map((path) => `<script type="module" src="${path}"></script>`).join('\n    ')
      let result = html.replace('<script type="module" src="./src/main.tsx">', `${scripts}\n    $&`)
      // The DevTools backend talks to the standalone app over a WebSocket.
      if (process.env.ADE_REACT_DEVTOOLS === '1') {
        result = result.replace("default-src 'self';", "default-src 'self'; connect-src 'self' ws://localhost:8097;")
      }
      return result
    },
  }
}

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ['@ade/client', '@ade/contracts'] },
    },
  },
  preload: {
    build: {
      rolldownOptions: {
        output: { format: 'cjs' },
      },
    },
  },
  renderer: {
    // React Compiler through Babel: the stable compiler. plugin-react's Rust port is experimental.
    plugins: [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss(), devHelpers()],
  },
})
