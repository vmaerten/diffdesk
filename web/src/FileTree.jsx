import { memo } from 'react'

/**
 * Group flat paths into a directory tree, collapsing chains of single-child
 * directories into one row (`frontend/src/modules` rather than three levels).
 * Real diffs here are 100+ files deep under `frontend/src/...`, so without this
 * the tree is mostly indentation.
 */
export function buildTree(entries) {
  const root = { name: '', dirs: new Map(), files: [] }

  for (const entry of entries) {
    const parts = entry.path.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { name: part, dirs: new Map(), files: [] })
      node = node.dirs.get(part)
    }
    node.files.push({ ...entry, label: parts[parts.length - 1] })
  }

  const collapse = (node) => {
    const dirs = [...node.dirs.values()].map(collapse)
    if (dirs.length === 1 && node.files.length === 0 && node.name) {
      const only = dirs[0]
      return { ...only, name: `${node.name}/${only.name}` }
    }
    return { ...node, dirs }
  }

  return collapse(root)
}

const Stat = ({ additions, deletions, binary }) =>
  binary ? (
    <span className="tree-stat dim">bin</span>
  ) : (
    <span className="tree-stat">
      {additions > 0 && <span className="add">+{additions}</span>}
      {deletions > 0 && <span className="del">−{deletions}</span>}
    </span>
  )

function Node({ node, depth, activeId, onSelect }) {
  return (
    <>
      {node.dirs.map((dir) => (
        <div key={dir.name || depth}>
          <div className="tree-dir" style={{ paddingLeft: 8 + depth * 12 }}>
            {dir.name}
          </div>
          <Node node={dir} depth={depth + 1} activeId={activeId} onSelect={onSelect} />
        </div>
      ))}

      {node.files.map((file) => (
        <button
          key={file.id}
          type="button"
          className={`tree-file${file.id === activeId ? ' active' : ''}`}
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => onSelect(file.id)}
          title={file.path}
        >
          <span className="tree-name">{file.label}</span>
          <Stat {...file} />
        </button>
      ))}
    </>
  )
}

function FileTree({ entries, activeId, onSelect }) {
  const tree = buildTree(entries)
  return (
    <nav className="tree" aria-label="Changed files">
      <Node node={tree} depth={0} activeId={activeId} onSelect={onSelect} />
    </nav>
  )
}

export default memo(FileTree)
