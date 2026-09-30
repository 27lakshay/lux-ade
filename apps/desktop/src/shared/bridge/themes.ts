import type {
  GhosttyThemeExport,
  GhosttyThemeValidateRequest,
  GhosttyThemeValidation,
  ThemeDraftPreview,
  ThemeDraftPreviewRequest,
  ThemeDiagnostic,
  ThemeExport,
  ThemeFileValidation,
  ThemeInstallItem,
  ThemeInstallation,
  ThemeInspectResponse,
  ThemeLibrary,
  ThemePackExport,
  ThemePackExportRequest,
  ThemePreview,
  ThemePreviewRequest,
  ThemeRemoval,
  ThemeRemovalPlan,
  ThemeValidationResponse,
  WarpThemeValidateRequest,
  WarpThemeValidation,
} from '@ade/contracts'
import type { GhosttyThemeFileExport, ThemeFileExport, ThemePackFileExport } from '@ade/client'

export interface ThemeSourceFile {
  path: string
  source: string | null
  error: string | null
}

/** A window-owned snapshot. Unusable saves carry diagnostics, never replacement draft text. */
export interface ThemeLinkedFile extends ThemeSourceFile {
  linkId: string
  sequence: number
  diagnostics: ThemeDiagnostic[]
  validation: ThemeValidationResponse | null
}

export interface ThemesBridge {
  linkFile(): Promise<ThemeLinkedFile | null>
  unlinkFile(linkId?: string): Promise<void>
  onLinkedFile(listener: (file: ThemeLinkedFile) => void): () => void
  exportGhostty(id: string, expectedRevision: number): Promise<GhosttyThemeExport>
  saveGhostty(id: string, expectedRevision: number): Promise<GhosttyThemeFileExport | null>
  chooseGhosttyFile(): Promise<ThemeSourceFile | null>
  validateGhostty(request: Omit<GhosttyThemeValidateRequest, 'op'>): Promise<GhosttyThemeValidation>
  chooseWarpFile(): Promise<ThemeSourceFile | null>
  validateWarp(request: Omit<WarpThemeValidateRequest, 'op'>): Promise<WarpThemeValidation>
  exportPack(request: Omit<ThemePackExportRequest, 'op'>): Promise<ThemePackExport>
  savePack(request: Omit<ThemePackExportRequest, 'op'>): Promise<ThemePackFileExport | null>
  validateFile(source: string): Promise<ThemeFileValidation>
  saveFile(id: string, expectedRevision: number): Promise<ThemeFileExport | null>
  preview(request: Omit<ThemePreviewRequest, 'op'>): Promise<ThemePreview>
  previewDraft(request: Omit<ThemeDraftPreviewRequest, 'op'>): Promise<ThemeDraftPreview>
  chooseFiles(): Promise<ThemeSourceFile[]>
  /** Parse and normalize without changing the installed library or appearance. */
  validate(source: string): Promise<ThemeValidationResponse>
  list(afterId?: string): Promise<ThemeLibrary>
  inspect(id: string): Promise<ThemeInspectResponse>
  install(items: ThemeInstallItem[]): Promise<ThemeInstallation>
  rename(id: string, name: string, expectedRevision: number): Promise<ThemeInstallation>
  export(id: string, expectedRevision?: number): Promise<ThemeExport>
  removal(id: string, afterKey?: string): Promise<ThemeRemovalPlan>
  remove(id: string, expectedRevision: number, expectedAppearanceRevision: number): Promise<ThemeRemoval>
}
