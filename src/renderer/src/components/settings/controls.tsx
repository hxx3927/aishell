import { Undo2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { SETTINGS_DEFAULTS, type ResettableSetting } from '../../lib/settingsDefaults'

interface SettingRowProps {
  /** Short, title-case label. The description goes underneath it. */
  label: ReactNode
  description?: ReactNode
  /** Rendered on the right. Omit for rows whose control sits below the label. */
  control: ReactNode
  /** Marks the row as changed from its default and offers a reset. */
  resetKey?: ResettableSetting
  onReset?: () => void
  /** Stacks the control under the label (text inputs, long descriptions). */
  stacked?: boolean
  /** Shown faint while the search box filters the other sections out. */
  dimmed?: boolean
}

/**
 * One preference: title and description on the left, control on the right —
 * the layout Termius and VS Code use, so rows scan vertically.
 */
export function SettingRow({
  label,
  description,
  control,
  resetKey,
  onReset,
  stacked,
  dimmed
}: SettingRowProps): React.JSX.Element {
  const showReset = Boolean(resetKey && onReset)
  return (
    <div
      className={`group relative px-4 py-3 transition ${stacked ? '' : 'flex items-center gap-4'} ${
        dimmed ? 'opacity-35' : ''
      }`}
      data-setting={resetKey}
    >
      {showReset && (
        <span
          className="absolute inset-y-2 left-0 w-[2px] rounded-full bg-accent/70"
          aria-hidden
        />
      )}
      <div className={stacked ? '' : 'min-w-0 flex-1'}>
        <div className="flex items-center gap-2 text-xs text-ink">
          {label}
          {showReset && (
            <button
              className="flex items-center gap-1 rounded px-1 py-0.5 text-[10px] text-faint opacity-0 transition hover:bg-panel-3 hover:text-ink group-hover:opacity-100 focus:opacity-100"
              title={`恢复默认：${String(resetKey && SETTINGS_DEFAULTS[resetKey])}`}
              onClick={onReset}
            >
              <Undo2 size={11} />
              重置
            </button>
          )}
        </div>
        {description && (
          <div className="mt-0.5 text-[10px] leading-relaxed text-faint">{description}</div>
        )}
      </div>
      <div className={stacked ? 'mt-2' : 'shrink-0'}>{control}</div>
    </div>
  )
}

export function SettingGroup({
  title,
  description,
  children
}: {
  title?: ReactNode
  description?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className="mb-4">
      {title && (
        <div className="mb-1.5 px-1">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-dim">
            {title}
          </div>
          {description && <div className="mt-0.5 text-[10px] text-faint">{description}</div>}
        </div>
      )}
      <div className="divide-y divide-line overflow-hidden rounded-xl border border-line-2 bg-panel-2/50">
        {children}
      </div>
    </section>
  )
}

export function Toggle({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label?: string
}): React.JSX.Element {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition ${
        checked ? 'bg-accent' : 'bg-segment'
      }`}
      onClick={() => onChange(!checked)}
    >
      <span
        className={`absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow transition-all ${
          checked ? 'left-[18px]' : 'left-[2px]'
        }`}
      />
    </button>
  )
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange
}: {
  value: T
  options: Array<{ value: T; label: ReactNode }>
  onChange: (value: T) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-panel-3 p-0.5">
      {options.map((option) => (
        <button
          key={String(option.value)}
          className={`rounded-[7px] px-2.5 py-1 text-[11px] transition ${
            option.value === value
              ? 'bg-segment text-ink shadow-sm'
              : 'text-dim hover:text-ink'
          }`}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  width = 'w-40'
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  width?: string
}): React.JSX.Element {
  return (
    <select
      className={`input ${width} py-1`}
      value={value}
      onChange={(event) => {
        const raw = event.target.value
        const match = options.find((option) => String(option.value) === raw)
        onChange((match?.value ?? (raw as T)) as T)
      }}
    >
      {options.map((option) => (
        <option key={String(option.value)} value={String(option.value)}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

export function NumberField({
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
  width = 'w-24'
}: {
  value: number
  min: number
  max: number
  step?: number
  suffix?: string
  onChange: (value: number) => void
  width?: string
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        className={`input ${width} text-right font-mono`}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          const next = Number(event.target.value)
          if (!Number.isFinite(next)) return
          onChange(Math.min(max, Math.max(min, next)))
        }}
      />
      {suffix && <span className="text-[10px] text-faint">{suffix}</span>}
    </div>
  )
}
