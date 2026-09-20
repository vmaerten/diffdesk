import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { ImageComparison, ImageVersion } from '../../src/types.ts'

function ImageZoom({ src, title, onClose }: { src: string; title: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const close = () => {
    dialogRef.current?.close()
    onClose()
  }

  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])

  // Outside the virtualized file: its clipping and scrolling must not constrain
  // the overlay. A native modal handles focus trapping and Escape.
  return createPortal(
    <dialog
      ref={dialogRef}
      className="image-zoom"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close()
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="image-zoom-heading">
        <span>{title}</span>
        <button type="button" onClick={close} aria-label="Close image preview">
          ×
        </button>
      </div>
      <img className="image-zoom-content" src={src} alt={title} />
    </dialog>,
    document.body,
  )
}

function ImageSide({
  version,
  label,
  path,
}: {
  version: ImageVersion
  label: string
  path: string
}) {
  const [failed, setFailed] = useState(false)
  const [dimensions, setDimensions] = useState('')
  const [zoomed, setZoomed] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  return (
    <figure className="image-side">
      <figcaption>{label}</figcaption>
      <div className="image-canvas">
        {version.url && !failed ? (
          <button
            ref={triggerRef}
            type="button"
            className="image-zoom-trigger"
            aria-label={`Enlarge ${label.toLowerCase()}: ${path}`}
            title="Click to enlarge"
            onClick={() => setZoomed(true)}
          >
            <img
              src={version.url}
              alt={`${label}: ${path}`}
              decoding="async"
              onLoad={(event) =>
                setDimensions(
                  `${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`,
                )
              }
              onError={() => setFailed(true)}
            />
          </button>
        ) : (
          <span className="image-error">
            {version.error ?? 'This image could not be displayed.'}
          </span>
        )}
      </div>
      <div className="image-details">
        {dimensions}
        {version.bytes !== undefined &&
          `${dimensions ? ' · ' : ''}${Math.max(1, Math.round(version.bytes / 1024))} KB`}
      </div>
      {zoomed && version.url && (
        <ImageZoom
          src={version.url}
          title={`${label}: ${path}`}
          onClose={() => {
            setZoomed(false)
            triggerRef.current?.focus({ preventScroll: true })
          }}
        />
      )}
    </figure>
  )
}

export default function ImageDiff({ image, path }: { image: ImageComparison; path: string }) {
  return (
    <div className="image-comparison" data-image-path={path}>
      {image.before && (
        <ImageSide
          key={`before:${image.before.url}`}
          version={image.before}
          label={image.after ? 'Before' : 'Deleted'}
          path={path}
        />
      )}
      {image.after && (
        <ImageSide
          key={`after:${image.after.url}`}
          version={image.after}
          label={image.before ? 'After' : 'Added'}
          path={path}
        />
      )}
    </div>
  )
}
