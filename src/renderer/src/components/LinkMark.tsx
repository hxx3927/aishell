import { useId } from 'react'

interface LinkMarkProps {
  className?: string
}

/**
 * App mark: the two interlocking rings from the LINK wordmark, rotated onto a
 * diagonal so the pair fills a square icon.  Drawn with `currentColor` so it
 * reads white on the accent-gradient tile.
 */
export function LinkMark({ className }: LinkMarkProps) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const maskId = `link-mark-mask-${id}`

  return (
    <svg viewBox="0 0 44 44" fill="none" aria-hidden="true" className={className}>
      <defs>
        <mask id={maskId}>
          <rect width="44" height="44" fill="#fff" />
          {/* bite out of the right ring so the left one passes in front */}
          <ellipse
            cx="15"
            cy="22"
            rx="9.5"
            ry="8"
            fill="none"
            stroke="#000"
            strokeWidth="5.8"
          />
        </mask>
      </defs>

      <g transform="rotate(-32 22 22)">
        <ellipse
          cx="29"
          cy="22"
          rx="9.5"
          ry="8"
          stroke="currentColor"
          strokeWidth="4.2"
          mask={`url(#${maskId})`}
        />
        <ellipse cx="15" cy="22" rx="9.5" ry="8" stroke="currentColor" strokeWidth="4.2" />
      </g>
    </svg>
  )
}
