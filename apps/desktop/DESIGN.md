# Desktop design system

Read this when changing a desktop surface, theme, typography, icon, component or animation.
Paths are relative to `apps/desktop/src/renderer/src` unless stated otherwise.

Visual design is approved in Pen. Build an approved surface to its frame. Build a surface without
an approved design from the stock shadcn kit under `provisional/`. The kit files in
`components/ui` remain stock; compose product components around them. `shadcn.css` contains
Graphite colours and the type scale. Surfaces separate by fill, with the chrome behind floating
cards and pane content. Change palette values in the theme rather than restyling kit components.

Use `components/Typography.tsx` for headings, body text, labels and code. Use `components/Row`
for one-line clickable lists, `IconButton` for labelled icon actions and `Status` for attention
marks. `icons/Icon.tsx` is the product icon entry point. The theme and typography tests check
contrast and motion token consistency; lint rules reject raw text sizing, unapproved spacing,
raw colours, restyled kit components and vague button labels. Consult the components and lint
rules for their exact values instead of copying values into this page.

Use CSS transitions for hover, press, focus and colour. Use Motion's `m` elements and presets in
`app/motion.ts` for structural moves such as card swaps or tab reorder. `app/MotionProvider.tsx`
applies reduced-motion settings. Keep layout animation keyed to structure rather than resizing;
terminals and canvas content move without scaling. Dragging uses Pragmatic drag and drop; Motion
animates the settle. Scrollable UI uses the kit's `ScrollArea`.

Use [UI copy](../../docs/agents/ui-copy.md) for wording and `CONTEXT.md` for resource names.
For a UI change, run renderer tests, then inspect the real app through
[desktop debugging](../../docs/agents/desktop-debugging.md). Check keyboard focus, pointer
release, selected-tab width and reduced motion as applicable.
