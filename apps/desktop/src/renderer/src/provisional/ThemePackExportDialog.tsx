import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { ThemePackExportItem } from '@ade/contracts'
import { Body } from '@/components/Typography'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { useDaemon } from '../state/hooks'

function PackExport() {
  const bootId = useDaemon((state) => state.bootId)
  const [afterId, setAfterId] = useState<string | undefined>()
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [items, setItems] = useState<ThemePackExportItem[]>([])
  const library = useQuery({
    queryKey: ['theme-library', bootId, afterId],
    queryFn: () => window.adeHost.themes.list(afterId),
  })
  const exported = useMutation({ mutationFn: () => window.adeHost.themes.exportPack({ id, name, items }) })
  const file = useMutation({ mutationFn: () => window.adeHost.themes.savePack({ id, name, items }) })
  const review = useMutation({
    mutationFn: async () =>
      Promise.all(
        items.map(async (item) => {
          const record = await window.adeHost.themes.inspect(item.id)
          return { id: item.id, expected_revision: record.theme.revision }
        }),
      ),
    onSuccess: (latest) => {
      setItems(latest)
      exported.reset()
      file.reset()
    },
  })
  const pending = exported.isPending || file.isPending || review.isPending
  const ready = Boolean(id && name && items.length && !pending)
  const clear = () => {
    exported.reset()
    file.reset()
    review.reset()
  }
  return (
    <>
      <ScrollArea className="min-h-0 flex-1">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="export-pack-id">Pack ID</FieldLabel>
            <FieldDescription>Use a stable namespaced ID, such as user:my-pack.</FieldDescription>
            <Input
              id="export-pack-id"
              value={id}
              disabled={pending}
              onChange={(event) => {
                setId(event.target.value)
                clear()
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="export-pack-name">Pack name</FieldLabel>
            <Input
              id="export-pack-name"
              value={name}
              disabled={pending}
              onChange={(event) => {
                setName(event.target.value)
                clear()
              }}
            />
          </Field>
          <Body>Choose up to 16 independent definitions. Export includes their resolved colors and attribution.</Body>
          {library.data?.themes.map((theme) => {
            const selected = items.some((item) => item.id === theme.id)
            return (
              <Field key={theme.id} orientation="horizontal">
                <Checkbox
                  id={`export-pack-${theme.id}`}
                  checked={selected}
                  disabled={pending || (!selected && items.length === 16)}
                  onCheckedChange={(checked) => {
                    setItems(
                      checked
                        ? [...items, { id: theme.id, expected_revision: theme.revision }]
                        : items.filter((item) => item.id !== theme.id),
                    )
                    clear()
                  }}
                />
                <FieldLabel htmlFor={`export-pack-${theme.id}`}>
                  Include {theme.name} — {theme.id} ({theme.mode})
                </FieldLabel>
              </Field>
            )
          })}
          <div className="flex gap-2">
            {afterId && (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => setAfterId(undefined)}>
                First pack members
              </Button>
            )}
            {library.data?.next_id && (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => setAfterId(library.data!.next_id!)}>
                Next pack members
              </Button>
            )}
          </div>
          {items.map((item) => (
            <Field key={item.id}>
              <Body>
                {item.id} — captured revision {item.expected_revision}
              </Body>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  setItems(items.filter((entry) => entry.id !== item.id))
                  clear()
                }}
              >
                Remove {item.id} from pack
              </Button>
            </Field>
          ))}
          <Body>
            Captured revisions stay unchanged when the library changes. Review selected revisions before retrying a
            conflict.
          </Body>
          <Button size="sm" variant="outline" disabled={!items.length || pending} onClick={() => review.mutate()}>
            Review selected revisions
          </Button>
          {(library.error ?? review.error ?? exported.error ?? file.error) && (
            <FieldError>{(library.error ?? review.error ?? exported.error ?? file.error)?.message}</FieldError>
          )}
          {exported.data && (
            <Field>
              <FieldLabel htmlFor="exported-pack">Exported ADE pack</FieldLabel>
              <Textarea id="exported-pack" value={exported.data.source} readOnly rows={10} />
            </Field>
          )}
          {file.isSuccess && (
            <Body role="status">
              {file.data ? `Exported pack ${file.data.pack_id} to ${file.data.path}.` : 'Pack file export canceled.'}
            </Body>
          )}
        </FieldGroup>
      </ScrollArea>
      <DialogFooter>
        <Button size="sm" variant="outline" disabled={!ready} onClick={() => exported.mutate()}>
          Export pack data
        </Button>
        <Button size="sm" disabled={!ready} onClick={() => file.mutate()}>
          Export pack to file
        </Button>
        <DialogClose render={<Button size="sm" variant="outline" disabled={pending} />}>Close pack export</DialogClose>
      </DialogFooter>
    </>
  )
}

export function ThemePackExportDialog() {
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>Export theme pack</DialogTrigger>
      <DialogContent className="flex h-(--pack-height) flex-col sm:max-w-4xl [--pack-height:85dvh]">
        <DialogHeader>
          <DialogTitle>Export theme pack</DialogTitle>
          <DialogDescription>
            Export selected definitions without changing installed themes or appearance choices.
          </DialogDescription>
        </DialogHeader>
        {open && <PackExport />}
      </DialogContent>
    </Dialog>
  )
}
