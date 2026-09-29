// Runs before the first paint (a blocking script in index.html's head), so a dark window never
// flashes light while the app loads. Main applied the profile's saved appearance to macOS before the
// window opened (src/main/appearance.ts), and prefers-color-scheme follows it; src/app/theme.ts
// takes over once the daemon's setting arrives.
var dark = matchMedia('(prefers-color-scheme: dark)').matches
document.documentElement.classList.toggle('dark', dark)
document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
