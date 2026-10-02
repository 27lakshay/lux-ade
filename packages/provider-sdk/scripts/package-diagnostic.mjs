// The SDK diagnostic example as a self-contained plugin artifact (dist/diagnostic-plugin).
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageProviderPlugin } from '../../../scripts/package-provider-plugin.mjs'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
await packageProviderPlugin({
  packageName: '@ade/provider-sdk',
  packageDirectory: 'packages/provider-sdk',
  include: ['dist', 'examples'],
  output: join(packageRoot, 'dist/diagnostic-plugin'),
  manifest: 'examples/ade-plugin.json',
})
