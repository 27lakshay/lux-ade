import type { ReactNode } from 'react'

export function IconButton(props: {
  label: string
  onClick?: () => void
  children: ReactNode
  className?: string
  // For toggles: announces on/off state to assistive tech.
  pressed?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      aria-pressed={props.pressed}
      title={props.label}
      onClick={props.onClick}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors duration-100 hover:bg-panel hover:text-fg ${props.className ?? ''}`}
    >
      {props.children}
    </button>
  )
}
