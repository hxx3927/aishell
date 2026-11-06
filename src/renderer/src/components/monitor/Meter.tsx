import { meterBarClass, meterLevel, meterTrackClass } from './format'

interface MeterProps {
  /** 0–100. */
  value: number
  className?: string
}

/** A 4px usage bar; the hue follows the same 70/90 thresholds as the cards. */
export function Meter({ value, className }: MeterProps) {
  const pct = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0
  const level = meterLevel(pct)
  return (
    <div
      className={`h-1 w-full overflow-hidden rounded-full ${meterTrackClass[level]} ${className ?? ''}`}
      aria-hidden="true"
    >
      <div
        className={`h-full rounded-full transition-[width] duration-500 ${meterBarClass[level]}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}
