type Detail = string | number | boolean | null | undefined
type Details = Record<string, Detail>

interface DebugTransport {
  append: (raw: string) => Promise<void>
  read: () => Promise<string>
  clear: () => Promise<void>
}

/** Append every event to the native log file; callers never pass source or draft text. */
export function createDebugLog(transport: DebugTransport) {
  const page = crypto.randomUUID()
  let enabled = false
  let sequence = 0
  let writes = Promise.resolve()
  let unsaved: string[] = []
  const record = (event: string, details: Details = {}) => {
    if (!enabled) return
    const raw = JSON.stringify({
      time: new Date().toISOString(),
      page,
      sequence: ++sequence,
      event,
      details,
    })
    writes = writes
      .then(() => transport.append(raw))
      .catch(() => {
        unsaved.push(raw)
      })
  }
  return {
    get enabled() {
      return enabled
    },
    configure(value: boolean) {
      if (enabled === value) return
      if (value) {
        enabled = true
        record('logging.enabled')
      } else {
        record('logging.disabled')
        enabled = false
      }
    },
    record,
    flush: () => writes,
    async clear() {
      await writes
      await transport.clear()
      unsaved = []
    },
    async text() {
      await writes
      let raw = ''
      let readFailed = false
      try {
        raw = await transport.read()
      } catch {
        readFailed = true
      }
      return JSON.stringify(
        {
          version: 1,
          exportedAt: new Date().toISOString(),
          events: raw
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
          ...(unsaved.length ? { unsavedEvents: unsaved.map((line) => JSON.parse(line)) } : {}),
          ...(readFailed ? { readFailed: true } : {}),
        },
        null,
        2,
      )
    },
  }
}

export const debugLog = createDebugLog({
  append: (raw) => window.go!.main.desktopApp.AppendDebugEvent(raw),
  read: () => window.go!.main.desktopApp.DebugLog(),
  clear: () => window.go!.main.desktopApp.ClearDebugLog(),
})

/** Include the app build and WebView version, without exporting repository paths from health. */
export async function copyDebugLogs(): Promise<void> {
  let build: { version: string; commit: string; buildDate: string } | null = null
  try {
    const response = await fetch('/api/health')
    if (response.ok) {
      const { version, commit, buildDate } = await response.json()
      build = { version, commit, buildDate }
    }
  } catch {
    /* The recorded events remain useful if the server is unavailable. */
  }
  await navigator.clipboard.writeText(
    JSON.stringify(
      {
        ...JSON.parse(await debugLog.text()),
        environment: {
          build,
          userAgent: navigator.userAgent,
          viewport: { width: innerWidth, height: innerHeight },
        },
      },
      null,
      2,
    ),
  )
}
