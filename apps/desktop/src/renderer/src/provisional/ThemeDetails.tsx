import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ThemeDefinition, ThemeDraftPreview, ThemeRecord } from '@ade/contracts'
import { Body } from '@/components/Typography'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import { AppearancePreview } from './AppearancePreview'
import { ThemeRemovalDialog } from './ThemeRemovalDialog'
import { errorMessage } from '../../../shared/bridge/result'
import { findDraftContrastRepair, inspectThemeContrast, type ContrastReportRow } from './themeContrastInspector'

function ThemeSelection({ theme }: { theme: ThemeRecord }) {
  const [target, setTarget] = useState<'app' | 'terminal' | 'syntax'>(
    theme.definition.app ? 'app' : theme.definition.terminal ? 'terminal' : 'syntax',
  )
  const settings = useQuery({ queryKey: ['profile-settings'], queryFn: () => window.adeHost.settings.get() })
  const palettes = useQuery({ queryKey: ['palettes'], queryFn: () => window.adeHost.settings.palettes() })
  const saved = settings.data
  const id = theme.definition.id
  return (
    <Field>
      <FieldLabel htmlFor="theme-selection-target">Use theme for</FieldLabel>
      <FieldDescription>Preview this section with your saved choices before applying it.</FieldDescription>
      <NativeSelect
        id="theme-selection-target"
        value={target}
        onChange={(event) => {
          const value = event.target.value
          if (value === 'app' || value === 'terminal' || value === 'syntax') setTarget(value)
        }}
      >
        {theme.definition.app && (
          <NativeSelectOption value="app">
            {theme.definition.mode === 'light' ? 'Light' : 'Dark'} app
          </NativeSelectOption>
        )}
        {theme.definition.terminal && <NativeSelectOption value="terminal">Fixed terminal theme</NativeSelectOption>}
        {theme.definition.syntax && <NativeSelectOption value="syntax">Fixed syntax theme</NativeSelectOption>}
      </NativeSelect>
      {saved && palettes.data && (
        <AppearancePreview
          saved={saved}
          palettes={palettes.data.palettes}
          label="Preview and select theme"
          selection={{
            app_light_theme: target === 'app' && theme.definition.mode === 'light' ? id : saved.app_light_theme,
            app_dark_theme: target === 'app' && theme.definition.mode === 'dark' ? id : saved.app_dark_theme,
            terminal_binding: target === 'terminal' ? { kind: 'fixed', theme_id: id } : saved.terminal_binding,
            syntax_binding: target === 'syntax' ? { kind: 'fixed', theme_id: id } : saved.syntax_binding,
          }}
        />
      )}
      {(settings.error ?? palettes.error) && <FieldError>{(settings.error ?? palettes.error)?.message}</FieldError>}
    </Field>
  )
}

export function draftSource(definition: ThemeDefinition): string {
  const readable = JSON.stringify(definition, null, 2)
  return new TextEncoder().encode(readable).byteLength <= 256 * 1024 ? readable : JSON.stringify(definition)
}

export function ThemeContrastInspector({
  preview,
  definition,
  onFollow,
  editableRoles,
  onRepair,
}: {
  preview: ThemeDraftPreview
  definition: ThemeDefinition
  onFollow: (row: ContrastReportRow) => void
  editableRoles?: Set<string>
  onRepair?: (item: ContrastReportRow, replacement: string) => void
}) {
  const report = preview.valid ? inspectThemeContrast(preview, definition) : null
  return (
    <FieldSet>
      <FieldLegend>Contrast diagnostics</FieldLegend>
      <FieldDescription>
        Only valid drafts receive measured contrast ratios. Invalid drafts show shared validator diagnostics. WCAG
        thresholds: 4.5:1 for text, 3:1 for non-text. Diagnostics only, not accessibility certification. Inspecting does
        not change this theme or your saved appearance.
      </FieldDescription>
      <FieldGroup>
        {report
          ? report.rows.map((item) => {
              const section = item.section === 'diff' ? null : item.section
              const roleKey = section ? section + '-' + item.role : ''
              const canFocus = Boolean(section && editableRoles?.has(roleKey))
              return (
                <Field key={item.id} data-testid={'contrast-row-' + item.id}>
                  <Body>
                    {item.surface} — {item.state}
                  </Body>
                  <Body>
                    {section ? section + ' / ' : ''}
                    {item.role}
                  </Body>
                  <Body>
                    Source: {item.sourceValue ?? 'Not declared; inherited resolved value or unavailable'}; resolved:{' '}
                    {item.resolvedValue ?? 'unavailable'}
                  </Body>
                  <Body>
                    Foreground: {item.foreground ?? 'unavailable'}; surface: {item.background ?? 'unavailable'}
                  </Body>
                  <Body>
                    {item.ratio === null
                      ? 'Contrast unavailable'
                      : 'Contrast: ' + item.ratio.toFixed(2) + ' : 1; minimum ' + item.threshold + ' : 1'}
                    ; {item.alphaState}
                  </Body>
                  {item.reason && <Body>{item.reason}</Body>}
                  {item.supported && section && (!editableRoles || canFocus) && (
                    <Button size="sm" variant="outline" onClick={() => onFollow(item)}>
                      {editableRoles ? 'Focus editor field' : 'Create draft and edit role'}
                    </Button>
                  )}
                  {onRepair &&
                    editableRoles?.has(roleKey) &&
                    item.supported &&
                    item.ratio !== null &&
                    item.threshold !== null &&
                    item.ratio < item.threshold &&
                    (() => {
                      const replacement = findDraftContrastRepair(preview, item, report, definition)
                      return replacement ? (
                        <Button size="sm" variant="outline" onClick={() => onRepair?.(item, replacement)}>
                          Improve contrast in draft
                        </Button>
                      ) : null
                    })()}
                </Field>
              )
            })
          : null}
        {(report?.diagnostics ?? preview.diagnostics).map((diagnostic, index) => (
          <Field
            key={diagnostic.path + '-' + diagnostic.code + '-' + index}
            role={diagnostic.severity === 'error' ? 'alert' : undefined}
            data-testid="contrast-diagnostic"
          >
            <Body>
              {diagnostic.severity} — {diagnostic.code} · {diagnostic.path}
            </Body>
            <Body>
              {diagnostic.message} (line {diagnostic.line}, column {diagnostic.column})
            </Body>
          </Field>
        ))}
      </FieldGroup>
    </FieldSet>
  )
}

function contrastDraftSource(preview: ThemeDraftPreview, item: ContrastReportRow): string | null {
  if (item.section === 'diff' || !item.supported || !item.resolvedValue) return null
  const definition = structuredClone(preview.definition)
  const section = definition[item.section]
  if (!section) return null
  definition.id = 'user:contrast-' + crypto.randomUUID()
  definition.name = definition.name + ' contrast draft'
  definition.provenance = { ...definition.provenance, kind: 'user' }
  section.tokens[item.role] = item.resolvedValue
  return draftSource(definition)
}
export function ThemeDetails({
  theme,
  onEdit,
  onRemoved,
}: {
  theme: ThemeRecord
  onEdit: (source: string, focusRole?: { section: 'app' | 'terminal' | 'syntax'; role: string }) => void
  onRemoved: () => void
}) {
  const cache = useQueryClient()
  const [name, setName] = useState(theme.definition.name)
  const [copyId, setCopyId] = useState('')
  const [editingRevision, setEditingRevision] = useState(theme.revision)
  const inspection = useQuery({
    queryKey: ['theme-inspection', theme.definition.id, theme.revision],
    queryFn: () => window.adeHost.themes.previewDraft({ source: draftSource(theme.definition) }),
    staleTime: 0,
    retry: false,
  })
  const renamed = useMutation({
    mutationFn: () => window.adeHost.themes.rename(theme.definition.id, name, editingRevision),
    onSuccess: (result) => {
      if (result.committed && result.items[0]?.theme) setEditingRevision(result.items[0].theme.revision)
      void cache.invalidateQueries({ queryKey: ['theme-record'] })
      void cache.invalidateQueries({ queryKey: ['theme-library'] })
    },
  })
  const exported = useMutation({ mutationFn: () => window.adeHost.themes.export(theme.definition.id, theme.revision) })
  const file = useMutation({ mutationFn: () => window.adeHost.themes.saveFile(theme.definition.id, theme.revision) })
  const ghostty = useMutation({
    mutationFn: () => window.adeHost.themes.exportGhostty(theme.definition.id, theme.revision),
  })
  const ghosttyFile = useMutation({
    mutationFn: () => window.adeHost.themes.saveGhostty(theme.definition.id, theme.revision),
  })
  const ghosttyReport = ghostty.data?.theme.revision === theme.revision ? ghostty.data : undefined
  const bundled = theme.definition.provenance.kind === 'bundled'
  return (
    <FieldGroup>
      <Body>
        {theme.definition.id} — {theme.definition.mode}, revision {theme.revision}
      </Body>
      <Body>
        Origin: {theme.definition.provenance.kind}; source: {theme.definition.provenance.source ?? 'Locally authored'};
        version:{' '}
        {theme.definition.provenance.source_version ?? theme.definition.provenance.source_digest ?? 'Locally authored'}
      </Body>
      {theme.definition.provenance.author && <Body>Author: {theme.definition.provenance.author}</Body>}
      {theme.definition.provenance.license && <Body>License: {theme.definition.provenance.license}</Body>}
      {theme.definition.pack && (
        <Body>
          Pack: {theme.definition.pack.name} — {theme.definition.pack.id}
        </Body>
      )}
      <ThemeSelection theme={theme} />
      {inspection.error && <FieldError>Contrast preview unavailable: {errorMessage(inspection.error)}</FieldError>}
      {inspection.data && (
        <ThemeContrastInspector
          preview={inspection.data}
          definition={theme.definition}
          onFollow={(item) => {
            if (item.section === 'diff') return
            const source = contrastDraftSource(inspection.data!, item)
            if (source) onEdit(source, { section: item.section, role: item.role })
          }}
        />
      )}
      <ThemeRemovalDialog
        id={theme.definition.id}
        protectedTheme={bundled || theme.definition.provenance.kind === 'plugin'}
        onRemoved={onRemoved}
      />
      <Field>
        <FieldLabel htmlFor="theme-display-name">Theme display name</FieldLabel>
        <Input
          id="theme-display-name"
          value={name}
          disabled={bundled || renamed.isPending}
          onChange={(event) => setName(event.target.value)}
        />
        {!bundled && (
          <Body>
            Rename draft revision {editingRevision}; current revision {theme.revision}.
          </Body>
        )}
        {!bundled && editingRevision !== theme.revision && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setEditingRevision(theme.revision)
              renamed.reset()
            }}
          >
            Review latest revision
          </Button>
        )}
        <Button size="sm" disabled={bundled || renamed.isPending} onClick={() => renamed.mutate()}>
          Rename theme
        </Button>
        {renamed.error && <FieldError>{renamed.error.message}</FieldError>}
        {renamed.data && !renamed.data.committed && (
          <FieldError>
            {renamed.data.items
              .flatMap((item) =>
                item.diagnostics
                  .filter((diagnostic) => diagnostic.severity === 'error')
                  .map((diagnostic) => diagnostic.message),
              )
              .join(' ')}
          </FieldError>
        )}
      </Field>
      {!bundled && (
        <Button size="sm" variant="outline" onClick={() => onEdit(draftSource(theme.definition))}>
          Edit definition
        </Button>
      )}
      <Field>
        <FieldLabel htmlFor="theme-copy-id">Custom copy ID</FieldLabel>
        <FieldDescription>
          Choose a distinct namespaced ID, such as user:my-theme. The draft retains source attribution.
        </FieldDescription>
        <Input id="theme-copy-id" value={copyId} onChange={(event) => setCopyId(event.target.value)} />
        <Button
          size="sm"
          variant="outline"
          disabled={!copyId || copyId === theme.definition.id}
          onClick={() =>
            onEdit(
              draftSource({
                ...theme.definition,
                id: copyId,
                provenance: { ...theme.definition.provenance, kind: 'user' },
              }),
            )
          }
        >
          Create custom draft
        </Button>
      </Field>
      <Button size="sm" variant="outline" disabled={exported.isPending} onClick={() => exported.mutate()}>
        Export definition
      </Button>
      {exported.error && <FieldError>{exported.error.message}</FieldError>}
      <Button size="sm" variant="outline" disabled={file.isPending} onClick={() => file.mutate()}>
        Export definition to file
      </Button>
      {file.error && <FieldError>{file.error.message}</FieldError>}
      {file.isSuccess && (
        <Body role="status">
          {file.data ? `Exported revision ${file.data.revision} to ${file.data.path}.` : 'File export canceled.'}
        </Body>
      )}
      {exported.data && (
        <Field>
          <FieldLabel htmlFor="exported-theme">Exported ADE definition</FieldLabel>
          <FieldDescription>
            All supported colors are included from revision {exported.data.theme.revision}. Copy this data into an ADE
            theme file.
          </FieldDescription>
          <Textarea id="exported-theme" readOnly value={exported.data.source} rows={6} />
        </Field>
      )}
      {theme.definition.terminal && (
        <Field>
          <Button
            size="sm"
            variant="outline"
            disabled={ghostty.isPending || ghosttyFile.isPending}
            onClick={() => {
              ghosttyFile.reset()
              ghostty.mutate()
            }}
          >
            Export Ghostty colors
          </Button>
          {ghostty.error && <FieldError>{errorMessage(ghostty.error)}</FieldError>}
          {ghosttyReport && (
            <>
              <FieldLabel htmlFor="ghostty-export-source">Exported Ghostty colors</FieldLabel>
              <Textarea id="ghostty-export-source" readOnly value={ghosttyReport.source} rows={6} />
              <FieldDescription>
                Colors come from definition revision {ghosttyReport.theme.revision}. Review the omitted data before
                exporting.
              </FieldDescription>
              <ul>
                {ghosttyReport.omissions.map((omission) => (
                  <li key={omission.path}>
                    <Body>{omission.path}</Body>
                    <Body>{omission.reason}</Body>
                  </li>
                ))}
              </ul>
            </>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={!ghosttyReport || ghostty.isPending || ghosttyFile.isPending}
            onClick={() => ghosttyFile.mutate()}
          >
            Export Ghostty colors to file
          </Button>
          {ghosttyFile.error && (
            <FieldError>{errorMessage(ghosttyFile.error)} Review the current definition before retrying.</FieldError>
          )}
          {ghosttyFile.isSuccess && (
            <Body role="status">
              {ghosttyFile.data
                ? `Exported Ghostty revision ${ghosttyFile.data.revision} to ${ghosttyFile.data.path}.`
                : 'Ghostty file export canceled.'}
            </Body>
          )}
        </Field>
      )}
    </FieldGroup>
  )
}
