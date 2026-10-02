// The plugin's provider entry point (`entry_points.provider`). ADE starts it in the
// workspace root and speaks the public provider worker protocol on stdio.
import { runProviderWorker } from '@ade/provider-sdk/node'
import { openCodeProvider } from './provider.js'

runProviderWorker(openCodeProvider())
