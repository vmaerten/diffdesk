import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import appIcon from '../../desktop/icon/AppIcon.svg?url'
import { IDLE_UPDATE, type UpdateSnapshot } from './updates.ts'

const ReleaseNotes = lazy(() => import('./ReleaseNotes.tsx'))

/** The updater subscribes on its own so its progress never rerenders the review. */
export default function UpdateBanner() {
  const [state, setState] = useState(IDLE_UPDATE)
  const [confirmation, setConfirmation] = useState<number | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notesVersion, setNotesVersion] = useState<string | null>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const update = useRef<HTMLButtonElement>(null)
  const confirming = state.status === 'available' && confirmation === state.revision
  const wasConfirming = useRef(false)
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
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (confirming) cancel.current?.focus()
    else if (wasConfirming.current) update.current?.focus()
    wasConfirming.current = confirming
  }, [confirming])

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
  const api = window.go?.main.desktopApp
  if (!api || (state.status === 'idle' && !error)) return null
  const busy =
    state.status === 'checking' || state.status === 'installing' || state.status === 'restarting'
  let title = `Diffdesk ${state.version} is available`
  let description = 'Keep your review going. Update whenever you’re ready.'
  if (confirming) {
    title = 'Update and restart Diffdesk?'
    description =
      'Your active comparison will reopen. Unsaved drafts and other open tabs will be discarded.'
  } else if (state.status === 'checking') {
    title = 'Checking for updates…'
    description = 'Looking for a newer stable version of Diffdesk.'
  } else if (state.status === 'installing') {
    title = 'Updating Diffdesk…'
    description = 'The update is being installed. Your comparison will reopen after the restart.'
  } else if (state.status === 'restarting') {
    title = 'Restarting Diffdesk…'
    description = 'The update is installed. Reopening your active comparison.'
  } else if (state.status === 'error' || error) {
    title = 'The update couldn’t be completed'
    description = 'Diffdesk will keep running. You can continue your review.'
  } else if (state.status === 'current') {
    title = 'You’re up to date'
    description = `Diffdesk ${state.version} is the latest stable version.`
  }
  return (
    <section
      className="update-banner"
      aria-label="Diffdesk update"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && confirming) {
          event.preventDefault()
          event.stopPropagation()
          setConfirmation(null)
        }
      }}
    >
      <img className="update-icon" src={appIcon} alt="" />
      <div className="update-copy">
        <div role="status" aria-live="polite" aria-atomic="true">
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {confirming && state.manager === 'mise' ? (
          <p className="update-note">
            mise will select latest globally. Project version pins remain in effect.
          </p>
        ) : null}
        {state.version && state.status !== 'current' ? (
          <details
            className="update-notes"
            key={state.version}
            onToggle={(event) => setNotesVersion(event.currentTarget.open ? state.version : null)}
          >
            <summary>What’s new in {state.version}</summary>
            {notesVersion === state.version ? (
              <div className="update-notes-body">
                <Suspense fallback={<p>Loading release notes…</p>}>
                  <ReleaseNotes notes={state.notes} version={state.version} />
                </Suspense>
              </div>
            ) : null}
          </details>
        ) : null}
        {error || state.message ? (
          <details className="update-details">
            <summary>Error details</summary>
            <pre>{error ?? state.message}</pre>
          </details>
        ) : null}
        {state.status === 'installing' ? (
          <div className="update-progress" role="progressbar" aria-label="Installing update">
            <span />
          </div>
        ) : null}
      </div>
      <div className="update-actions">
        {busy ? (
          <span className="update-spinner" aria-hidden="true" />
        ) : confirming ? (
          <>
            <button
              ref={cancel}
              type="button"
              className="button"
              disabled={pending}
              onClick={() => setConfirmation(null)}
            >
              Cancel
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
        ) : (
          <>
            <button
              type="button"
              className="button"
              disabled={pending}
              onClick={() => void run(() => api.DismissUpdate())}
            >
              {state.status === 'available' ? 'Later' : 'Dismiss'}
            </button>
            {state.status === 'available' ? (
              <button
                ref={update}
                type="button"
                className="button primary"
                disabled={pending}
                onClick={() => setConfirmation(state.revision)}
              >
                Update…
              </button>
            ) : state.retry ? (
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
      </div>
    </section>
  )
}
