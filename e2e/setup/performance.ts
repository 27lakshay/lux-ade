import type { FullConfig } from '@playwright/test'

export default function setup(config: FullConfig): void {
  if (config.workers !== 1 || config.projects.some((project) => project.retries !== 0))
    throw new Error('Performance requires exactly one worker and zero retries')
  if (!['0', '1', undefined].includes(process.env.ADE_PERFORMANCE_DIAGNOSTICS))
    throw new Error('ADE_PERFORMANCE_DIAGNOSTICS must be 0 or 1')
}
