import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'

// The UI is served from /r/<repoId>, but assets are always requested from the
// root, so `base: '/'` keeps a single asset path whatever the repo id.
export default defineConfig({
  root: 'web',
  base: '/',
  plugins: [
    react(),
    // Vite transforms through oxc; the React Compiler exists only as a Babel
    // plugin, so this is a second pass over web/src. It compiles Resizer and
    // bails on the other three — pass a `logger` to reactCompilerPreset to see
    // the reasons, and see the PR that added this for what they were.
    babel({ presets: [reactCompilerPreset()] }),
  ],
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
