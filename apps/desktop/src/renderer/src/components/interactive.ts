// The one look for interactive surfaces ADE draws itself (rows, tabs, strip controls), matching the
// kit's ghost buttons: hover lifts to the next fill step, selected and pressed use accent, keyboard
// focus draws a full-strength ring inside the element (so lists never clip it), disabled fades.
// Mark selection with data-selected; the kit's own controls keep their stock states.
export const interactive =
  'outline-none select-none cursor-default transition-colors duration-100 hover:bg-muted dark:hover:bg-muted/50 active:bg-accent data-[selected]:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50'
