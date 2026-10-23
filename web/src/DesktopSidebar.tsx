import Icon from './Icon.tsx'
import type { Totals } from '../../src/types.ts'

/** The desktop sidebar heading: a source-list title, with folding as icons. */
export function DesktopSidebarHead({
  fileCount,
  onCollapseAll,
  onExpandAll,
}: {
  fileCount: number
  onCollapseAll: () => void
  onExpandAll: () => void
}) {
  return (
    <>
      <span className="sidebar-title">Changes</span>
      <span className="counter">{fileCount}</span>
      <span className="spacer" />
      <button type="button" className="sidebar-icon" title="Collapse all" onClick={onCollapseAll}>
        <Icon name="fold" />
      </button>
      <button type="button" className="sidebar-icon" title="Expand all" onClick={onExpandAll}>
        <Icon name="unfold" />
      </button>
    </>
  )
}

/** Review progress under the desktop file tree. */
export function DesktopSidebarFoot({
  fileCount,
  viewedCount,
  stats,
}: {
  fileCount: number
  viewedCount: number
  stats: Totals
}) {
  return (
    <div className="sidebar-foot">
      <div className="sidebar-foot-line">
        <span>
          {viewedCount} of {fileCount} viewed
        </span>
        <span className="footer-stats">
          <span className="add">+{stats.additions}</span>{' '}
          <span className="del">−{stats.deletions}</span>
        </span>
      </div>
      <div
        className="viewed-progress"
        role="progressbar"
        aria-label="Files viewed"
        aria-valuemin={0}
        aria-valuemax={fileCount}
        aria-valuenow={viewedCount}
      >
        <span style={{ width: `${(viewedCount / Math.max(fileCount, 1)) * 100}%` }} />
      </div>
    </div>
  )
}
