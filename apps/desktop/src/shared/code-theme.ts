const CODE_THEME_ROLES = {
  default: 'syntax-default',
  keyword: 'syntax-keyword',
  string: 'syntax-string',
  number: 'syntax-number',
  comment: 'syntax-comment',
  background: 'base',
  selection: 'accent',
  'selection-foreground': 'accent-foreground',
  gutter: 'muted-foreground',
  'active-line': 'panel',
  search: 'attention-muted',
  error: 'destructive',
  warning: 'attention',
  info: 'info',
  'info-background': 'info-muted',
  added: 'diff-add',
  removed: 'diff-remove',
  'added-background': 'diff-add-muted',
  'removed-background': 'diff-remove-muted',
} as const

/** Stable CSS variables shared by live rendering and the blocking startup snapshot. */
export function codeThemeVariables(tokens: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(CODE_THEME_ROLES).map(([role, token]) => [`--ade-code-${role}`, tokens[token] ?? `var(--${token})`]),
  )
}
