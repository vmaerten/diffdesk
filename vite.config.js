import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The UI is served from /r/<repoId>, but assets are always requested from the
// root, so `base: '/'` keeps a single asset path whatever the repo id.
export default defineConfig({
  root: 'web',
  base: '/',
  plugins: [react()],
  build: {
    outDir: '../web-dist',
    emptyOutDir: true,
  },
  server: {
    port: 5180,
    // In dev, Vite serves the UI and forwards data calls to a running `ghl`.
    proxy: {
      '/r': {
        target: 'http://localhost:7777',
        bypass: (req) => (req.url?.includes('/api/') ? undefined : req.url),
      },
      '/api': 'http://localhost:7777',
    },
  },
})
