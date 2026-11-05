import { useId } from 'react'

interface LinkLogoProps {
  className?: string
}

/**
 * Hand-drawn "LINK" wordmark: two interlocking rings followed by monoline
 * letters.  Letters inherit `currentColor`; the rings use the theme accent
 * gradient declared in styles.css.
 */
export function LinkLogo({ className }: LinkLogoProps) {
  const rawId = useId()
  const id = rawId.replace(/[^a-zA-Z0-9_-]/g, '')
  const gradientId = `link-logo-grad-${id}`
  const maskId = `link-logo-mask-${id}`

  return (
    <svg
      viewBox="0 0 232 72"
      fill="none"
      role="img"
      aria-label="LINK"
      className={className}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--logo-from)' }} />
          <stop offset="1" style={{ stopColor: 'var(--logo-to)' }} />
        </linearGradient>
        <mask id={maskId}>
          <rect x="-20" y="-20" width="272" height="112" fill="#fff" />
          <ellipse
            cx="15"
            cy="36"
            rx="9"
            ry="6.5"
            fill="none"
            stroke="#000"
            strokeWidth="9"
          />
        </mask>
      </defs>

      {/* chain badge: the right ring passes behind the left one */}
      <ellipse
        cx="27"
        cy="36"
        rx="9"
        ry="6.5"
        stroke={`url(#${gradientId})`}
        strokeWidth="4.6"
        mask={`url(#${maskId})`}
      />
      <ellipse
        cx="15"
        cy="36"
        rx="9"
        ry="6.5"
        stroke={`url(#${gradientId})`}
        strokeWidth="4.6"
      />

      <g
        stroke="currentColor"
        strokeWidth="7.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M66 16 V56 H94" />
        <path d="M111 16 V56" />
        <path d="M128 56 V16 L158 56 V16" />
        <path d="M175 16 V56" />
        <path d="M202 16 L175 40 L202 56" />
      </g>
    </svg>
  )
}
