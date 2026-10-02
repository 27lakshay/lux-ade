// Desktop E2E fixture UI entry point. It renders `e2e.ui.card` messages as a card, throwing for a
// payload that asks it to, and prepares prompts: `:today:` becomes a fixed date and each
// `e2e.ui.snippet` context node becomes a labelled block.
export default function activate(api) {
  const h = api.React.createElement
  api.registerTimelineRenderer('e2e.ui.card', function CheckCard({ item }) {
    if (item.data?.fail) throw new Error('fixture renderer failure')
    return h(
      'div',
      { role: 'group', 'aria-label': 'Check card' },
      `${item.data?.title ?? 'Checks'}: ${item.data?.passed ?? 0} passed`,
    )
  })
  api.registerComposerTransform('e2e.ui.snippet', (input) => {
    const snippets = input.context_nodes
      .filter((node) => node.kind === 'e2e.ui.snippet')
      .map((node) => `[snippet ${node.data.label}]\n${node.data.text}`)
    return {
      text: [input.text.replaceAll(':today:', '2026-10-02'), ...snippets].join('\n\n'),
      context_nodes: input.context_nodes,
    }
  })
}
