import { z } from 'zod'
import type { Layout, LayoutNode } from './layout'

// The saved layout's shape, checked on load: a layout from an older build or a damaged file falls
// back to the default rather than breaking the window.

const sidebar = z.enum(['navigator', 'inspector'])
const tab = z.object({
  id: z.string(),
  kind: z.enum(['conversation', 'terminal', 'browser', 'file', 'diff']),
  title: z.string(),
})
const pane = z.object({
  type: z.literal('pane'),
  id: z.string(),
  tabs: z.array(z.string()),
  active: z.string().nullable(),
})
const node: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([
    pane,
    z.object({
      type: z.literal('split'),
      id: z.string(),
      direction: z.enum(['row', 'column']),
      children: z.array(node).min(2),
      sizes: z.array(z.number()),
    }),
  ]),
)

const layout = z.object({
  version: z.literal(1),
  sidebars: z.tuple([sidebar, sidebar]),
  collapsed: z.object({ navigator: z.boolean(), inspector: z.boolean() }),
  widths: z.object({ navigator: z.number(), inspector: z.number() }),
  tabs: z.record(z.string(), tab),
  root: node,
  focusedPane: z.string(),
})

export const parseLayout = (value: unknown): Layout | null => {
  const result = layout.safeParse(value)
  return result.success && result.data.sidebars[0] !== result.data.sidebars[1] ? (result.data as Layout) : null
}
