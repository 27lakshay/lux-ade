// Main prefixes this blocking resource with the current profile snapshot on every load.
var appearance = globalThis.adeStartupAppearance
var dark = appearance ? appearance.mode === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
if (appearance) {
  for (var role in appearance.tokens) document.documentElement.style.setProperty('--' + role, appearance.tokens[role])
  for (var variable in appearance.codeVariables)
    document.documentElement.style.setProperty(variable, appearance.codeVariables[variable])
  document.documentElement.dataset.appearancePreference = appearance.preference
}
document.documentElement.classList.toggle('dark', dark)
document.documentElement.style.colorScheme = dark ? 'dark' : 'light'

document.documentElement.style.backgroundColor = 'var(--background)'
performance.mark('ade:appearance-ready', {
  detail: {
    mode: dark ? 'dark' : 'light',
    background: appearance && appearance.tokens.background,
    codeKeyword: appearance && appearance.codeVariables['--ade-code-keyword'],
  },
})
