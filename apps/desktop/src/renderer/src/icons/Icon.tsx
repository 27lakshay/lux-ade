import { LucideProvider } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { icons, type IconName } from './icons'

// The one way to draw an icon. Sizes are the four in the Pen components; colour comes from the
// surrounding text unless `tone` says otherwise.

/** The icon scale: 12, 14, 16 and 18px. The same four are Pen's icon-xs … icon-lg variables. */
const SIZES = { xs: 'size-3', sm: 'size-3.5', md: 'size-4', lg: 'size-4.5' } as const

/** Emphasis only. Status colours belong to the Status component. */
const TONES = { default: 'text-foreground', muted: 'text-muted-foreground' } as const

/** Stroke width in screen pixels at every size (lucide's default is about 1.33px at 16px). */
const STROKE = 1.25

type IconProps = Omit<ComponentProps<'svg'>, 'children' | 'ref'> & {
  name: IconName
  /** Leave unset inside kit components: the kit sizes its own icons. Elsewhere the default is md. */
  size?: keyof typeof SIZES
  tone?: keyof typeof TONES
  /** For an icon that carries meaning on its own. Icons without one are hidden from screen readers. */
  label?: string
}

export function Icon({ name, size, tone, label, className, ...props }: IconProps) {
  const Glyph = icons[name]
  const a11y = label ? { 'aria-label': label, role: 'img' } : {}
  return <Glyph {...props} {...a11y} className={cn('shrink-0', size && SIZES[size], tone && TONES[tone], className)} />
}

/** Every icon's defaults, the kit's included: 16px unless a class sizes it, and a fixed stroke. */
export function IconProvider({ children }: { children: ReactNode }) {
  return (
    <LucideProvider size={16} strokeWidth={STROKE} nonScalingStroke>
      {children}
    </LucideProvider>
  )
}
