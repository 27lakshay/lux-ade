// Desktop E2E fixture backend: the command behind the check card's "Recheck" action. It returns
// the arguments it received, so a spec can see which conversation and message the action named.
export function activate(ctx) {
  ctx.commands.register('e2e.ui.recheck', (args, meta) => ({ args, generation: meta.generation }))
}

export function deactivate() {}
