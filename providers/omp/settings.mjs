// Settings discovery for Oh My Pi 18.3 RPC (`src/modes/rpc/rpc-types.ts`).
//
// `get_available_models` returns `{ models: Model[] }`; the `--model` launch argument takes
// `provider/id`. `get_available_thinking_levels` returns the levels of the live model only,
// so only that model lists them. `get_state` names the model and thinking level in effect.
// OMP has no permission modes to report.

const MAX_MODELS = 512
const DISCOVERY_TIMEOUT_MS = 10_000
const TRANSPORT_TIMEOUT_MS = 120_000

const modelId = (model) =>
  typeof model?.provider === 'string' && typeof model?.id === 'string' && model.provider && model.id
    ? `${model.provider}/${model.id}`
    : null

/** What `get_state` names in effect; a value it leaves out stays null. */
export function stateSettings(state) {
  return {
    model: modelId(state?.model),
    reasoning_effort: typeof state?.thinkingLevel === 'string' ? state.thinkingLevel : null,
    permission_mode: null,
  }
}

/** The models OMP lists, in ADE's `NativeChoices` shape, or null when it lists none usable. */
export function nativeChoices(models, current, levels) {
  if (!Array.isArray(models) || models.length === 0 || models.length > MAX_MODELS) return null
  const listed = []
  for (const model of models) {
    const id = modelId(model)
    if (!id) return null
    listed.push({
      id,
      display_name: typeof model.name === 'string' ? model.name : null,
      is_default: false,
      aliases: [],
      reasoning_efforts: id === current && Array.isArray(levels) ? levels.filter((l) => typeof l === 'string') : null,
      default_reasoning_effort: null,
      permission_modes: null,
    })
  }
  return { source: 'get_available_models', models: listed }
}

/**
 * Asks the open OMP process; a refused or slow discovery reports no choices. The transport
 * fails the whole process when a request outlives its own timeout, so ADE stops waiting
 * well before that and lets a late reply settle unused.
 */
export async function discover(transport, state) {
  const ask = (type) => {
    const reply = transport.request(type, {}, { timeout: TRANSPORT_TIMEOUT_MS })
    reply.catch(() => {})
    let timer
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), DISCOVERY_TIMEOUT_MS)
    })
    return Promise.race([reply, late]).finally(() => clearTimeout(timer))
  }
  try {
    const models = await ask('get_available_models')
    const levels = models && (await ask('get_available_thinking_levels'))
    return nativeChoices(models?.models, modelId(state?.model), levels?.levels)
  } catch {
    return null
  }
}
