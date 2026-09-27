import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Renderer tests run in real Chromium (Electron's renderer is Chromium), headless. Tests live
// beside the code as *.test.ts(x).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    include: ['src/renderer/**/*.test.{ts,tsx}'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
  },
})
