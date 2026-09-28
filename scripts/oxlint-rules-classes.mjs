// ADE's rules about Tailwind classes: type, fills, spacing, radius and scrolling. Each rule reads
// every class a file sets, however it is built: a JSX className, or a cn(), cva(), clsx() or cx()
// call anywhere (cva variant tables included). Cases live in oxlint-plugin-ade.test.mjs.

const CLASS_CALLS = new Set(['cn', 'cva', 'clsx', 'cx', 'twMerge'])

// Every string literal inside an expression: "a b", `a ${x}`, cn('a', cond && 'b'), { v: 'c' }.
function stringsIn(node) {
  if (!node) return []
  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'string' ? [node.value] : []
    case 'TemplateLiteral':
      return node.quasis.map((quasi) => quasi.value.cooked ?? '')
    case 'JSXExpressionContainer':
      return stringsIn(node.expression)
    case 'CallExpression':
      return node.arguments.flatMap(stringsIn)
    case 'LogicalExpression':
    case 'BinaryExpression':
      return [...stringsIn(node.left), ...stringsIn(node.right)]
    case 'ConditionalExpression':
      return [...stringsIn(node.consequent), ...stringsIn(node.alternate)]
    case 'ArrayExpression':
      return node.elements.flatMap(stringsIn)
    case 'ObjectExpression':
      return node.properties.flatMap((property) => (property.type === 'Property' ? stringsIn(property.value) : []))
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
      return stringsIn(node.expression)
    default:
      return []
  }
}

const isClassCall = (node) =>
  node.type === 'CallExpression' && node.callee.type === 'Identifier' && CLASS_CALLS.has(node.callee.name)
const isClassName = (node) =>
  node.type === 'JSXAttribute' && node.name.type === 'JSXIdentifier' && node.name.name === 'className'

// A class call inside a className or inside another class call is read with its parent, once.
function nestedInClassSource(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (isClassName(parent) || isClassCall(parent)) return true
  }
  return false
}

// 'hover:!bg-muted/50' → 'bg-muted'
export const utility = (name) =>
  name
    .replace(/^!/, '')
    .split(':')
    .at(-1)
    .replace(/^!/, '')
    .replace(/^-/, '')
    .replace(/\/[\w.[\]]+$/, '')

/** A rule that checks each class; `check` returns a message for a class it refuses. */
function classRule(description, check) {
  return {
    meta: { type: 'problem', docs: { description } },
    create(context) {
      const inspect = (node, source) => {
        for (const name of stringsIn(source)
          .flatMap((value) => value.split(/\s+/))
          .filter(Boolean)) {
          const message = check(utility(name), name)
          if (message) {
            context.report({ node, message })
            return
          }
        }
      }
      return {
        JSXAttribute(node) {
          if (isClassName(node)) inspect(node, node.value)
        },
        CallExpression(node) {
          if (isClassCall(node) && !nestedInClassSource(node)) inspect(node, node)
        },
      }
    },
  }
}

// Size, weight, line height and the mono face belong to components/Typography.tsx.
const TYPE_CLASS =
  /^(text-(xs|sm|base|lg|xl|[2-9]xl|meta|caption|ui|body|title|page|display|\[[^\]]*\])|font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black|mono)|leading-.+)$/

const typeScale = classRule('Text is rendered through the typography components.', (base, name) =>
  TYPE_CLASS.test(base)
    ? `"${name}": render text with <Heading>, <Title>, <Body>, <Text>, <Caption>, <Meta> or <Code> from components/Typography.tsx, which set size, weight and line height. Use their tone, weight and truncate props.`
    : null,
)

// The fill steps, darkest to lightest, plus the colours that mark status and diffs.
const SURFACES = new Set([
  'sidebar',
  'background',
  'card',
  'popover',
  'muted',
  'accent',
  'secondary',
  'primary',
  'destructive',
  'transparent',
  'current',
  'terminal',
  'attention',
  'attention-muted',
  'running',
  'success',
  'destructive-muted',
  'diff-add',
  'diff-add-muted',
  'diff-remove',
  'diff-remove-muted',
])
const BORDER = /^(border|divide)(-|$)/
const BORDER_OFF = new Set(['border-0', 'border-none', 'border-transparent', 'border-hidden'])

const surfaceSteps = classRule('Surfaces separate by fill steps, not borders or ad hoc colours.', (base, name) => {
  if (BORDER.test(base) && !BORDER_OFF.has(base))
    return `"${name}": ADE separates surfaces by fill, not borders. Put the element on the next fill step (bg-card inside a pane, bg-popover for floating) instead.`
  const fill = /^bg-(.+)$/.exec(base)?.[1]
  if (fill && !SURFACES.has(fill))
    return `"${name}" is not a fill step. Use bg-sidebar, bg-background, bg-card, bg-popover, bg-muted or bg-accent (darkest to lightest), or a status colour.`
  return null
})

// Padding, margin, gap and space on the 4px grid: 2, 4, 6, 8, 12, 16, 24, 32, and 40, 48, 64 for
// page layout. `px`, `0` and `auto` are always fine.
const SPACING = /^(p[xytrblse]?|m[xytrblse]?|gap(-[xy])?|space-[xy])-(.+)$/
const SPACING_STEPS = new Set(['0', 'px', '0.5', '1', '1.5', '2', '3', '4', '6', '8', '10', '12', '16', 'auto'])

const spacingGrid = classRule('Spacing stays on the 4px grid.', (base, name) => {
  const step = SPACING.exec(base)?.[3]
  if (step === undefined || SPACING_STEPS.has(step) || step.startsWith('(')) return null
  return `"${name}" is off the spacing grid. Use steps 0.5, 1, 1.5, 2, 3, 4, 6 or 8 (2 to 32px), or 10, 12, 16 for page layout.`
})

// Heights come from the control sizes, not one-off pixel values.
const fixedHeights = classRule('Heights come from the control sizes.', (base, name) =>
  /^(min-|max-)?h-\[\d/.test(base) || /^size-\[\d/.test(base)
    ? `"${name}": use a control size (h-6 24px, h-7 28px, h-8 32px, h-10 40px) or a CSS variable such as h-(--titlebar-height).`
    : null,
)

// Radius steps: sm 6 (rows, chips), md 8 (blocks in a pane), lg 10 (kit controls), xl 14 (panes,
// popovers, dialogs), full. Nested corners are concentric: inner = outer − inset.
const RADIUS = /^rounded(-(t|r|b|l|s|e|tl|tr|br|bl|ss|se|es|ee))?(-(.+))?$/
const RADIUS_STEPS = new Set(['none', 'sm', 'md', 'lg', 'xl', 'full', 'inherit'])

const radiusSteps = classRule('Corners use the radius steps.', (base, name) => {
  const match = RADIUS.exec(base)
  if (!match) return null
  const step = match[4]
  if (step !== undefined && RADIUS_STEPS.has(step)) return null
  return `"${name}": use rounded-sm (6px), -md (8), -lg (10), -xl (14) or -full. A corner inside another is the outer radius minus the inset between them.`
})

// Everything that scrolls uses the kit's ScrollArea, so scrollbars look and behave the same.
const scrollArea = classRule('Scrolling goes through ScrollArea.', (base, name) =>
  /^overflow(-[xy])?-(auto|scroll)$/.test(base)
    ? `"${name}": wrap scrolling content in <ScrollArea> from components/ui/scroll-area instead.`
    : null,
)

// CSS motion uses the timing tokens: duration-100, -200, -300 and ease-standard (or linear), and never
// transition-all, which also animates layout properties.
const DURATIONS = new Set(['0', '100', '200', '300'])

const motionClasses = classRule('CSS transitions use the motion tokens.', (base, name) => {
  const duration = /^duration-(.+)$/.exec(base)?.[1]
  if (duration !== undefined && !DURATIONS.has(duration))
    return `"${name}": use duration-100 (fast), duration-200 (base) or duration-300 (slow), as in app/motion.ts.`
  const ease = /^ease-(.+)$/.exec(base)?.[1]
  if (ease !== undefined && ease !== 'standard' && ease !== 'linear')
    return `"${name}": use ease-standard (or ease-linear for loops).`
  if (base === 'transition-all')
    return `"${name}" also animates layout properties. Name what changes: transition-colors, transition-opacity or transition-transform.`
  return null
})

export const classRules = {
  'motion-classes': motionClasses,
  'type-scale': typeScale,
  'surface-steps': surfaceSteps,
  'spacing-grid': spacingGrid,
  'fixed-heights': fixedHeights,
  'radius-steps': radiusSteps,
  'scroll-area': scrollArea,
}
