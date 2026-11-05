import { useEffect, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useAppStore } from '../state/store'
import { Modal } from './Modal'

export function AppDialog(): React.JSX.Element | null {
  const dialog = useAppStore((s) => s.dialog)
  const close = useAppStore((s) => s.closeDialog)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (dialog?.kind === 'prompt') {
      setValue(dialog.value)
      setError(null)
      setTimeout(() => inputRef.current?.select(), 30)
    }
  }, [dialog])

  if (!dialog) return null

  if (dialog.kind === 'confirm') {
    return (
      <Modal
        open
        title={dialog.title}
        onClose={close}
        width="max-w-md"
        footer={
          <>
            <button className="btn-secondary" onClick={close}>
              取消
            </button>
            <button
              className={dialog.danger ? 'btn-danger' : 'btn-primary'}
              onClick={() => {
                dialog.resolve(true)
                useAppStore.setState({ dialog: null })
              }}
            >
              {dialog.confirmText ?? '确定'}
            </button>
          </>
        }
      >
        <div className="flex gap-3">
          {dialog.danger && (
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warn" />
          )}
          <div className="whitespace-pre-wrap text-xs leading-relaxed text-dim">
            {dialog.message}
          </div>
        </div>
      </Modal>
    )
  }

  const submit = (): void => {
    const message = dialog.validate?.(value) ?? null
    if (message) {
      setError(message)
      return
    }
    dialog.resolve(value)
    useAppStore.setState({ dialog: null })
  }

  return (
    <Modal
      open
      title={dialog.title}
      onClose={close}
      width="max-w-md"
      footer={
        <>
          <button className="btn-secondary" onClick={close}>
            取消
          </button>
          <button className="btn-primary" onClick={submit}>
            确定
          </button>
        </>
      }
    >
      {dialog.message && <div className="mb-3 text-xs text-dim">{dialog.message}</div>}
      <input
        ref={inputRef}
        className="input"
        value={value}
        placeholder={dialog.placeholder}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit()
        }}
      />
      {error && <div className="mt-2 text-xs text-err">{error}</div>}
    </Modal>
  )
}
