import type { ComponentProps, ElementType } from 'react'
import { cn } from '@/lib/utils'

// ADE's text. Each component fixes a size, line height and default weight from the type scale in
// shadcn.css, so text looks the same wherever it appears. Lint refuses size, weight, line-height
// and font-mono classes everywhere else: render text through these. `className` is for placement
// (margins, alignment, layout), not for how the text looks.

/** `inherit` follows the parent, for text inside a link or button whose colour changes on hover. */
const TONES = { default: 'text-foreground', muted: 'text-muted-foreground', inherit: '' } as const
const WEIGHTS = { regular: 'font-normal', medium: 'font-medium', semibold: 'font-semibold' } as const

type Tone = keyof typeof TONES
type Weight = keyof typeof WEIGHTS

type TextProps<Tag extends ElementType> = Omit<ComponentProps<'span'>, 'color'> & {
  /** The element to render; each component has a sensible default. */
  as?: Tag
  tone?: Tone
  /** Cut to one line with an ellipsis; the element must have a width to cut at. */
  truncate?: boolean
}

function textComponent<Default extends ElementType, Tags extends ElementType>(
  name: string,
  style: { size: string; element: Default; tone: Tone; weight: Weight; weights?: readonly Weight[] },
) {
  function TypographyText({
    as,
    tone = style.tone,
    weight = style.weight,
    truncate,
    className,
    ...props
  }: TextProps<Default | Tags> & { weight?: Weight }) {
    const Element: ElementType = as ?? style.element
    return (
      <Element
        {...props}
        // The size stays outside cn(): tailwind-merge reads text-title as a colour and would drop it
        // beside the tone. Lint keeps size classes out of className, so nothing can conflict.
        className={`${style.size} ${cn(TONES[tone], WEIGHTS[weight], truncate && 'truncate', className)}`}
      />
    )
  }
  TypographyText.displayName = name
  return TypographyText
}

/** 15px semibold. Dialog and pane titles. */
export const Title = textComponent<'h2', 'h1' | 'h3' | 'h4' | 'div'>('Title', {
  size: 'text-title',
  element: 'h2',
  tone: 'default',
  weight: 'semibold',
})

/** 14px. Messages and text people read or type. */
export const Body = textComponent<'p', 'span' | 'div'>('Body', {
  size: 'text-body',
  element: 'p',
  tone: 'default',
  weight: 'regular',
})

/** 13px. Rows, buttons, menus: the default for text in controls. */
export const Text = textComponent<'span', 'p' | 'div' | 'label'>('Text', {
  size: 'text-ui',
  element: 'span',
  tone: 'default',
  weight: 'regular',
})

/** 12px. Tabs and section labels. */
export const Caption = textComponent<'span', 'p' | 'div' | 'h3' | 'h4'>('Caption', {
  size: 'text-caption',
  element: 'span',
  tone: 'default',
  weight: 'regular',
})

/** 11px, muted. Status bar, times, counts. */
export const Meta = textComponent<'span', 'p' | 'time'>('Meta', {
  size: 'text-meta',
  element: 'span',
  tone: 'muted',
  weight: 'regular',
})

/** 12px monospace. Inline code, paths, commands. */
export const Code = textComponent<'code', 'span' | 'kbd' | 'samp'>('Code', {
  size: 'text-caption font-mono',
  element: 'code',
  tone: 'default',
  weight: 'regular',
})
