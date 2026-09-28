import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import { contentSecurityPolicy } from './src/shared/content-security-policy'

// Development-only renderer helpers, injected ahead of the app's entry by the dev server and never
// built into the app. See docs/agents/desktop-debugging.md.
//   ADE_REACT_DEVTOOLS=1  connect to the standalone React DevTools app on port 8097
//   ADE_REACT_SCAN=0      turn off React Scan (on by default: re-render outlines and an FPS meter)
//   ADE_REACT_GRAB=0      turn off react-grab (on by default: hover, then ⌘C copies source context)
function devHelpers(): Plugin {
  const helpers = [
    process.env.ADE_REACT_DEVTOOLS === '1' && '/src/dev/react-devtools.ts',
    process.env.ADE_REACT_SCAN !== '0' && '/src/dev/react-scan.ts',
    process.env.ADE_REACT_GRAB !== '0' && '/src/dev/react-grab.ts',
  ].filter((path): path is string => Boolean(path))
  return {
    name: 'ade-dev-helpers',
    apply: 'serve',
    transformIndexHtml(html) {
      const scripts = helpers.map((path) => `<script type="module" src="${path}"></script>`).join('\n    ')
      return html.replace('<script type="module" src="./src/bootstrap.ts">', `${scripts}\n    $&`)
    },
  }
}

// Writes the content security policy into index.html. Development adds only the DevTools socket.
function contentSecurityPolicyMeta(): Plugin {
  return {
    name: 'ade-content-security-policy',
    transformIndexHtml(_html, context) {
      const devtools = context.server && process.env.ADE_REACT_DEVTOOLS === '1'
      const policy = contentSecurityPolicy(devtools ? { 'connect-src': ['ws://localhost:8097'] } : {}, true)
      return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head' }]
    },
  }
}

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ['@ade/client', '@ade/contracts'] },
      // The stream bridge runs as its own utility process (src/main/stream-bridge.ts forks it).
      rolldownOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          'stream-bridge': resolve(import.meta.dirname, 'src/stream-bridge/index.ts'),
        },
      },
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
    // `@/` is the renderer source root, as shadcn/ui expects (components.json).
    resolve: { alias: { '@': resolve(import.meta.dirname, 'src/renderer/src') } },
    // React Compiler through Babel: the stable compiler. plugin-react's Rust port is experimental.
    plugins: [
      react(),
      babel({ presets: [reactCompilerPreset()] }),
      tailwindcss(),
      devHelpers(),
      contentSecurityPolicyMeta(),
    ],
  },
})
