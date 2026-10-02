export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@anthropic-ai/claude-agent-sdk')
    return { url: new URL('./worker-test-sdk.mjs', import.meta.url).href, shortCircuit: true }
  return nextResolve(specifier, context)
}
