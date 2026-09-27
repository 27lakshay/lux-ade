import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Renderer tests run in real Chromium (Electron's renderer is Chromium), headless. Tests live
// beside the code as *.test.ts(x).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src/renderer/src') } },
  // Pre-bundle every dependency the renderer imports before tests start. Discovering one mid-run
  // (say a Base UI subpath) reloads the page and loads a second React, failing that run.
  optimizeDeps: { entries: ['src/renderer/**/*.{ts,tsx}'] },
  test: {
    // The terminal package's engine tests run here too: they need the same real Chromium.
    include: ['src/renderer/**/*.test.{ts,tsx}', '../../packages/terminal/src/**/*.test.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
  },
})
