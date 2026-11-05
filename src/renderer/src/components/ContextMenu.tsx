import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export interface MenuItem {
  label?: string
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  onClick?: () => void
}

interface ContextMenuProps {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPosition({
      left: Math.min(x, window.innerWidth - rect.width - 8),
      top: Math.min(y, window.innerHeight - rect.height - 8)
    })
  }, [x, y])

  useEffect(() => {
    const close = (): void => onClose()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="fixed z-[70] min-w-[180px] overflow-hidden rounded-lg border border-line-2 bg-panel-2 py-1 shadow-xl shadow-black/50"
      style={{ left: position.left, top: position.top }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {items.map((item, index) =>
        item.separator ? (
          <div key={`sep-${index}`} className="my-1 h-px bg-line" />
        ) : (
          <button
            key={item.label ?? index}
            disabled={item.disabled}
            className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs transition ${
              item.disabled
                ? 'cursor-not-allowed text-faint'
                : item.danger
                  ? 'text-err hover:bg-err/10'
                  : 'text-ink hover:bg-panel-3'
            }`}
            onClick={() => {
              onClose()
              item.onClick?.()
            }}
          >
            <span className="flex h-4 w-4 items-center justify-center opacity-80">
              {item.icon}
            </span>
            <span className="flex-1">{item.label}</span>
          </button>
        )
      )}
    </div>
  )
}
