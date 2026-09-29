import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerCustomTheme } from '@pierre/diffs'

import App from './App.tsx'
import { applyTheme, readTheme } from './theme.ts'
import './themes.css'
import './styles.css'

registerCustomTheme('ghl-darcula', () => import('./darcula.ts').then((module) => module.default))
applyTheme(readTheme())

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
