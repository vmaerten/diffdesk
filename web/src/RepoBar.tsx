import Icon from './Icon.tsx'
import ThemePicker from './ThemePicker.tsx'
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
  /** Omitted when the page does not choose its theme: the desktop app follows its appearance. */
  theme?: ThemeId
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
        {theme && <ThemePicker theme={theme} onChange={onThemeChange} />}
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
            <dl>
              {!GO_POC && (
                <div>
                  <dt>
                    <kbd>b</kbd>
                  </dt>
                  <dd>Choose base</dd>
                </div>
              )}
              {!GO_POC && (
                <div>
                  <dt>
                    <kbd>t</kbd>
                  </dt>
                  <dd>Choose target</dd>
                </div>
              )}
              {!GO_POC && (
                <div>
                  <dt>
                    <kbd>l</kbd>
                  </dt>
                  <dd>Choose commit</dd>
                </div>
              )}
              <div>
                <dt>
                  <kbd>j</kbd> <kbd>k</kbd>
                </dt>
                <dd>Move between files</dd>
              </div>
              <div>
                <dt>
                  <kbd>v</kbd>
                </dt>
                <dd>Mark viewed</dd>
              </div>
              <div>
                <dt>
                  <kbd>c</kbd>
                </dt>
                <dd>Comment selection</dd>
              </div>
              <div>
                <dt>
                  <kbd>r</kbd>
                </dt>
                <dd>Refresh</dd>
              </div>
              <div>
                <dt>
                  <kbd>⌘/Ctrl</kbd> <kbd>f</kbd>
                </dt>
                <dd>Search changed code</dd>
              </div>
            </dl>
          </div>
        </details>
      </div>
    </div>
  )
}
