/**
 * The file a right-click lands on: a file row of the tree, or a file's header
 * in the diff, found through the Viewed control the header holds. Elsewhere the
 * default menu stays, such as Copy on selected code.
 */
export function contextFile(event: Event): string | null {
  for (const node of event.composedPath()) {
    if (!(node instanceof HTMLElement)) continue
    if (node.dataset.itemType === 'file' && node.dataset.itemPath) return node.dataset.itemPath
    if (node.dataset.headerPath) return node.dataset.headerPath
    if (node.hasAttribute('data-diffs-header')) {
      // Each file renders in its own shadow root; the header's controls are slotted into its host.
      const root = node.getRootNode()
      const host = root instanceof ShadowRoot ? root.host : null
      return host?.querySelector<HTMLElement>('[data-header-path]')?.dataset.headerPath ?? null
    }
  }
  return null
}
