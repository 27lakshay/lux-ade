import type { ComponentProps, ElementType } from 'react'
import { cn } from '@/lib/utils'

// ADE's text. Each component fixes a step of the type scale in shadcn.css (size, line height,
// default weight), so text looks the same wherever it appears. Lint refuses size, weight,
// line-height and font-mono classes everywhere else, and raw <p> and <h1>–<h6>: render text
// through these. `className` is for placement (margins, alignment, layout), not for looks.

/** `inherit` follows the parent, for text inside a link or button whose colour changes on hover. */
const TONES = { default: 'text-foreground', muted: 'text-muted-foreground', inherit: '' } as const
const WEIGHTS = { regular: 'font-normal', medium: 'font-medium', semibold: 'font-semibold' } as const
const LINES = { 2: 'line-clamp-2', 3: 'line-clamp-3', 4: 'line-clamp-4' } as const
/** An invisible, zero-height copy of the text at a weight, which holds the element at that width. */
const STEADY = {
  regular: 'after:font-normal',
  medium: 'after:font-medium',
  semibold: 'after:font-semibold',
} as const
const STEADY_BASE = 'after:invisible after:block after:h-0 after:overflow-hidden after:content-[attr(data-text)]'

type Tone = keyof typeof TONES
type Weight = keyof typeof WEIGHTS

type TextProps<Tag extends ElementType> = Omit<ComponentProps<'span'>, 'color'> & {
  /** The element to render; each component has a sensible default. */
  as?: Tag
  tone?: Tone
  weight?: Weight
  /** Cut to one line with an ellipsis; the element needs a width to cut at. */
  truncate?: boolean
  /** Cut after this many lines. */
  lines?: keyof typeof LINES
  /** Tabular figures, so counts, timers and percentages do not shift as they change. */
  numeric?: boolean
  /**
   * Keep the width this text has at the given weight, so switching to it (a selected tab turning
   * medium) does not move what sits beside it. The text must be a plain string.
   */
  steadyWidth?: Weight
  /**
   * Whether the text can be selected. Chrome text (labels, rows, titles) cannot, as in a native
   * app; content people may copy (messages, code) can.
   */
  selectable?: boolean
}

type Style<Default extends ElementType> = {
  size: string
  element: Default
  tone: Tone
  weight: Weight
  selectable: boolean
}

function textComponent<Default extends ElementType, Tags extends ElementType>(name: string, style: Style<Default>) {
  function TypographyText({
    as,
    tone = style.tone,
    weight = style.weight,
    truncate,
    lines,
    numeric,
    steadyWidth,
    selectable = style.selectable,
    className,
    ...props
  }: TextProps<Default | Tags>) {
    const steadyText = steadyWidth && typeof props.children === 'string' ? props.children : undefined
    const Element: ElementType = as ?? style.element
    return (
      <Element
        {...props}
        data-text={steadyText}
        // The size stays outside cn(): tailwind-merge reads text-title as a colour and would drop it
        // beside the tone. Lint keeps size classes out of className, so nothing can conflict.
        className={`${style.size} ${cn(
          TONES[tone],
          WEIGHTS[weight],
          selectable ? 'select-text' : 'select-none',
          truncate && 'truncate',
          lines && LINES[lines],
          numeric && 'tabular-nums',
          steadyText !== undefined && [STEADY_BASE, STEADY[steadyWidth!]],
          className,
        )}`}
      />
    )
  }
  TypographyText.displayName = name
  return TypographyText
}

const HEADINGS = { page: 'text-page', display: 'text-display' } as const

/** 20px (`page`, full-screen view titles) or 28px (`display`, onboarding), semibold. */
export function Heading({ level = 'page', ...props }: TextProps<'h1' | 'h2'> & { level?: keyof typeof HEADINGS }) {
  const Component = level === 'display' ? Display : Page
  return <Component {...props} />
}

const Page = textComponent<'h1', 'h2'>('Heading', {
  size: HEADINGS.page,
  element: 'h1',
  tone: 'default',
  weight: 'semibold',
  selectable: false,
})

const Display = textComponent<'h1', 'h2'>('Heading', {
  size: HEADINGS.display,
  element: 'h1',
  tone: 'default',
  weight: 'semibold',
  selectable: false,
})

/** 15px semibold. Dialog and pane titles. */
export const Title = textComponent<'h2', 'h1' | 'h3' | 'h4' | 'div'>('Title', {
  size: 'text-title',
  element: 'h2',
  tone: 'default',
  weight: 'semibold',
  selectable: false,
})

/** 14px. Messages and text people read or type. Selectable. */
export const Body = textComponent<'p', 'span' | 'div'>('Body', {
  size: 'text-body',
  element: 'p',
  tone: 'default',
  weight: 'regular',
  selectable: true,
})

/** 13px. Rows, buttons, menus: the default for text in controls. */
export const Text = textComponent<'span', 'p' | 'div' | 'label'>('Text', {
  size: 'text-ui',
  element: 'span',
  tone: 'default',
  weight: 'regular',
  selectable: false,
})

/** 12px. Tabs and section labels. */
export const Caption = textComponent<'span', 'p' | 'div' | 'h3' | 'h4'>('Caption', {
  size: 'text-caption',
  element: 'span',
  tone: 'default',
  weight: 'regular',
  selectable: false,
})

/** 11px, muted. Status bar, times, counts. */
export const Meta = textComponent<'span', 'p' | 'time'>('Meta', {
  size: 'text-meta',
  element: 'span',
  tone: 'muted',
  weight: 'regular',
  selectable: false,
})

const CodeBlock = textComponent<'code', 'span' | 'kbd' | 'samp'>('Code', {
  size: 'text-code font-mono',
  element: 'code',
  tone: 'default',
  weight: 'regular',
  selectable: true,
})

// Monospace looks larger than Inter at the same size, so inline code sits slightly smaller than
// the text around it.
const CodeInline = textComponent<'code', 'span' | 'kbd' | 'samp'>('Code', {
  size: 'text-[0.92em] font-mono',
  element: 'code',
  tone: 'default',
  weight: 'regular',
  selectable: true,
})

/**
 * 12px monospace: code, paths, commands. `size="inline"` sizes it to the surrounding text, for code
 * inside a <Body> or <Text>.
 */
export function Code({
  size = 'caption',
  ...props
}: TextProps<'code' | 'span' | 'kbd' | 'samp'> & { size?: 'caption' | 'inline' }) {
  return size === 'inline' ? <CodeInline {...props} /> : <CodeBlock {...props} />
}
