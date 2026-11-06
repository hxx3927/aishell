import { LineChart as LineChartIcon, Table2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MonitorSample } from '@shared/types'
import { clamp, formatClock } from '../../lib/format'

export interface TrendSeries {
  key: string
  label: string
  /** A CSS color, e.g. `var(--color-chart-1)`. */
  color: string
  /** One value per sample, in the same order. */
  values: number[]
}

interface TrendChartProps {
  title: string
  hint?: string
  samples: MonitorSample[]
  series: TrendSeries[]
  format: (value: number) => string
  /** Compact axis labels; defaults to `format`. */
  formatAxis?: (value: number) => string
  /** Fixed domain ceiling for percentages; auto-scaled otherwise. */
  fixedMax?: number
  /** Fixed time window ending at the newest sample, in ms. */
  windowMs?: number
  emptyText?: string
}

const HEIGHT = 176
const MARGIN = { top: 12, right: 14, bottom: 20, left: 46 }
const TABLE_ROWS = 30

function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  const exponent = Math.floor(Math.log10(value))
  const base = 10 ** exponent
  const normalized = value / base
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return step * base
}

function linePath(points: Array<[number, number]>): string {
  return points
    .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ')
}

export function TrendChart({
  title,
  hint,
  samples,
  series,
  format,
  formatAxis,
  fixedMax,
  windowMs,
  emptyText = '等待首个样本…'
}: TrendChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const [view, setView] = useState<'chart' | 'table'>('chart')

  useEffect(() => {
    const element = wrapRef.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      setWidth(Math.floor(entries[0].contentRect.width))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const count = samples.length
  const lastTs = samples[count - 1]?.ts ?? 0
  // A fixed window keeps the axis stable while the first minute fills up,
  // instead of stretching two samples across the whole chart.
  const t0 = windowMs ? lastTs - windowMs : (samples[0]?.ts ?? lastTs)
  const t1 = lastTs
  const span = t1 - t0
  const maxValue = useMemo(() => {
    let max = 0
    for (const item of series) for (const value of item.values) max = Math.max(max, value)
    return max
  }, [series])

  const yMax = fixedMax ?? (maxValue > 0 ? niceMax(maxValue) : 1024)
  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right)
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom

  const xOf = (ts: number): number => {
    if (count <= 1 || span <= 0) return MARGIN.left + plotWidth
    return MARGIN.left + ((ts - t0) / span) * plotWidth
  }
  const yOf = (value: number): number => {
    const ratio = clamp(value / yMax, 0, 1)
    return MARGIN.top + (1 - ratio) * plotHeight
  }

  const paths = useMemo(
    () =>
      series.map((item) => {
        const points = item.values.map(
          (value, index) => [xOf(samples[index]?.ts ?? t0), yOf(value)] as [number, number]
        )
        const line = linePath(points)
        const area =
          points.length > 1
            ? `${line} L${points[points.length - 1][0].toFixed(1)},${(MARGIN.top + plotHeight).toFixed(1)} L${points[0][0].toFixed(1)},${(MARGIN.top + plotHeight).toFixed(1)} Z`
            : ''
        return { key: item.key, line, area }
      }),
    // Geometry only changes with the data, the width or the y domain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, samples, width, yMax]
  )

  const ticks = Array.from({ length: 5 }, (_, index) => (yMax * index) / 4)
  const axisFormat = formatAxis ?? format

  const nearestIndex = (px: number): number => {
    if (count === 0) return 0
    if (count === 1 || span <= 0) return count - 1
    const target = t0 + ((px - MARGIN.left) / Math.max(1, plotWidth)) * span
    let low = 0
    let high = count - 1
    while (low < high) {
      const mid = (low + high) >> 1
      if (samples[mid].ts < target) low = mid + 1
      else high = mid
    }
    if (low > 0 && Math.abs(samples[low - 1].ts - target) <= Math.abs(samples[low].ts - target)) {
      return low - 1
    }
    return low
  }

  const currentValues = series.map((item) => item.values.at(-1))
  const summary = series
    .map((item) => `${item.label} ${format(item.values.at(-1) ?? 0)}`)
    .join('，')

  const hoverX = hover !== null && samples[hover] ? xOf(samples[hover].ts) : 0

  return (
    <section className="rounded-xl border border-line-2 bg-panel-2/40 px-3 pb-2.5 pt-2.5">
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-medium text-ink">{title}</div>
          {hint && <div className="mt-0.5 truncate text-[10px] text-faint">{hint}</div>}
        </div>
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-dim transition hover:bg-panel-3 hover:text-ink"
          aria-pressed={view === 'table'}
          onClick={() => setView((value) => (value === 'chart' ? 'table' : 'chart'))}
        >
          {view === 'chart' ? <Table2 size={11} /> : <LineChartIcon size={11} />}
          {view === 'chart' ? '表格' : '图表'}
        </button>
      </header>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
        {series.map((item, index) => (
          <span key={item.key} className="flex items-center gap-1.5">
            <span
              className="h-[2px] w-3 rounded-full"
              style={{ background: item.color }}
              aria-hidden="true"
            />
            <span className="text-dim">{item.label}</span>
            <span className="tabular-nums text-ink">{format(currentValues[index] ?? 0)}</span>
          </span>
        ))}
      </div>

      {view === 'table' ? (
        <div className="mt-2 max-h-[176px] overflow-auto rounded-lg border border-line">
          {count === 0 ? (
            <div className="flex h-[176px] items-center justify-center text-[10px] text-faint">
              {emptyText}
            </div>
          ) : (
            <table className="w-full border-collapse text-[10px] tabular-nums">
              <thead className="sticky top-0 bg-panel-2 text-faint">
                <tr>
                  <th className="px-2 py-1 text-left font-medium">时间</th>
                  {series.map((item) => (
                    <th key={item.key} className="px-2 py-1 text-right font-medium">
                      {item.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {samples
                  .map((sample, index) => ({ sample, index }))
                  .slice(-TABLE_ROWS)
                  .reverse()
                  .map(({ sample, index }) => (
                    <tr key={sample.ts} className="border-t border-line/60">
                      <td className="px-2 py-1 text-dim">{formatClock(sample.ts)}</td>
                      {series.map((item) => (
                        <td key={item.key} className="px-2 py-1 text-right text-ink">
                          {format(item.values[index] ?? 0)}
                        </td>
                      ))}
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        <div ref={wrapRef} className="relative mt-1 h-[176px] w-full">
          {count === 0 ? (
            <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-line-2 text-[10px] text-faint">
              {emptyText}
            </div>
          ) : width > 0 ? (
            <>
              <svg
                width={width}
                height={HEIGHT}
                role="img"
                aria-label={`${title}：${summary}`}
                tabIndex={0}
                className="block rounded outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                onPointerMove={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  setHover(nearestIndex(event.clientX - rect.left))
                }}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(count - 1)}
                onBlur={() => setHover(null)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    event.preventDefault()
                    setHover((previous) => {
                      const base = previous ?? count - 1
                      const next = base + (event.key === 'ArrowLeft' ? -1 : 1)
                      return Math.min(count - 1, Math.max(0, next))
                    })
                  } else if (event.key === 'Escape') {
                    setHover(null)
                  }
                }}
              >
                {ticks.map((tick) => {
                  const y = yOf(tick)
                  return (
                    <g key={tick}>
                      <line
                        x1={MARGIN.left}
                        x2={MARGIN.left + plotWidth}
                        y1={y}
                        y2={y}
                        stroke="var(--color-line)"
                        strokeWidth={1}
                      />
                      <text
                        x={MARGIN.left - 6}
                        y={y + 3}
                        textAnchor="end"
                        fontSize={9}
                        fill="var(--color-faint)"
                      >
                        {axisFormat(tick)}
                      </text>
                    </g>
                  )
                })}

                {count > 0 &&
                  span > 0 &&
                  [0, 0.5, 1].map((ratio) => {
                    const ts = t0 + span * ratio
                    return (
                      <text
                        key={ratio}
                        x={MARGIN.left + plotWidth * ratio}
                        y={HEIGHT - 4}
                        textAnchor={ratio === 0 ? 'start' : ratio === 1 ? 'end' : 'middle'}
                        fontSize={9}
                        fill="var(--color-faint)"
                      >
                        {formatClock(ts)}
                      </text>
                    )
                  })}

                {paths.map((path, index) =>
                  path.area ? (
                    <path
                      key={`area-${path.key}`}
                      d={path.area}
                      fill={series[index].color}
                      fillOpacity={0.1}
                      stroke="none"
                    />
                  ) : null
                )}
                {paths.map((path, index) => (
                  <path
                    key={`line-${path.key}`}
                    d={path.line}
                    fill="none"
                    stroke={series[index].color}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ))}

                {count === 1 && (
                  <circle
                    cx={xOf(samples[0].ts)}
                    cy={yOf(series[0]?.values[0] ?? 0)}
                    r={3}
                    fill={series[0]?.color ?? 'var(--color-accent)'}
                  />
                )}

                {hover !== null && samples[hover] && (
                  <g pointerEvents="none">
                    <line
                      x1={hoverX}
                      x2={hoverX}
                      y1={MARGIN.top}
                      y2={MARGIN.top + plotHeight}
                      stroke="var(--color-line-2)"
                      strokeWidth={1}
                    />
                    {series.map((item) => (
                      <circle
                        key={item.key}
                        cx={hoverX}
                        cy={yOf(item.values[hover] ?? 0)}
                        r={4}
                        fill={item.color}
                        stroke="var(--color-panel)"
                        strokeWidth={2}
                      />
                    ))}
                  </g>
                )}
              </svg>

              {hover !== null && samples[hover] && (
                <div
                  className="pointer-events-none absolute top-1 z-10 min-w-[104px] -translate-x-1/2 rounded-lg border border-line-2 bg-panel px-2.5 py-1.5 text-[10px] shadow-xl"
                  style={{ left: clamp(hoverX, 66, Math.max(66, width - 66)) }}
                >
                  <div className="mb-1 tabular-nums text-faint">{formatClock(samples[hover].ts)}</div>
                  {series.map((item) => (
                    <div key={item.key} className="flex items-center gap-1.5">
                      <span
                        className="h-[2px] w-2.5 rounded-full"
                        style={{ background: item.color }}
                        aria-hidden="true"
                      />
                      <span className="text-dim">{item.label}</span>
                      <span className="ml-auto pl-2 tabular-nums text-ink">
                        {format(item.values[hover] ?? 0)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="h-full" />
          )}
        </div>
      )}
    </section>
  )
}
