// The installable OpenCode plugin artifact (artifact/): this package's files and its
// production dependency closure, including the pinned Effect runtime.
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageProviderPlugin } from '../../../scripts/package-provider-plugin.mjs'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
await packageProviderPlugin({
  packageName: '@ade/opencode-provider',
  packageDirectory: 'plugins/opencode',
  include: ['dist', 'ade-plugin.json', 'LICENSE-opencode', 'PROVENANCE.md', 'README.md'],
  output: join(packageRoot, 'artifact'),
})
