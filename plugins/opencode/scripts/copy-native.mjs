// The native OpenCode protocol modules are JavaScript with typed boundaries beside
// them; the TypeScript build emits the Effect layer, and this copies the modules
// and their declarations.
import { cpSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
for (const name of readdirSync(join(root, 'src/native'))) {
  if (name.endsWith('.mjs') || name.endsWith('.d.mts'))
    cpSync(join(root, 'src/native', name), join(root, 'dist/native', name))
}
