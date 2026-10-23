import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerCustomTheme } from '@pierre/diffs'

import DesktopApp from './DesktopApp.tsx'
import { applyTheme } from './theme.ts'
import { activeTheme, DEFAULT_APPEARANCE } from './appearance.ts'
import './themes.css'
import './styles.css'

registerCustomTheme('ghl-darcula', () => import('./darcula.ts').then((module) => module.default))
applyTheme(activeTheme(DEFAULT_APPEARANCE))

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <DesktopApp />
  </StrictMode>,
)
