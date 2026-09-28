export const GUTTER = 8
export const LEFT_W = 260
export const RIGHT_W = 360
// The icon-only rail at the window's left edge, before the left sidebar.
export const RAIL_W = 76
// Where the rail's card ends; the left sidebar (or the panes, with it hidden) start a gutter later.
export const RAIL_END = GUTTER + RAIL_W
// Native traffic lights (see src/main/index.ts): top-left at (16, 26), 14pt buttons 23pt apart on
// macOS 26, so they span 59pt, end at x = 75 and centre on y = 33: centred in the rail's top row.
// Measured from a screenshot, not an API.
const LIGHTS_CENTRE_Y = 33
// Every card's top strip is this tall, so with the card at y = GUTTER its controls centre on the lights.
export const STRIP_H = (LIGHTS_CENTRE_Y - GUTTER) * 2
// Title-bar toggles are fixed to the window, centred on the lights' row.
export const TOGGLE_SIZE = 28
export const TOGGLE_TOP = LIGHTS_CENTRE_Y - TOGGLE_SIZE / 2
// The sidebar toggle sits at the left end of the sidebar's top row, which starts 6pt into its card.
export const SIDEBAR_TOGGLE_X = RAIL_END + GUTTER + 6
// The side-panel toggle lines up with the right end of whichever card's strip is rightmost.
export const RIGHT_TOGGLE_INSET = GUTTER + 6
// Strips start at GUTTER + 6. With the sidebar closed, the chat strip reserves up to the toggle's
// right edge; the sidebar's own top row reserves the same span.
export const LEADING_SLOT = SIDEBAR_TOGGLE_X - RAIL_END - GUTTER - 6 + TOGGLE_SIZE
