// Which window this is. Main gives each window a stable name in its URL (`?window=main`), the same
// name Electron restores its size and position by; what the window saves for itself, such as its
// pane layout, is kept under that name, so each window keeps its own.
export const WINDOW_NAME = new URLSearchParams(window.location.search).get('window') ?? 'main'
