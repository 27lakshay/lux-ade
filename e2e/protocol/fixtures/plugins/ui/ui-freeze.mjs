// Desktop E2E fixture UI entry point that hangs its renderer: its composer transform never returns
// once the saved draft mentions "freeze". Recovery is Electron main's job, not this code's.
export default function activate(api) {
  api.registerComposerTransform('e2e.ui.snippet', (input) => {
    if (input.text.includes('freeze')) for (;;);
    return { text: input.text, context_nodes: input.context_nodes }
  })
}
