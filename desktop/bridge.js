// Only injected inside the desktop app's Wails document. Browser UI is unchanged.
;(() => {
  if (!window.runtime?.ClipboardSetText) throw new Error('Desktop runtime is missing')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      async writeText(text) {
        const copied = await window.runtime.ClipboardSetText(String(text))
        if (!copied) throw new Error('Native clipboard refused the copy')
      },
      readText: () => window.runtime.ClipboardGetText(),
    },
  })
  // WebKit drops target="_blank" navigations: Wails opens no window for them.
  // Only web pages leave for the browser, never a file or app link from a
  // reviewed README. composedPath reaches links inside shadow roots.
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return
    const link = event
      .composedPath()
      .find((node) => node instanceof HTMLAnchorElement && node.target === '_blank')
    if (!link) return
    event.preventDefault()
    if (link.protocol === 'https:' || link.protocol === 'http:')
      void window.runtime.BrowserOpenURL(link.href)
  })
})()
