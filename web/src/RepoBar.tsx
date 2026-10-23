import Icon from './Icon.tsx'
import ThemePicker from './ThemePicker.tsx'
import KeyboardShortcuts from './KeyboardShortcuts.tsx'
import { GO_POC } from './capabilities.ts'
import type { ThemeId } from './theme.ts'

export default function RepoBar({
  repoName,
  repoPath,
  theme,
  onThemeChange,
  refreshing,
  onRefresh,
}: {
  repoName: string
  repoPath?: string
  theme: ThemeId
  onThemeChange: (value: string) => void
  refreshing: boolean
  onRefresh: () => void
}) {
  return (
    <div className="appbar">
      <div className="repo-context">
        <span className="brand-mark" aria-hidden="true">
          <Icon name="file" />
        </span>
        <span className="product-name">{GO_POC ? 'ghl Go PoC' : 'ghl'}</span>
        <span className="repo-divider">/</span>
        <strong className="repo-name" title={repoPath}>
          {repoName}
        </strong>
        <span className="review-badge">Review</span>
      </div>

      <div className="app-actions">
        <ThemePicker theme={theme} onChange={onThemeChange} />
        <button type="button" className="refresh" onClick={onRefresh} disabled={refreshing}>
          <span className={refreshing ? 'refresh-icon spinning' : 'refresh-icon'} aria-hidden>
            ↻
          </span>
          <span className="refresh-label">{refreshing ? 'Refreshing…' : 'Refresh'}</span>
        </button>

        <details className="shortcuts">
          <summary className="icon-button" aria-label="Keyboard shortcuts" title="Shortcuts">
            ?
          </summary>
          <div className="shortcuts-panel">
            <strong>Keyboard shortcuts</strong>
            <KeyboardShortcuts />
          </div>
        </details>
      </div>
    </div>
  )
}
