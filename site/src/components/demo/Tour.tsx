import { useStableCallback } from '@pierre/diffs/react'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { playTour, STEPS, type Cursor } from './playTour.ts'

// The tour needs room beside the terminal, and a pointer to stand for.
const TOUR_SCREEN = '(min-width: 1024px) and (hover: hover)'

type Progress = { state: 'idle' | 'playing' | 'over'; step: number }

/**
 * The bar that plays the tour, and the cursor that plays it. Their state lives
 * here: kept in the demo, each move would render the diff again under the
 * visitor's pointer, and drop what it hovers.
 */
export default function Tour({
  frame,
  onReset,
}: {
  frame: RefObject<HTMLDivElement | null>
  /** Brings the demo back to its first state, which the tour plays from. */
  onReset: () => void
}) {
  const [canTour] = useState(() => matchMedia(TOUR_SCREEN).matches)
  const [progress, setProgress] = useState<Progress>({ state: 'idle', step: 0 })
  const [cursor, setCursor] = useState<(Cursor & { shown: boolean }) | null>(null)
  const ghost = useRef<HTMLDivElement>(null)
  const playing = useRef<AbortController | null>(null)

  const start = useStableCallback(() => {
    if (!frame.current || playing.current) return
    const controller = new AbortController()
    playing.current = controller
    onReset()
    setProgress({ state: 'playing', step: 0 })
    const stage = {
      frame: frame.current,
      // Kept in the stage's coordinates, so the cursor follows the page as it scrolls.
      cursor: (next: Cursor | null) => {
        const origin = ghost.current?.offsetParent?.getBoundingClientRect()
        setCursor((last) =>
          next && origin
            ? { ...next, x: next.x - origin.left, y: next.y - origin.top, shown: true }
            : last && { ...last, shown: false },
        )
      },
      step: (step: number) => setProgress({ state: 'playing', step }),
    }
    playTour(stage, controller.signal)
      .catch(() => {})
      .finally(() => {
        playing.current = null
        setProgress((last) => ({ ...last, state: 'over' }))
      })
  })

  // Any real click or key hands the demo back to the visitor.
  useEffect(() => {
    if (progress.state !== 'playing') return
    const takeOver = (event: Event) => {
      if (event.isTrusted) playing.current?.abort(event)
    }
    document.addEventListener('pointerdown', takeOver, true)
    document.addEventListener('keydown', takeOver, true)
    return () => {
      document.removeEventListener('pointerdown', takeOver, true)
      document.removeEventListener('keydown', takeOver, true)
    }
  }, [progress.state])

  // Plays once, when the demo comes into view, unless the visitor asked for less
  // motion or already tried the demo: the tour starts over from the first state.
  useEffect(() => {
    const element = frame.current
    if (!canTour || !element || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      clearTimeout(timer)
      observer.disconnect()
      document.removeEventListener('pointerdown', touched, true)
      document.removeEventListener('keydown', touched, true)
    }
    const touched = (event: Event) => {
      if (event.isTrusted && element.parentElement?.contains(event.target as Node)) stop()
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        clearTimeout(timer)
        if (!entry?.isIntersecting) return
        timer = setTimeout(() => {
          stop()
          start()
        }, 700)
      },
      { threshold: 0.6 },
    )
    observer.observe(element)
    document.addEventListener('pointerdown', touched, true)
    document.addEventListener('keydown', touched, true)
    return stop
  }, [canTour, frame, start])

  if (!canTour) return null
  return (
    <>
      <div className="tour-bar">
        {progress.state === 'playing' ? (
          <>
            <span className="tour-steps" aria-hidden="true">
              {STEPS.map((_, index) => (
                <span
                  key={index}
                  className={
                    index === progress.step ? 'on' : index < progress.step ? 'done' : undefined
                  }
                />
              ))}
            </span>
            <span className="tour-caption" aria-live="polite">
              {STEPS[progress.step]}
            </span>
            <button type="button" onClick={() => playing.current?.abort()}>
              Take over
            </button>
          </>
        ) : (
          <button type="button" onClick={start}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5 3.5v9l7.5-4.5z" fill="currentColor" />
            </svg>
            {progress.state === 'idle' ? 'Watch it play' : 'Replay the tour'}
          </button>
        )}
      </div>
      <div
        ref={ghost}
        className={`ghost-cursor${cursor?.shown ? ' on' : ''}${cursor?.pressed ? ' pressed' : ''}`}
        style={cursor ? { transform: `translate(${cursor.x}px, ${cursor.y}px)` } : undefined}
        aria-hidden="true"
      >
        <svg viewBox="0 0 24 24">
          <path d="M3 2l14 12.5h-7l4 7.5-2.8 1.4-4-7.6L3 20.5z" />
        </svg>
        {cursor?.keys && <kbd>{cursor.keys}</kbd>}
      </div>
    </>
  )
}
