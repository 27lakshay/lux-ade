export type OpenCodeInstallation = {
  readonly found: boolean
  readonly available: boolean
  readonly command?: string
  readonly source?: 'ADE_OPENCODE_BIN' | 'PATH' | 'installer'
  readonly version?: string | null
  readonly reason?: string
}

export declare function inspectOpenCode(env?: NodeJS.ProcessEnv): OpenCodeInstallation
