// Runs before the first paint (a blocking script in index.html's head), so a dark window never
// flashes light while the app loads. It mirrors src/app/theme.ts, which takes over at startup; keep
// the storage key and the rule the same in both.
try {
  var theme = localStorage.getItem('ade.theme')
  var dark = theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
} catch {
  // Storage unavailable: the app applies the theme when it starts.
}
