import { useCallback, useEffect, useState } from 'react'
import type { ConversationSettings, SettingState } from '@ade/contracts'
import { Body, Caption } from '@/components/Typography'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import type { ConversationsBridge } from '../../../shared/bridge/conversations'
import { messageOf } from './ConversationComposerSupport'
import { UsagePanel } from './UsagePanel'
import { CompactControl } from './CompactControl'
import { CommandsPanel } from './CommandsPanel'
import { ExportConversation } from './ExportConversation'

const SOURCE: Record<SettingState['source'], string> = {
  native_reported: 'reported by the provider',
  requested_only: 'not reported by the provider',
  provider_default: "the provider's default, not reported",
}

function inEffect(state: SettingState): string {
  return state.effective ? `${state.effective} (${SOURCE[state.source]})` : SOURCE[state.source]
}

const CHOICES: Record<SettingState['choices_source'], string> = {
  native_reported: 'Listed by the provider for this model',
  static: "ADE's list; the provider lists none for this model",
  unavailable: 'The provider listed no choices',
}

type Choices = { values: string[]; source: SettingState['choices_source'] }

/**
 * The choices for a setting that depends on the model in the draft: the daemon's own for the saved
 * model, else what it would offer for the drafted listed model. A drafted value it does not offer
 * stays visible and marked, so the daemon's refusal is not a surprise and nothing is swapped.
 */
function dependentChoices(
  settings: ConversationSettings,
  draftModel: string,
  setting: 'reasoning' | 'permission',
): Choices {
  const saved = setting === 'reasoning' ? settings.reasoning_effort : settings.permission_mode
  const listed = settings.discovery.models.find(
    (model) => model.native.id === draftModel || model.native.aliases.includes(draftModel),
  )
  if (draftModel === (settings.model.requested ?? '') || !listed)
    return { values: saved.choices, source: saved.choices_source }
  return setting === 'reasoning'
    ? { values: listed.reasoning_choices, source: listed.reasoning_choices_source }
    : { values: listed.permission_choices, source: listed.permission_choices_source }
}

function ChoiceOptions({ choices, value }: { choices: Choices; value: string }) {
  return (
    <>
      {choices.values.map((choice) => (
        <NativeSelectOption key={choice} value={choice}>
          {choice}
        </NativeSelectOption>
      ))}
      {value && !choices.values.includes(value) && (
        <NativeSelectOption value={value}>{value} (not offered for this model)</NativeSelectOption>
      )}
    </>
  )
}

/**
 * Provider settings for one conversation: what ADE requested beside what the provider reported
 * in effect. A change applies at the shown revision; a stale revision or an unoffered value is
 * refused by the daemon, never substituted.
 */
export function ProviderSettingsPanel({
  conversationId,
  conversations,
  version,
}: {
  conversationId: string
  conversations: ConversationsBridge
  /** Changes whenever the conversation record changes, so the settings are read again. */
  version: number
}) {
  const [settings, setSettings] = useState<ConversationSettings | null>(null)
  const [draft, setDraft] = useState({ model: '', reasoning: '', permission: '' })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const load = useCallback(
    () =>
      conversations.request('conversation.settings', { conversation_id: conversationId }).then((next) => {
        if (next?.type !== 'conversation_settings') throw new Error('The settings reply was not readable.')
        setSettings(next)
        setDraft({
          model: next.model.requested ?? '',
          reasoning: next.reasoning_effort.requested ?? '',
          permission: next.permission_mode.requested ?? '',
        })
      }),
    [conversationId, conversations],
  )
  useEffect(() => {
    load().catch((error: unknown) => setMessage("Couldn't read provider settings. " + messageOf(error)))
  }, [load, version])

  // Settings are secondary to the conversation; an unreadable reply is a quiet note, not an alert.
  if (!settings) return message ? <Caption tone="muted">{message}</Caption> : null
  const apply = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const updated = await conversations.request('conversation.settings.update', {
        operation_id: crypto.randomUUID(),
        conversation_id: conversationId,
        expected_revision: settings.revision,
        model: draft.model,
        reasoning_effort: draft.reasoning,
        permission_mode: draft.permission,
      })
      setMessage(
        updated.native_error
          ? 'Settings were stored but not applied: ' + updated.native_error
          : updated.changed.length === 0
            ? 'Nothing changed.'
            : updated.relaunched
              ? 'Settings saved. The agent is restarting with them.'
              : 'Settings saved. They apply when the agent next starts.',
      )
      await load()
    } catch (error) {
      setMessage("Couldn't change settings. " + messageOf(error))
    } finally {
      setBusy(false)
    }
  }
  const locked = busy || settings.turn_running
  const reasoning = dependentChoices(settings, draft.model, 'reasoning')
  const permission = dependentChoices(settings, draft.model, 'permission')
  const listedModels = settings.discovery.models
  return (
    // Conversation tools stay within a third of the view and scroll there, so opening one never
    // squeezes the conversation history out of sight.
    <ScrollArea
      aria-label="Conversation tools"
      role="group"
      className="*:data-[slot=scroll-area-viewport]:max-h-(--conversation-tools-max-height,33vh)"
    >
      <div className="flex flex-col gap-2">
        <Collapsible>
          <CollapsibleTrigger render={<Button variant="outline" size="sm" className="self-start" />}>
            Provider settings
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 flex flex-col gap-3 rounded-lg bg-panel px-4 py-3">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1" aria-label="Settings in effect">
                <dt>
                  <Caption>Model in effect</Caption>
                </dt>
                <dd>
                  <Body>{inEffect(settings.model)}</Body>
                </dd>
                <dt>
                  <Caption>Reasoning in effect</Caption>
                </dt>
                <dd>
                  <Body>
                    {settings.reasoning_effort.supported
                      ? inEffect(settings.reasoning_effort)
                      : settings.reasoning_effort.reason}
                  </Body>
                </dd>
                <dt>
                  <Caption>Permission mode in effect</Caption>
                </dt>
                <dd>
                  <Body>{inEffect(settings.permission_mode)}</Body>
                </dd>
              </dl>
              <Field>
                <FieldLabel htmlFor={`${conversationId}-model`}>Model</FieldLabel>
                {settings.discovery.available ? (
                  <NativeSelect
                    id={`${conversationId}-model`}
                    value={draft.model}
                    disabled={locked}
                    onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                  >
                    <NativeSelectOption value="">Provider default</NativeSelectOption>
                    {listedModels.map(({ native }) => (
                      <NativeSelectOption key={native.id} value={native.id}>
                        {native.display_name ?? native.id}
                      </NativeSelectOption>
                    ))}
                    {draft.model && !listedModels.some(({ native }) => native.id === draft.model) && (
                      <NativeSelectOption value={draft.model}>{draft.model} (not listed)</NativeSelectOption>
                    )}
                  </NativeSelect>
                ) : (
                  <Input
                    id={`${conversationId}-model`}
                    value={draft.model}
                    placeholder="Provider default"
                    disabled={locked}
                    onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                  />
                )}
                <Caption tone="muted">
                  {settings.discovery.available
                    ? `Listed by the provider (${settings.discovery.source})`
                    : `${settings.discovery.reason} Enter a model ID; the provider checks it when the agent starts.`}
                </Caption>
              </Field>
              {settings.reasoning_effort.supported && (
                <Field>
                  <FieldLabel htmlFor={`${conversationId}-reasoning`}>Reasoning</FieldLabel>
                  <NativeSelect
                    id={`${conversationId}-reasoning`}
                    value={draft.reasoning}
                    disabled={locked}
                    onChange={(event) => setDraft({ ...draft, reasoning: event.target.value })}
                  >
                    <NativeSelectOption value="">Provider default</NativeSelectOption>
                    <ChoiceOptions choices={reasoning} value={draft.reasoning} />
                  </NativeSelect>
                  <Caption tone="muted">{CHOICES[reasoning.source]}</Caption>
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor={`${conversationId}-permission`}>Permission mode</FieldLabel>
                <NativeSelect
                  id={`${conversationId}-permission`}
                  value={draft.permission}
                  disabled={locked}
                  onChange={(event) => setDraft({ ...draft, permission: event.target.value })}
                >
                  <ChoiceOptions choices={permission} value={draft.permission} />
                </NativeSelect>
                <Caption tone="muted">{CHOICES[permission.source]}</Caption>
              </Field>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => void apply()} disabled={locked}>
                  {busy ? 'Saving…' : 'Save settings'}
                </Button>
                <Caption tone="muted">
                  Revision {settings.revision}
                  {settings.turn_running ? ' · Settings change after the running turn ends.' : ''}
                </Caption>
              </div>
              {message && (
                <Body role="status" aria-live="polite">
                  {message}
                </Body>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
        <CompactControl conversationId={conversationId} conversations={conversations} version={version} />
        <CommandsPanel conversationId={conversationId} conversations={conversations} />
        <ExportConversation conversationId={conversationId} conversations={conversations} />
        <UsagePanel
          conversationId={conversationId}
          provider={settings.provider}
          conversations={conversations}
          version={version}
        />
      </div>
    </ScrollArea>
  )
}
