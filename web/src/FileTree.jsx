import { memo } from 'react'

/**
 * Group flat paths into a directory tree, collapsing chains of single-child
 * directories into one row (`frontend/src/modules` rather than three levels).
 * Real diffs here are 100+ files deep under `frontend/src/...`, so without this
 * the tree is mostly indentation.
 *
 * Each directory carries the full path it stands for, which is what identifies
 * it in the collapsed set, and aggregate counts so a folded directory still
 * says how much it hides.
 */
export function buildTree(entries) {
  const root = { name: '', path: '', dirs: new Map(), files: [] }

  for (const entry of entries) {
    const parts = entry.path.split('/')
    let node = root
    let prefix = ''
    for (const part of parts.slice(0, -1)) {
      prefix = prefix ? `${prefix}/${part}` : part
      if (!node.dirs.has(part)) {
        node.dirs.set(part, { name: part, path: prefix, dirs: new Map(), files: [] })
      }
      node = node.dirs.get(part)
    }
    node.files.push({ ...entry, label: parts[parts.length - 1] })
  }

  const finalise = (node) => {
    let dirs = [...node.dirs.values()].map(finalise)

    // Fold a lone child directory into its parent: `front` + `ui` -> `front/ui`.
    if (dirs.length === 1 && node.files.length === 0 && node.name) {
      const only = dirs[0]
      return { ...only, name: `${node.name}/${only.name}` }
    }

    const totals = { files: node.files.length, additions: 0, deletions: 0 }
    for (const file of node.files) {
      totals.additions += file.additions
      totals.deletions += file.deletions
    }
    for (const dir of dirs) {
      totals.files += dir.totals.files
      totals.additions += dir.totals.additions
      totals.deletions += dir.totals.deletions
    }

    return { ...node, dirs, totals }
  }

  return finalise(root)
}

/** Every directory path in the tree, for expand-all / collapse-all. */
export function allDirPaths(node, out = []) {
  for (const dir of node.dirs) {
    out.push(dir.path)
    allDirPaths(dir, out)
  }
  return out
}

const Counts = ({ additions, deletions, binary }) =>
  binary ? (
    <span className="tree-stat dim">bin</span>
  ) : (
    <span className="tree-stat">
      {additions > 0 && <span className="add">+{additions}</span>}
      {deletions > 0 && <span className="del">−{deletions}</span>}
    </span>
  )

function Node({ node, depth, activeId, collapsed, onSelect, onToggle }) {
  return (
    <>
      {node.dirs.map((dir) => {
        const isCollapsed = collapsed.has(dir.path)
        return (
          <div key={dir.path}>
            <button
              type="button"
              className="tree-dir"
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => onToggle(dir.path)}
              aria-expanded={!isCollapsed}
              title={dir.path}
            >
              <span className={`chevron${isCollapsed ? ' collapsed' : ''}`} aria-hidden="true">
                ▾
              </span>
              <span className="tree-name">{dir.name}</span>
              {isCollapsed && (
                <span className="tree-stat dim">
                  {dir.totals.files} {dir.totals.files > 1 ? 'files' : 'file'}
                </span>
              )}
            </button>

            {!isCollapsed && (
              <Node
                node={dir}
                depth={depth + 1}
                activeId={activeId}
                collapsed={collapsed}
                onSelect={onSelect}
                onToggle={onToggle}
              />
            )}
          </div>
        )
      })}

      {node.files.map((file) => (
        <button
          key={file.id}
          type="button"
          className={`tree-file${file.id === activeId ? ' active' : ''}`}
          style={{ paddingLeft: 8 + depth * 12 + 14 }}
          onClick={() => onSelect(file.id)}
          title={file.path}
        >
          <span className="tree-name">{file.label}</span>
          <Counts {...file} />
        </button>
      ))}
    </>
  )
}

function FileTree({ tree, activeId, collapsed, onSelect, onToggle }) {
  return (
    <nav className="tree" aria-label="Changed files">
      <Node
        node={tree}
        depth={0}
        activeId={activeId}
        collapsed={collapsed}
        onSelect={onSelect}
        onToggle={onToggle}
      />
    </nav>
  )
}

export default memo(FileTree)
