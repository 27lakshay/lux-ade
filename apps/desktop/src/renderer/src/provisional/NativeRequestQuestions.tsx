import { useId, useRef, useState, type SubmitEvent } from 'react'
import type { PendingRequest, RequestAnswer } from '@ade/contracts'

import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '../components/ui/field'
import { Input } from '../components/ui/input'
import { RadioGroup, RadioGroupItem } from '../components/ui/radio-group'
import { Textarea } from '../components/ui/textarea'

type QuestionDraft = { selection: string; selectedOptions: string[]; otherText: string }
const emptyQuestionDraft = (): QuestionDraft => ({ selection: '', selectedOptions: [], otherText: '' })

export function QuestionForm({
  questions,
  decline,
  disabled,
  onAnswer,
}: {
  questions: Extract<PendingRequest['metadata']['schema'], { kind: 'questions' }>['questions']
  decline: Extract<PendingRequest['metadata']['schema'], { kind: 'questions' }>['decline']
  disabled: boolean
  onAnswer: (answer: RequestAnswer) => Promise<void>
}) {
  const idPrefix = useId()
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>(() => Object.create(null))
  const [errors, setErrors] = useState<Record<string, string>>(() => Object.create(null))
  const focusTargets = useRef(new Map<string, HTMLElement>())
  const valueFor = (questionId: string): QuestionDraft => drafts[questionId] ?? emptyQuestionDraft()
  const updateQuestion = (questionId: string, update: (current: QuestionDraft) => QuestionDraft): void => {
    setDrafts((current) => ({ ...current, [questionId]: update(current[questionId] ?? emptyQuestionDraft()) }))
    setErrors((current) => {
      if (!current[questionId]) return current
      const next = { ...current }
      delete next[questionId]
      return next
    })
  }
  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const answers: Record<string, unknown[]> = Object.create(null) as Record<string, unknown[]>
    const nextErrors: Record<string, string> = Object.create(null) as Record<string, string>
    for (const question of questions) {
      const draft = valueFor(question.id)
      const options = question.options ?? []
      let values: unknown[] = []
      if (question.multiple) {
        values = draft.selectedOptions
          .map((selection) => options[Number(selection)])
          .filter((option) => option !== undefined)
          .map((option) => option.value)
        if (question.allow_other && draft.otherText.trim()) values.push(draft.otherText)
      } else if (!options.length) {
        if (draft.otherText.trim()) values = [draft.otherText]
      } else if (draft.selection === 'other') {
        if (draft.otherText.trim()) values = [draft.otherText]
      } else if (draft.selection) {
        const option = options[Number(draft.selection)]
        if (option) values = [option.value]
      }
      if (!values.length) nextErrors[question.id] = 'Choose or enter an answer.'
      else answers[question.id] = values
    }
    setErrors(nextErrors)
    const firstInvalid = questions.find((question) => nextErrors[question.id])
    if (firstInvalid) {
      focusTargets.current.get(firstInvalid.id)?.focus()
      return
    }
    void onAnswer({ kind: 'questions', answers })
  }

  return (
    <form aria-label="Answer structured questions" onSubmit={submit}>
      <FieldGroup>
        {questions.map((question, questionIndex) => {
          const options = question.options ?? []
          const draft = valueFor(question.id)
          const error = errors[question.id]
          const fieldId = `${idPrefix}-question-${questionIndex}`
          const descriptionId = `${fieldId}-description`
          const errorId = `${fieldId}-error`
          const legend = question.header || question.prompt
          const secretType = question.secret ? 'password' : 'text'
          const otherId = `${fieldId}-other`
          return (
            <FieldSet
              key={question.id}
              aria-describedby={
                [question.header ? descriptionId : '', error ? errorId : ''].filter(Boolean).join(' ') || undefined
              }
              aria-invalid={Boolean(error)}
            >
              <FieldLegend id={fieldId + '-legend'} variant="label">
                {legend}
              </FieldLegend>
              {question.header && <FieldDescription id={descriptionId}>{question.prompt}</FieldDescription>}
              {options.length > 0 && !question.multiple && (
                <RadioGroup
                  aria-labelledby={`${fieldId}-legend`}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? errorId : undefined}
                  value={draft.selection}
                  onValueChange={(value) =>
                    updateQuestion(question.id, (current) => ({ ...current, selection: value ?? '' }))
                  }
                >
                  {options.map((option, optionIndex) => {
                    const optionId = `${fieldId}-option-${optionIndex}`
                    const optionDescriptionId = `${optionId}-description`
                    return (
                      <Field key={optionIndex} orientation="horizontal" className="items-start">
                        <RadioGroupItem
                          ref={(node) => {
                            if (optionIndex === 0 && node) focusTargets.current.set(question.id, node)
                          }}
                          id={optionId}
                          value={String(optionIndex)}
                          disabled={disabled}
                          aria-describedby={option.description ? optionDescriptionId : undefined}
                        />
                        <div className="min-w-0">
                          <FieldLabel htmlFor={optionId}>{option.label}</FieldLabel>
                          {option.description && (
                            <FieldDescription id={optionDescriptionId}>{option.description}</FieldDescription>
                          )}
                        </div>
                      </Field>
                    )
                  })}
                  {question.allow_other && (
                    <Field orientation="horizontal" className="items-start">
                      <RadioGroupItem
                        id={`${fieldId}-other-choice`}
                        value="other"
                        disabled={disabled}
                        ref={(node) => {
                          if (!options.length && node) focusTargets.current.set(question.id, node)
                        }}
                      />
                      <FieldLabel htmlFor={`${fieldId}-other-choice`}>Other</FieldLabel>
                    </Field>
                  )}
                </RadioGroup>
              )}
              {options.length > 0 && question.multiple && (
                <div role="group" aria-label={`${question.prompt} options`} aria-invalid={Boolean(error)}>
                  <FieldGroup>
                    {options.map((option, optionIndex) => {
                      const optionId = `${fieldId}-option-${optionIndex}`
                      const optionDescriptionId = `${optionId}-description`
                      const selected = draft.selectedOptions.includes(String(optionIndex))
                      return (
                        <Field key={optionIndex} orientation="horizontal" className="items-start">
                          <Checkbox
                            ref={(node) => {
                              if (optionIndex === 0 && node) focusTargets.current.set(question.id, node)
                            }}
                            id={optionId}
                            checked={selected}
                            disabled={disabled}
                            aria-invalid={Boolean(error)}
                            aria-describedby={option.description ? optionDescriptionId : error ? errorId : undefined}
                            onCheckedChange={(checked) =>
                              updateQuestion(question.id, (current) => ({
                                ...current,
                                selectedOptions:
                                  checked === true
                                    ? [...current.selectedOptions, String(optionIndex)]
                                    : current.selectedOptions.filter((item) => item !== String(optionIndex)),
                              }))
                            }
                          />
                          <div className="min-w-0">
                            <FieldLabel htmlFor={optionId}>{option.label}</FieldLabel>
                            {option.description && (
                              <FieldDescription id={optionDescriptionId}>{option.description}</FieldDescription>
                            )}
                          </div>
                        </Field>
                      )
                    })}
                  </FieldGroup>
                </div>
              )}
              {question.allow_other && (question.multiple || !options.length || question.secret) && (
                <Field data-invalid={Boolean(error)}>
                  <FieldLabel htmlFor={otherId}>{options.length ? 'Other answer' : question.prompt}</FieldLabel>
                  {question.secret ? (
                    <Input
                      ref={(node) => {
                        if ((!options.length || (!question.multiple && question.allow_other)) && node)
                          focusTargets.current.set(question.id, node)
                      }}
                      id={otherId}
                      type={secretType}
                      autoComplete="off"
                      spellCheck={false}
                      value={draft.otherText}
                      disabled={disabled || (!question.multiple && options.length > 0 && draft.selection !== 'other')}
                      aria-invalid={Boolean(error)}
                      aria-describedby={error ? errorId : question.header ? descriptionId : undefined}
                      onChange={(event) =>
                        updateQuestion(question.id, (current) => ({ ...current, otherText: event.target.value }))
                      }
                    />
                  ) : (
                    <Textarea
                      ref={(node) => {
                        if ((!options.length || (!question.multiple && question.allow_other)) && node)
                          focusTargets.current.set(question.id, node)
                      }}
                      id={otherId}
                      value={draft.otherText}
                      disabled={disabled || (!question.multiple && options.length > 0 && draft.selection !== 'other')}
                      aria-invalid={Boolean(error)}
                      aria-describedby={error ? errorId : question.header ? descriptionId : undefined}
                      onChange={(event) =>
                        updateQuestion(question.id, (current) => ({ ...current, otherText: event.target.value }))
                      }
                    />
                  )}
                </Field>
              )}
              {error && <FieldError id={errorId}>{error}</FieldError>}
            </FieldSet>
          )
        })}
      </FieldGroup>
      {decline && (
        <Button
          size="sm"
          className="mt-3"
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => void onAnswer({ kind: 'choice', value: decline.value })}
        >
          {decline.label || 'Decline request'}
        </Button>
      )}
      <Button size="sm" className="mt-3" type="submit" disabled={disabled}>
        Send response
      </Button>
    </form>
  )
}
