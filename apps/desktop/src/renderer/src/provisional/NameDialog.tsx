import { useState } from 'react'
import { create } from 'zustand'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

// `await askName({...})` asks for one name and resolves with it, trimmed, or null when cancelled.
// One host, mounted at the root, shows the questions one at a time (as ConfirmDialog does).

export interface NameOptions {
  title: string
  description?: string
  /** The field's label. */
  label: string
  confirmLabel: string
}

interface Question extends NameOptions {
  id: number
  answer: (name: string | null) => void
}

const useQuestions = create<{ queue: Question[] }>(() => ({ queue: [] }))
let asked = 0

export function askName(options: NameOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const answer = (name: string | null): void => {
      useQuestions.setState(({ queue }) => ({ queue: queue.filter((question) => question.answer !== answer) }))
      resolve(name)
    }
    useQuestions.setState(({ queue }) => ({ queue: [...queue, { ...options, id: ++asked, answer }] }))
  })
}

function NameForm({ question }: { question: Question }) {
  const [name, setName] = useState('')
  const trimmed = name.trim()
  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault()
        if (trimmed) question.answer(trimmed)
      }}
    >
      <DialogHeader>
        <DialogTitle>{question.title}</DialogTitle>
        {question.description && <DialogDescription>{question.description}</DialogDescription>}
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor={`name-${question.id}`}>{question.label}</FieldLabel>
        <Input
          id={`name-${question.id}`}
          autoFocus
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
        <Button type="submit" size="sm" disabled={!trimmed}>
          {question.confirmLabel}
        </Button>
      </DialogFooter>
    </form>
  )
}

export function NameHost() {
  const question = useQuestions((state) => state.queue[0])
  if (!question) return null
  return (
    <Dialog key={question.id} open onOpenChange={(open) => !open && question.answer(null)}>
      <DialogContent>
        <NameForm question={question} />
      </DialogContent>
    </Dialog>
  )
}
