import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { BRIDGE, simulateDesktopRuntime } from './desktop/simulator.ts'

/**
 * The dev server runs the desktop UI in a browser, on the bindings the UI tests simulate.
 * @type {import('vite').Plugin}
 */
const desktopRuntime = {
  name: 'ghl-desktop-runtime',
  apply: 'serve',
  transformIndexHtml: () => [
    {
      tag: 'script',
      children: `(${simulateDesktopRuntime})(null, ${JSON.stringify(BRIDGE)})`,
      injectTo: 'head-prepend',
    },
  ],
}

// The UI is served from /r/<repoId>, but assets are always requested from the
// root, so `base: '/'` keeps a single asset path whatever the repo id.
export default defineConfig(({ mode }) => ({
  root: 'web',
  base: '/',
  plugins: [react({ compiler: true }), ...(mode === 'go-desktop' ? [desktopRuntime] : [])],
  build: {
    outDir: '../desktop/assets',
    emptyOutDir: true,
  },
  server: {
    port: 5180,
    // In dev, Vite serves the UI and forwards data calls to the dev server (`task dev:go`).
    proxy: {
      '/r': {
        target: process.env.GHL_DEV_API ?? 'http://127.0.0.1:5181',
        bypass: (req) => (req.url?.includes('/api/') ? undefined : req.url),
      },
      '/api': process.env.GHL_DEV_API ?? 'http://127.0.0.1:5181',
    },
  },
}))
