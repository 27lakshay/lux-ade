// Runs an author's ProviderFactory module under the SDK's own runner, so the conformance harness
// can check a factory without a separate worker entry point: `conformance-host <module> [export]`.
import { pathToFileURL } from 'node:url'
import { runProviderWorker } from './node.js'
import type { ProviderFactory } from './provider.js'

const [modulePath, exportName = 'default'] = process.argv.slice(2)
if (!modulePath) throw new Error('Usage: conformance-host <factory module> [export name]')
const loaded = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>
const exported = loaded[exportName]
const factory = (typeof exported === 'function' ? await (exported as () => unknown)() : exported) as
  | ProviderFactory<unknown>
  | undefined
if (!factory || typeof factory !== 'object' || !('descriptor' in factory))
  throw new Error(`${modulePath} does not export a ProviderFactory as ${exportName}`)
runProviderWorker(factory)
