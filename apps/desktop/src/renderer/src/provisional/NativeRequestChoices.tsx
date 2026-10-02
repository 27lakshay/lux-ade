import { useId, useRef, useState, type SubmitEvent } from 'react'
import type { PendingRequest, RequestAnswer, RequestScope } from '@ade/contracts'

import { Button } from '../components/ui/button'
import { Field, FieldDescription, FieldError, FieldLegend, FieldSet, FieldLabel } from '../components/ui/field'
import { RadioGroup, RadioGroupItem } from '../components/ui/radio-group'

const scopes = new Set<RequestScope>(['once', 'turn', 'session', 'persistent'])
export function isRequestScope(scope: string): scope is RequestScope {
  return scopes.has(scope as RequestScope)
}

function scopeLabel(scope: RequestScope): string {
  switch (scope) {
    case 'once':
      return 'Once'
    case 'turn':
      return 'For this turn'
    case 'session':
      return 'For this session'
    case 'persistent':
      return 'Persistent'
  }
}

export function ChoiceForm({
  choices,
  disabled,
  onAnswer,
}: {
  choices: Extract<PendingRequest['metadata']['schema'], { kind: 'choices' }>['choices']
  disabled: boolean
  onAnswer: (answer: RequestAnswer) => Promise<void>
}) {
  const idPrefix = useId()
  const [selected, setSelected] = useState('')
  const [error, setError] = useState('')
  const firstChoice = useRef<HTMLButtonElement | null>(null)
  const errorId = `${idPrefix}-error`
  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const index = Number(selected)
    const choice = selected && Number.isInteger(index) ? choices[index] : undefined
    if (!choice) {
      setError('Choose a response before sending.')
      firstChoice.current?.focus()
      return
    }
    setError('')
    void onAnswer({ kind: 'choice', value: choice.value })
  }
  return (
    <form aria-label="Answer agent request" onSubmit={submit}>
      <FieldSet aria-describedby={error ? errorId : undefined} aria-invalid={Boolean(error)}>
        <FieldLegend variant="label">Choose a response</FieldLegend>
        <RadioGroup
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          value={selected}
          onValueChange={(value) => {
            setSelected(value ?? '')
            setError('')
          }}
        >
          {choices.map((choice, index) => {
            const id = `${idPrefix}-choice-${index}`
            const details = [choice.scope ? scopeLabel(choice.scope) : '', choice.duration ?? '']
              .filter(Boolean)
              .join(' · ')
            return (
              <Field key={index} orientation="horizontal" className="items-start">
                <RadioGroupItem
                  ref={index === 0 ? firstChoice : undefined}
                  id={id}
                  value={String(index)}
                  disabled={disabled}
                  aria-describedby={details ? `${id}-details` : undefined}
                />
                <div className="min-w-0">
                  <FieldLabel htmlFor={id}>{choice.label}</FieldLabel>
                  {details && <FieldDescription id={`${id}-details`}>{details}</FieldDescription>}
                </div>
              </Field>
            )
          })}
        </RadioGroup>
        {error && <FieldError id={errorId}>{error}</FieldError>}
      </FieldSet>
      <Button size="sm" className="mt-3" type="submit" disabled={disabled}>
        Send response
      </Button>
    </form>
  )
}

export function PermissionsForm({
  schema,
  disabled,
  onAnswer,
}: {
  schema: Extract<PendingRequest['metadata']['schema'], { kind: 'permissions' }>
  disabled: boolean
  onAnswer: (answer: RequestAnswer) => Promise<void>
}) {
  const idPrefix = useId()
  const [scope, setScope] = useState<RequestScope | ''>('')
  const [strictReview, setStrictReview] = useState<'default' | 'on' | 'off'>('default')
  const [error, setError] = useState('')
  const firstScope = useRef<HTMLButtonElement | null>(null)
  const errorId = `${idPrefix}-scope-error`
  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!scope || !schema.scopes.includes(scope)) {
      setError('Choose how long this permission should apply.')
      firstScope.current?.focus()
      return
    }
    setError('')
    void onAnswer({
      kind: 'permissions',
      permissions: schema.requested,
      scope,
      ...(strictReview === 'default' ? {} : { strict_auto_review: strictReview === 'on' }),
    })
  }
  return (
    <form aria-label="Answer permission request" onSubmit={submit}>
      <FieldSet aria-describedby={error ? errorId : undefined} aria-invalid={Boolean(error)}>
        <FieldLegend variant="label">Permission scope</FieldLegend>
        <FieldDescription>Choose how long this request may apply.</FieldDescription>
        <RadioGroup
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          value={scope}
          onValueChange={(value) => {
            setScope(isRequestScope(value) ? value : '')
            setError('')
          }}
        >
          {schema.scopes.map((item, index) => {
            const id = `${idPrefix}-scope-${index}`
            return (
              <Field key={item} orientation="horizontal">
                <RadioGroupItem ref={index === 0 ? firstScope : undefined} id={id} value={item} disabled={disabled} />
                <FieldLabel htmlFor={id}>{scopeLabel(item)}</FieldLabel>
              </Field>
            )
          })}
        </RadioGroup>
        {error && <FieldError id={errorId}>{error}</FieldError>}
      </FieldSet>
      {schema.supports_strict_auto_review && (
        <FieldSet className="mt-3">
          <FieldLegend variant="label">Strict automatic review</FieldLegend>
          <FieldDescription>The native client supports this optional setting.</FieldDescription>
          <RadioGroup
            value={strictReview}
            onValueChange={(value) => setStrictReview(value === 'on' || value === 'off' ? value : 'default')}
          >
            {(
              [
                ['default', 'Use native default'],
                ['on', 'Strict automatic review on'],
                ['off', 'Strict automatic review off'],
              ] as const
            ).map(([value, label], index) => {
              const id = `${idPrefix}-strict-${index}`
              return (
                <Field key={value} orientation="horizontal">
                  <RadioGroupItem id={id} value={value} disabled={disabled} />
                  <FieldLabel htmlFor={id}>{label}</FieldLabel>
                </Field>
              )
            })}
          </RadioGroup>
        </FieldSet>
      )}
      <Button size="sm" className="mt-3" type="submit" disabled={disabled}>
        Send permission response
      </Button>
    </form>
  )
}
