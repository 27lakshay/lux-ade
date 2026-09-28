// The handle on a card's bottom edge. Dragging it moves the card: a pane anywhere in the centre, a
// sidebar to the other side. The row is 12px, on the grid, and lines the footers up.
export function Grip({
  label,
  ref,
  onDoubleClick,
}: {
  label: string
  ref?: React.Ref<HTMLDivElement>
  /** Panes: maximize or restore. */
  onDoubleClick?: () => void
}) {
  return (
    <div ref={ref} onDoubleClick={onDoubleClick} className="flex h-3 shrink-0 cursor-grab items-center justify-center">
      <span role="img" aria-label={label} className="h-1 w-8 rounded-full bg-muted" />
    </div>
  )
}
