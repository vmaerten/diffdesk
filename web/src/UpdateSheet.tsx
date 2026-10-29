import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react'
import appIcon from '../../desktop/icon/AppIcon.svg?url'
import { commandOf } from './commands.ts'
import { IDLE_UPDATE, recordUpdate, type UpdateSnapshot } from './updates.ts'

const ReleaseNotes = lazy(() => import('./ReleaseNotes.tsx'))

/** The updater subscribes on its own so its progress never rerenders the review. */
export default function UpdateSheet() {
  const [state, setState] = useState(IDLE_UPDATE)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Remind Me Later hides this revision only: the offer stays in the palette.
  const [hidden, setHidden] = useState<number | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const accept = (next: UpdateSnapshot) =>
    setState((current) => (next.revision >= current.revision ? next : current))

  useEffect(() => {
    const api = window.go?.main.desktopApp
    if (!api || !window.runtime) return
    let disposed = false
    const receive = (next: UpdateSnapshot) => {
      if (!disposed) accept(next)
    }
    const unsubscribe = window.runtime.EventsOn<UpdateSnapshot>('desktop:update', receive)
    void api
      .UpdateStatus()
      .then(receive)
      .catch((cause) => {
        if (!disposed) setError(String(cause))
      })
    // The palette's update commands; the menu checks from Go.
    const runCommand = (event: Event) => {
      const command = commandOf(event)
      if (command !== 'check-updates' && command !== 'install-update') return
      setHidden(null)
      if (command === 'check-updates')
        api.CheckForUpdates().catch((cause) => setError(String(cause)))
    }
    window.addEventListener('desktop:command', runCommand)
    return () => {
      disposed = true
      unsubscribe()
      window.removeEventListener('desktop:command', runCommand)
    }
  }, [])

  useEffect(() => recordUpdate(state), [state])

  const api = window.go?.main.desktopApp
  const shown = !!api && (state.status !== 'idle' || !!error) && hidden !== state.revision
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (shown && !element.open) {
      element.showModal()
      // Not a button: the sheet can open while someone types, and no key may answer it.
      element.querySelector<HTMLElement>('.update-sheet-notes')?.focus()
    } else if (!shown && element.open) element.close()
  }, [shown])
  // A step without buttons takes the focus from the one just pressed.
  useEffect(() => {
    const element = dialog.current
    if (element?.open && !element.contains(document.activeElement)) element.focus()
  }, [state.status])

  const run = async (action: () => Promise<UpdateSnapshot | void>) => {
    setPending(true)
    setError(null)
    try {
      const next = await action()
      if (next) accept(next)
    } catch (cause) {
      setError(String(cause))
    } finally {
      setPending(false)
    }
  }
  if (!api) return null
  const later = () => setHidden(state.revision)
  const busy = state.status === 'installing' || state.status === 'restarting'
  let title = 'A new version of Diffdesk is available'
  let description = `Diffdesk ${state.version} is ready to install with ${state.manager}.`
  if (state.status === 'checking') {
    title = 'Checking for Updates…'
    description = 'Looking for a newer stable version of Diffdesk.'
  } else if (state.status === 'installing') {
    title = `Updating to Diffdesk ${state.version}…`
    description = 'Diffdesk restarts when the install is done.'
  } else if (state.status === 'restarting') {
    title = 'Restarting Diffdesk…'
    description = 'The update is installed. Reopening your comparison.'
  } else if (state.status === 'error' || error) {
    title = 'The update couldn’t be completed'
    description = 'Diffdesk keeps running. You can continue your review.'
  } else if (state.status === 'current') {
    title = 'You’re up to date'
    description = `Diffdesk ${state.version} is the latest stable version.`
  }
  return (
    <dialog
      ref={dialog}
      className="desktop-sheet update-sheet"
      aria-labelledby={titleId}
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault()
        if (state.status === 'available' || state.status === 'checking') later()
        else if (!busy) void run(() => api.DismissUpdate())
      }}
    >
      {shown && (
        <>
          <header className="update-sheet-head">
            <img src={appIcon} alt="" />
            <div role="status" aria-live="polite" aria-atomic="true">
              <h2 id={titleId}>{title}</h2>
              <p>{description}</p>
            </div>
          </header>
          {state.version && state.status !== 'current' ? (
            <div
              className="update-sheet-notes"
              key={state.version}
              role="region"
              aria-label={`What’s new in ${state.version}`}
              tabIndex={0}
            >
              <Suspense fallback={<p>Loading release notes…</p>}>
                <ReleaseNotes notes={state.notes} version={state.version} />
              </Suspense>
            </div>
          ) : null}
          {state.status === 'checking' || state.status === 'installing' ? (
            <div
              className="update-progress"
              role="progressbar"
              aria-label={
                state.status === 'checking' ? 'Checking for updates' : 'Installing update'
              }
            >
              <span />
            </div>
          ) : null}
          {state.status === 'available' ? (
            <p className="update-sheet-note">
              Your comparison reopens after the restart. Unsaved drafts and other open tabs are
              discarded.
            </p>
          ) : null}
          {state.status === 'available' && state.manager === 'mise' ? (
            <p className="update-sheet-note">
              mise will select latest globally. Project version pins remain in effect.
            </p>
          ) : null}
          {error || state.message ? (
            <details className="update-details">
              <summary>Error details</summary>
              <pre>{error ?? state.message}</pre>
            </details>
          ) : null}
          {busy ? null : (
            <footer>
              {state.status === 'available' ? (
                <>
                  <button
                    type="button"
                    className="button update-skip"
                    disabled={pending}
                    onClick={() => void run(() => api.SkipUpdate())}
                  >
                    Skip This Version
                  </button>
                  <button type="button" className="button" onClick={later}>
                    Remind Me Later
                  </button>
                  <button
                    type="button"
                    className="button primary"
                    disabled={pending}
                    onClick={() => void run(() => api.InstallUpdate())}
                  >
                    Update and Restart
                  </button>
                </>
              ) : state.status === 'checking' ? (
                <button type="button" className="button" onClick={later}>
                  Hide
                </button>
              ) : state.status === 'current' ? (
                <button
                  type="button"
                  className="button primary"
                  disabled={pending}
                  onClick={() => void run(() => api.DismissUpdate())}
                >
                  OK
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="button"
                    disabled={pending}
                    onClick={() => void run(() => api.DismissUpdate())}
                  >
                    Dismiss
                  </button>
                  {state.retry ? (
                    <button
                      type="button"
                      className="button primary"
                      disabled={pending}
                      onClick={() =>
                        void run(() =>
                          state.retry === 'install' ? api.InstallUpdate() : api.CheckForUpdates(),
                        )
                      }
                    >
                      Try Again
                    </button>
                  ) : null}
                </>
              )}
            </footer>
          )}
        </>
      )}
    </dialog>
  )
}
