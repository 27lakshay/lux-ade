#!/usr/bin/env node
// @ts-check
// Entry point of the backend plugin host process (F057, decision D05).
//
// The daemon starts `node host.mjs` for one activation generation of one plugin
// and speaks JSON-RPC over stdio (see protocol.mjs). The host runs under plain
// Node LTS and imports nothing from Electron, so a remote host can run it too.
//
// stdout carries protocol frames only. Plugin code that writes to stdout or the
// console is redirected to stderr, which the daemon keeps as a bounded log.
// The host exits when stdin closes, so a daemon that dies takes its hosts with it.
import { createInterface } from 'node:readline'
import { createHost } from './protocol.mjs'

const frames = process.stdout.write.bind(process.stdout)
const stderr = process.stderr.write.bind(process.stderr)

/** @param {unknown} chunk @param {...unknown} rest */
function toStderr(chunk, ...rest) {
  const callback = rest.find((item) => typeof item === 'function')
  return stderr(/** @type {string | Uint8Array} */ (chunk), /** @type {(error?: Error | null) => void} */ (callback))
}

process.stdout.write = toStderr
for (const name of /** @type {const} */ (['log', 'info', 'debug', 'trace', 'dir'])) {
  console[name] = (...parts) => console.error(...parts)
}

/** @param {unknown} response */
function send(response) {
  frames(`${JSON.stringify(response)}\n`)
}

/** @param {string} kind @param {unknown} error */
function fatal(kind, error) {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  stderr(`plugin host ${kind}: ${detail}\n`)
  // A plugin failure the host cannot attribute to a request ends the process;
  // the daemon observes the exit and applies its restart backoff.
  process.exit(70)
}

process.on('uncaughtException', (error) => fatal('uncaught exception', error))
process.on('unhandledRejection', (error) => fatal('unhandled rejection', error))

const host = createHost()
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line) => {
  if (line.trim() === '') return
  host.handleLine(line).then(
    (response) => {
      if (response) send(response)
    },
    (error) => fatal('handler failure', error),
  )
})
lines.on('close', () => process.exit(0))
