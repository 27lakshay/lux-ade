import { create } from 'zustand'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

// `await confirm({...})` asks one yes-or-no question and resolves true when confirmed. One host,
// mounted at the root, shows the questions one at a time.

export interface ConfirmOptions {
  title: string
  description?: string
  confirmLabel?: string
  /** The action deletes or discards something. */
  destructive?: boolean
}

interface Question extends ConfirmOptions {
  id: number
  answer: (confirmed: boolean) => void
}

const useQuestions = create<{ queue: Question[] }>(() => ({ queue: [] }))
let asked = 0

export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const answer = (confirmed: boolean): void => {
      useQuestions.setState(({ queue }) => ({ queue: queue.filter((question) => question.answer !== answer) }))
      resolve(confirmed)
    }
    useQuestions.setState(({ queue }) => ({ queue: [...queue, { ...options, id: ++asked, answer }] }))
  })
}

export function ConfirmHost() {
  const question = useQuestions((state) => state.queue[0])
  if (!question) return null
  // Each question is its own dialog, so the next one opens fresh as the last one closes.
  return (
    <AlertDialog key={question.id} open onOpenChange={(open) => !open && question.answer(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{question.title}</AlertDialogTitle>
          {question.description && <AlertDialogDescription>{question.description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={question.destructive ? 'destructive' : 'default'}
            onClick={() => question.answer(true)}
          >
            {question.confirmLabel ?? 'Confirm'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
