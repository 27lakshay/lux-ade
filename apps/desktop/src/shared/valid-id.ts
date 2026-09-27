/** An ID the renderer may name: workspace, conversation, terminal or connection. */
export const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
