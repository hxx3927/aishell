import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import { useAppStore } from '../state/store'

const ICONS = {
  info: Info,
  warn: AlertTriangle,
  error: AlertTriangle
}

const COLORS = {
  info: 'border-accent/30 text-accent',
  warn: 'border-warn/30 text-warn',
  error: 'border-err/30 text-err'
}

export function ToastHost(): React.JSX.Element {
  const toasts = useAppStore((s) => s.toasts)
  const dismiss = useAppStore((s) => s.dismissToast)

  return (
    <div className="pointer-events-none fixed bottom-12 right-4 z-[80] flex w-[360px] flex-col gap-2">
      {toasts.map((toast) => {
        const Icon = ICONS[toast.level]
        return (
          <div
            key={toast.id}
            className={`slide-in pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-panel-2/95 px-3.5 py-2.5 shadow-lg shadow-black/40 backdrop-blur ${COLORS[toast.level]}`}
          >
            <Icon size={15} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-ink">
              {toast.message}
            </div>
            <button
              className="shrink-0 rounded p-0.5 text-faint transition hover:text-ink"
              onClick={() => dismiss(toast.id)}
            >
              <X size={13} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

export function SuccessIcon(): React.JSX.Element {
  return <CheckCircle2 size={14} className="text-ok" />
}
