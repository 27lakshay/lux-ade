import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
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
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from '@/components/ui/field'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useDaemon } from '../state/hooks'
import { ThemePackExportDialog } from './ThemePackExportDialog'
import { ThemeEditorDialog } from './ThemeEditorDialog'
import { errorMessage } from '../../../shared/bridge/result'
import { draftSource, ThemeContrastInspector, ThemeDetails } from './ThemeDetails'

function Library({ onEdit }: { onEdit: (source: string) => void }) {
  const cache = useQueryClient()
  const bootId = useDaemon((state) => state.bootId)
  const [afterId, setAfterId] = useState<string | undefined>()
  const [editorSource, setEditorSource] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [focusRole, setFocusRole] = useState<{ section: 'app' | 'terminal' | 'syntax'; role: string } | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [linkedFile, setLinkedFile] = useState<Awaited<ReturnType<typeof window.adeHost.themes.linkFile>>>(null)
  const linkedFileRef = useRef(linkedFile)
  const [linkError, setLinkError] = useState<string>()
  const library = useQuery({
    queryKey: ['theme-library', bootId, afterId],
    queryFn: () => window.adeHost.themes.list(afterId),
  })
  const selected = useQuery({
    queryKey: ['theme-record', bootId, selectedId],
    queryFn: () => window.adeHost.themes.inspect(selectedId),
    enabled: Boolean(selectedId),
  })
  useEffect(
    () =>
      window.adeHost.conversations.onFeedFrame((frame) => {
        if (frame.type === 'theme_library_changed' && frame.boot_id === bootId) {
          void cache.invalidateQueries({ queryKey: ['theme-library'] })
          void cache.invalidateQueries({ queryKey: ['theme-record'] })
        }
      }),
    [bootId, cache],
  )
  useEffect(() => {
    const unsubscribe = window.adeHost.themes.onLinkedFile((update) => {
      const current = linkedFileRef.current
      if (current?.linkId === update.linkId && update.sequence <= current.sequence) return
      linkedFileRef.current = update
      if (update.source !== null) setEditorSource(update.source)
      setLinkedFile(update)
    })
    return () => {
      unsubscribe()
      void window.adeHost.themes.unlinkFile()
    }
  }, [])
  const unlink = async () => {
    const linkId = linkedFileRef.current?.linkId
    await window.adeHost.themes.unlinkFile(linkId)
    linkedFileRef.current = null
    setLinkedFile(null)
  }
  const link = async () => {
    setLinkError(undefined)
    try {
      const file = await window.adeHost.themes.linkFile()
      if (!file) return
      const current = linkedFileRef.current
      const latest = current?.linkId === file.linkId && current.sequence > file.sequence ? current : file
      linkedFileRef.current = latest
      setLinkedFile(latest)
      if (latest.source !== null) {
        setEditorSource(latest.source)
        setEditorOpen(true)
      } else
        setLinkError(
          latest.diagnostics
            .map((item) => `${item.path || 'Document'}, line ${item.line}, column ${item.column}: ${item.message}`)
            .join(' '),
        )
    } catch (error) {
      setLinkError(errorMessage(error))
    }
  }
  return (
    <>
      <ScrollArea className="min-h-0 flex-1">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="installed-theme">Installed theme</FieldLabel>
            <FieldDescription>
              Inspect definitions, preserve source attribution and create custom drafts. Library changes leave the
              selected colors unchanged until you apply a selection. Replacing an active definition updates its colors.
            </FieldDescription>
            <NativeSelect
              id="installed-theme"
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              <NativeSelectOption value="">Choose a definition</NativeSelectOption>
              {library.data?.themes.map((theme) => (
                <NativeSelectOption key={theme.id} value={theme.id}>
                  {theme.name} — {theme.id} ({theme.mode}, {theme.bundled ? 'bundled' : 'custom'})
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <div className="flex gap-2">
            {afterId && (
              <Button size="sm" variant="outline" onClick={() => setAfterId(undefined)}>
                First themes
              </Button>
            )}
            {library.data?.next_id && (
              <Button size="sm" variant="outline" onClick={() => setAfterId(library.data!.next_id!)}>
                Next themes
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => void link()}>
              Link theme file
            </Button>
            {linkedFile && (
              <Button size="sm" variant="outline" onClick={() => void unlink()}>
                Unlink theme file
              </Button>
            )}
          </div>
          {linkError && <FieldError role="alert">{linkError}</FieldError>}
          {linkedFile && (
            <Field>
              <Body>Linked source: {linkedFile.path}</Body>
              {linkedFile.source === null &&
                linkedFile.diagnostics.map((item, index) => (
                  <FieldError key={index}>
                    {item.path || 'Document'}, line {item.line}, column {item.column}: {item.message}
                  </FieldError>
                ))}
            </Field>
          )}
          {(library.error ?? selected.error) && <FieldError>{(library.error ?? selected.error)?.message}</FieldError>}
          {selected.data && (
            <ThemeDetails
              key={selected.data.theme.definition.id}
              theme={selected.data.theme}
              onEdit={(source, role) => {
                setEditorSource(source)
                setFocusRole(role ?? null)
                setEditorOpen(true)
              }}
              onRemoved={() => setSelectedId('')}
            />
          )}
        </FieldGroup>
      </ScrollArea>
      <ThemeEditorDialog
        source={editorSource}
        open={editorOpen}
        onOpenChange={(next) => {
          setEditorOpen(next)
          if (!next && linkedFile) void unlink()
        }}
        focusRole={focusRole}
        onSave={(source) => {
          if (linkedFile) void unlink()
          setEditorOpen(false)
          onEdit(source)
        }}
        renderDraftDiagnostics={(definition, preview, updateDraft) => (
          <>
            {linkedFile?.source === null && linkedFile.diagnostics.length > 0 && (
              <FieldSet>
                <FieldLegend>Linked file diagnostics</FieldLegend>
                <FieldGroup>
                  {linkedFile.diagnostics.map((item, index) => (
                    <Field key={item.path + item.code + index} role="alert" data-testid="linked-file-diagnostic">
                      <Body>
                        {item.severity} — {item.code} · {item.path || 'Document'}
                      </Body>
                      <Body>
                        {item.message} (line {item.line}, column {item.column})
                      </Body>
                    </Field>
                  ))}
                </FieldGroup>
              </FieldSet>
            )}
            <ThemeContrastInspector
              preview={preview}
              definition={definition}
              editableRoles={
                definition.provenance.kind === 'user'
                  ? new Set(
                      ('app terminal syntax'.split(' ') as ('app' | 'terminal' | 'syntax')[]).flatMap((section) =>
                        Object.keys(definition[section]?.tokens ?? {}).map((role) => section + '-' + role),
                      ),
                    )
                  : new Set()
              }
              onFollow={(item) => {
                if (item.section !== 'diff') setFocusRole({ section: item.section, role: item.role })
              }}
              onRepair={(item, replacement) => {
                const next = structuredClone(definition)
                if (item.section !== 'diff' && next[item.section]) {
                  next[item.section]!.tokens[item.role] = replacement
                  updateDraft(draftSource(next))
                }
              }}
            />
          </>
        )}
      />
    </>
  )
}

export function ThemeLibraryDialog({ onEdit }: { onEdit: (source: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>Theme library</DialogTrigger>
      <DialogContent className="flex h-(--library-height) flex-col sm:max-w-4xl [--library-height:85dvh]">
        <DialogHeader>
          <DialogTitle>Theme library</DialogTitle>
          <DialogDescription>
            Definitions belong to this profile and remain available after source files disappear.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <Library
            onEdit={(source) => {
              onEdit(source)
              setOpen(false)
            }}
          />
        )}
        <DialogFooter>
          <ThemePackExportDialog />
          <DialogClose render={<Button size="sm" variant="outline" />}>Close library</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
