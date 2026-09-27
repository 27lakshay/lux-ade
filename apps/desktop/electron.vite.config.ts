import { defineConfig } from 'electron-vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'

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
    plugins: [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss()],
  },
})
