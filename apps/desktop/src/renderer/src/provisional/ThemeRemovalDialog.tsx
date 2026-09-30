import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Body } from '@/components/Typography'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { FieldDescription, FieldError, FieldGroup } from '@/components/ui/field'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useDaemon } from '../state/hooks'

function RemovalDraft({ id, onRemoved }: { id: string; onRemoved: () => void }) {
  const cache = useQueryClient()
  const bootId = useDaemon((state) => state.bootId)
  const [afterKey, setAfterKey] = useState<string | undefined>()
  const [reviewing, setReviewing] = useState(false)
  const baseline = useQuery({
    queryKey: ['theme-removal', bootId, id, 'base'],
    queryFn: () => window.adeHost.themes.removal(id),
    staleTime: Infinity,
    gcTime: 0,
  })
  const page = useQuery({
    queryKey: ['theme-removal', bootId, id, afterKey],
    queryFn: () => window.adeHost.themes.removal(id, afterKey),
    enabled: Boolean(afterKey),
    staleTime: Infinity,
    gcTime: 0,
  })
  const plan = afterKey ? page.data : baseline.data
  const consistent =
    plan &&
    baseline.data &&
    plan.theme.revision === baseline.data.theme.revision &&
    plan.appearance_revision === baseline.data.appearance_revision
  const removal = useMutation({
    mutationFn: async () => {
      if (!baseline.data || !consistent) throw new Error('Review the current removal plan before removing this theme')
      return window.adeHost.themes.remove(id, baseline.data.theme.revision, baseline.data.appearance_revision)
    },
    onSuccess: () => {
      for (const key of ['theme-library', 'theme-record', 'profile-settings', 'appearance'])
        void cache.invalidateQueries({ queryKey: [key] })
      onRemoved()
    },
  })
  const review = async () => {
    setReviewing(true)
    try {
      const result = await baseline.refetch()
      if (!result.error) {
        setAfterKey(undefined)
        removal.reset()
      }
    } finally {
      setReviewing(false)
    }
  }
  const error = removal.error ?? baseline.error ?? page.error
  return (
    <>
      <ScrollArea className="min-h-0 flex-1">
        <FieldGroup>
          {baseline.data && (
            <>
              <Body>
                {baseline.data.theme.name} — {id}, definition revision {baseline.data.theme.revision}.
              </Body>
              <Body>
                Appearance revision {baseline.data.appearance_revision}. Affected selections: {baseline.data.total}.
              </Body>
              <FieldDescription>
                Direct choices change to the listed core theme. Follow-app choices remain linked to the app. A profile
                terminal choice applies to all terminals without their own override. Fonts, motion and readability
                preferences remain unchanged.
              </FieldDescription>
              {baseline.data.total === 0 && <Body>No saved selections reference this definition.</Body>}
            </>
          )}
          {plan?.impacts.map((impact) => (
            <Body key={impact.key}>
              {impact.consumer === 'app' ? 'App' : impact.consumer === 'syntax' ? 'Syntax' : 'Terminal'} {impact.slot}:{' '}
              {impact.terminal_id ? `${impact.workspace_id} / ${impact.terminal_id}` : 'Profile'} → {impact.fallback_id}
              {impact.indirect ? ' (through app selection)' : ''}
            </Body>
          ))}
          {afterKey && (
            <Button
              size="sm"
              variant="outline"
              disabled={removal.isPending || reviewing}
              onClick={() => setAfterKey(undefined)}
            >
              First affected selections
            </Button>
          )}
          {plan?.next_key && (
            <Button
              size="sm"
              variant="outline"
              disabled={removal.isPending || reviewing}
              onClick={() => setAfterKey(plan.next_key!)}
            >
              Next affected selections
            </Button>
          )}
          {!consistent && plan && (
            <FieldError>The definition or selections changed while loading this page. Review removal again.</FieldError>
          )}
          {error && <FieldError>{error.message} Review removal again before retrying.</FieldError>}
        </FieldGroup>
      </ScrollArea>
      <DialogFooter>
        <DialogClose render={<Button size="sm" variant="outline" disabled={removal.isPending} />}>
          Cancel removal
        </DialogClose>
        <Button size="sm" variant="outline" disabled={removal.isPending || reviewing} onClick={() => void review()}>
          Review removal again
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={
            removal.isPending || reviewing || !consistent || !baseline.data?.removable || Boolean(baseline.error)
          }
          onClick={() => removal.mutate()}
        >
          Remove theme and apply fallbacks
        </Button>
      </DialogFooter>
    </>
  )
}

export function ThemeRemovalDialog({
  id,
  protectedTheme,
  onRemoved,
}: {
  id: string
  protectedTheme: boolean
  onRemoved: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="destructive" disabled={protectedTheme} />}>
        Remove theme
      </DialogTrigger>
      <DialogContent className="flex h-(--removal-height) flex-col sm:max-w-3xl [--removal-height:75dvh]">
        <DialogHeader>
          <DialogTitle>Remove theme</DialogTitle>
          <DialogDescription>
            Review affected selections and their fallbacks before deleting this profile definition.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <RemovalDraft
            id={id}
            onRemoved={() => {
              setOpen(false)
              onRemoved()
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
