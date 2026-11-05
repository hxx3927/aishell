import { useCallback, useRef } from 'react'

interface ResizeHandleProps {
  axis: 'x' | 'y'
  onDelta: (delta: number) => void
  className?: string
}

export function ResizeHandle({ axis, onDelta, className = '' }: ResizeHandleProps): React.JSX.Element {
  const dragging = useRef(false)

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }, [])

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return
      const delta = axis === 'x' ? event.movementX : event.movementY
      if (delta !== 0) onDelta(delta)
    },
    [axis, onDelta]
  )

  const stop = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* ignore */
    }
  }, [])

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      className={`no-drag group relative z-10 ${
        axis === 'x' ? 'w-1.5 cursor-col-resize self-stretch' : 'h-1.5 cursor-row-resize'
      } ${className}`}
    >
      <div
        className={`absolute bg-transparent transition group-hover:bg-accent/40 ${
          axis === 'x' ? 'inset-y-0 left-1/2 w-px' : 'inset-x-0 top-1/2 h-px'
        }`}
      />
    </div>
  )
}
