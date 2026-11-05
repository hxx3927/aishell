import { X } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'

interface ModalProps {
  open: boolean
  title?: ReactNode
  subtitle?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: string
  bodyClass?: string
}

export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 'max-w-xl',
  bodyClass = ''
}: ModalProps): React.JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
        onMouseDown={onClose}
      />
      <div
        className={`slide-in relative flex max-h-[86vh] w-[92vw] ${width} flex-col overflow-hidden rounded-xl border border-line-2 bg-panel shadow-2xl shadow-black/60`}
      >
        {(title || subtitle) && (
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <div className="text-[15px] font-semibold text-ink">{title}</div>
              {subtitle && <div className="mt-1 text-xs text-dim">{subtitle}</div>}
            </div>
            <button
              className="rounded-md p-1.5 text-dim transition hover:bg-panel-3 hover:text-ink"
              onClick={onClose}
              title="关闭"
            >
              <X size={16} />
            </button>
          </div>
        )}
        <div className={`min-h-0 flex-1 overflow-auto px-5 py-4 ${bodyClass}`}>{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-line bg-panel-2/60 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
