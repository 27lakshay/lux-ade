const statuses = { pending: 'pending', in_progress: 'inProgress', inProgress: 'inProgress', completed: 'completed', blocked: 'blocked', abandoned: 'abandoned' };

export function planItem(id, turn, todos, explanation = null) {
  if (!Array.isArray(todos) || todos.length > 256) throw new Error('Plan exceeds 256 steps or has invalid steps');
  const steps = todos.map(todo => {
    const step = todo.content, status = statuses[todo.status];
    if (typeof step !== 'string' || !step.trim() || Buffer.byteLength(step) > 4096 || typeof status !== 'string') throw new Error('Invalid plan step');
    return { step, status };
  });
  if (explanation !== null && (typeof explanation !== 'string' || Buffer.byteLength(explanation) > 16384)) throw new Error('Invalid plan explanation');
  return { id, client_id: null, turn, role: 'assistant', kind: 'plan', status: 'completed',
    text: steps.map(s => `${s.status}: ${s.step}`).join('\n'), content: { type: 'plan', explanation, steps } };
}

export function phasedTodos(phases) {
  if (!Array.isArray(phases) || phases.length > 256) throw new Error('Invalid plan phases');
  const todos = [];
  for (const phase of phases) {
    if (typeof phase.name !== 'string' || !Array.isArray(phase.tasks) || phase.tasks.length + todos.length > 256) throw new Error('Invalid plan phase');
    for (const task of phase.tasks) {
      if (typeof task.content !== 'string' || (task.blocker !== undefined && typeof task.blocker !== 'string')) throw new Error('Invalid phased task');
      todos.push({ content: `${phase.name ? phase.name + ': ' : ''}${task.content}${task.blocker ? ' — ' + task.blocker : ''}`, status: task.status });
    }
  }
  return todos;
}
