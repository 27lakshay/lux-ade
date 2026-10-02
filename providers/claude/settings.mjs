// Settings discovery for the Claude Agent SDK 0.3.281 (`sdk.d.ts`).
//
// `initializationResult().models` is the `ModelInfo[]` that `Query.supportedModels()`
// returns: `value` is what the `model` option takes, `resolvedModel` the canonical ID an
// alias row resolves to, and `supportedEffortLevels` the `effort` values for that model
// (`supportsEffort: false` means none). The SDK reports no default flag beyond the
// `default` alias row, and no per-model permission modes.

const MAX_MODELS = 512

/** The models the SDK listed for this session, in ADE's `NativeChoices` shape, or null. */
export function nativeChoices(models) {
  if (!Array.isArray(models) || models.length > MAX_MODELS) return null
  const listed = []
  for (const model of models) {
    if (typeof model?.value !== 'string' || !model.value) return null
    const efforts =
      model.supportsEffort === false
        ? []
        : Array.isArray(model.supportedEffortLevels)
          ? model.supportedEffortLevels.filter((level) => typeof level === 'string')
          : null
    listed.push({
      id: model.value,
      display_name: typeof model.displayName === 'string' ? model.displayName : null,
      is_default: model.value === 'default',
      aliases:
        typeof model.resolvedModel === 'string' && model.resolvedModel !== model.value ? [model.resolvedModel] : [],
      reasoning_efforts: efforts,
      default_reasoning_effort: null,
      permission_modes: null,
    })
  }
  return { source: 'supportedModels', models: listed }
}

/** What a `system/init` frame names in effect; a value it leaves out stays null. */
export function initSettings(message) {
  const text = (value) => (typeof value === 'string' && value ? value : null)
  return {
    model: text(message.model),
    reasoning_effort: text(message.effort),
    permission_mode: text(message.permissionMode),
  }
}
