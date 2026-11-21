import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** Minimal Nimi DSH sidebar and empty-hero geometric mark. */
export function NimiBrandMark({ size = 20, className }: SidebarBrandMarkOwnerProps & { className?: string | undefined }) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <rect x="2" y="2" width="20" height="20" rx="6" fill="var(--dsw-alias-accent-primary, #2563eb)" />
      <path
        d="M7.5 16.5V7.5L16.5 16.5V7.5"
        stroke="#ffffff"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

const PRODUCT_WORDMARK = 'Nimi DSH'

/** Nimi DSH sidebar wordmark replacing upstream branding in managed mode. */
export function NimiBrandName() {
  return (
    <span
      style={{
        fontWeight: 600,
        fontSize: '15px',
        lineHeight: '20px',
        letterSpacing: '-0.01em',
        color: 'var(--dsw-alias-label-primary)',
      }}
    >
      {PRODUCT_WORDMARK}
    </span>
  )
}
