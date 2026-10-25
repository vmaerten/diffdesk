import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerCustomTheme } from '@pierre/diffs'
import { WorkerPoolContextProvider } from '@pierre/diffs/react'
// Vite's ?worker import has a default export the import plugin cannot see.
// oxlint-disable-next-line import/default
import DiffsWorker from '@pierre/diffs/worker/worker.js?worker'

import DesktopApp from './DesktopApp.tsx'
import SettingsWindow from './SettingsWindow.tsx'
import { applyTheme } from './theme.ts'
import { activeTheme, DEFAULT_APPEARANCE } from './appearance.ts'
import './themes.css'
import './styles.css'

registerCustomTheme('ghl-darcula', () => import('./darcula.ts').then((module) => module.default))
applyTheme(activeTheme(DEFAULT_APPEARANCE))

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

// Syntax highlighting runs in workers: on the main thread, each file entering the
// pane blocked input for about 140 ms. DesktopApp keeps the pool's theme current.
// The Settings window, opened by Go on /settings, only highlights its previews.
createRoot(root).render(
  <StrictMode>
    {location.pathname === '/settings' ? (
      <SettingsWindow />
    ) : (
      <WorkerPoolContextProvider
        poolOptions={{ workerFactory: () => new DiffsWorker(), poolSize: 4 }}
        highlighterOptions={{}}
      >
        <DesktopApp />
      </WorkerPoolContextProvider>
    )}
  </StrictMode>,
)
