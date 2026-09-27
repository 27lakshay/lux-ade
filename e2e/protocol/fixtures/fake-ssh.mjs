#!/usr/bin/env node
// A fake OpenSSH client for remote-host E2E. It implements the subset ADE
// uses, against scratch "remote host" roots on this machine:
//
// - `ssh -G -- TARGET` prints the resolved hostname and port.
// - `ssh [-o ...] -T -- TARGET COMMAND` checks the host key the way
//   StrictHostKeyChecking=yes does, then runs COMMAND with `/bin/sh -c` inside
//   the host's root, with the host's own HOME and PATH and none of the
//   caller's environment. stdin, stdout, stderr and the exit code pass through.
// - `ssh [-o ...] -N -T -L LOCAL_SOCKET:REMOTE_SOCKET -- TARGET` forwards a
//   Unix socket until it is signalled or the host's link goes down.
// - `ssh [-o ...] -N -T -L 127.0.0.1:PORT:HOST:HOSTPORT -- TARGET` forwards a
//   loopback TCP port to HOST:HOSTPORT as the remote host sees it. The scratch
//   hosts share this machine's network, so HOST must be a loopback address.
// - Installed as `ssh-keyscan`, it prints the host's current key.
//
// Each host has a fixed key in `<root>/host_key.pub` that a test can replace.
// `<root>/link-down` makes the host unreachable and drops open forwards.
// `<root>/hold-commands` holds every remote command until it is removed.
// Every invocation is appended to `<bin>/calls.jsonl`. Hosts are read from
// `<bin>/hosts.json`, next to this script, never from the environment. With
// no UserKnownHostsFile, `<bin>/user_known_hosts` stands in for the user's
// known_hosts; the real one is never read.
import { spawn } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'

import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const bin = dirname(fileURLToPath(import.meta.url))
const config = JSON.parse(readFileSync(join(bin, 'hosts.json'), 'utf8'))
const program = basename(process.argv[1])
const argv = process.argv.slice(2)

function log(entry) {
  appendFileSync(join(bin, 'calls.jsonl'), `${JSON.stringify({ at: Date.now(), pid: process.pid, program, ...entry })}\n`)
}

function die(message, code = 255) {
  process.stderr.write(`${message}\n`)
  log({ args: argv, exit: code, stderr: message })
  process.exit(code)
}

function lookup(target) {
  const name = target.includes('@') ? target.slice(target.lastIndexOf('@') + 1) : target
  const host = config.hosts[name]
  return host ? { name, ...host } : null
}

function currentKey(host) {
  return readFileSync(join(host.root, 'host_key.pub'), 'utf8').trim().split(/\s+/).slice(0, 2).join(' ')
}

const linkDown = (host) => existsSync(join(host.root, 'link-down'))

if (program === 'ssh-keyscan') {
  const target = argv[argv.length - 1]
  const host = lookup(target)
  log({ args: argv })
  if (!host || linkDown(host)) process.exit(1)
  process.stdout.write(`# ${target}:22 SSH-2.0-FakeSSH\n${target} ${currentKey(host)}\n`)
  process.exit(0)
}

// Parse the ssh command line: options, then the destination, then the command.
const options = {}
const flags = new Set()
const forwards = []
let index = 0
while (index < argv.length) {
  const word = argv[index]
  if (word === '--') { index++; break }
  if (!word.startsWith('-')) break
  if (word === '-o') {
    const [key, ...value] = argv[index + 1].split('=')
    const name = key.toLowerCase()
    // As in ssh, the first value given for an option wins.
    if (!(name in options)) options[name] = value.join('=')
    index += 2
  } else if (word === '-L') {
    forwards.push(argv[index + 1])
    index += 2
  } else {
    for (const flag of word.slice(1)) flags.add(flag)
    index++
  }
}
const target = argv[index]
const command = argv.slice(index + 1).join(' ')
if (!target) die('usage: ssh [options] destination [command]')
const host = lookup(target)

if (flags.has('G')) {
  log({ args: argv })
  const name = host ? host.name : target
  process.stdout.write(`host ${name}\nhostname ${name}\nport 22\nproxycommand none\n`)
  process.exit(0)
}

if (!host) die(`ssh: Could not resolve hostname ${target}: nodename nor servname provided, or not known`)
if (linkDown(host)) die(`ssh: connect to host ${host.name} port 22: Connection refused`)

// Host key verification, as StrictHostKeyChecking=yes performs it.
const key = currentKey(host)
const [keyType] = key.split(' ')
const algorithms = options.hostkeyalgorithms
if (algorithms && !algorithms.split(',').some((algorithm) => algorithm === keyType ||
  (keyType === 'ssh-rsa' && algorithm.startsWith('rsa-sha2-')))) {
  die(`Unable to negotiate with ${host.name} port 22: no matching host key type found. Their offer: ${keyType}`)
}
const alias = options.hostkeyalias ?? host.name
// Without UserKnownHostsFile, the lab's own file stands in for ~/.ssh/known_hosts; the real one is never read.
const knownHostsFiles = (options.userknownhostsfile ?? join(bin, 'user_known_hosts'))
  .split(/\s+/).filter(Boolean)
const known = []
for (const file of knownHostsFiles) {
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { continue }
  for (const line of text.split('\n')) {
    const [names, type, blob] = line.trim().split(/\s+/)
    if (names && type && blob && names.split(',').includes(alias)) known.push(`${type} ${blob}`)
  }
}
const label = keyType.replace(/^ssh-/, '').replace(/-.*$/, '').toUpperCase()
if (known.length === 0) {
  if (options.stricthostkeychecking === 'yes') {
    die(`No ${label} host key is known for ${alias} and you have requested strict checking.\r\nHost key verification failed.`)
  }
} else if (!known.includes(key)) {
  die('@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n' +
    '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\r\n' +
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n' +
    `Host key for ${alias} has changed and you have requested strict checking.\r\nHost key verification failed.`)
}

const remoteEnvironment = { ...host.env }

if (flags.has('N')) {
  // Unix socket forwards only; ADE forwards the daemon socket this way.
  const sockets = new Set()
  const servers = []
  const mask = Number.parseInt(options.streamlocalbindmask ?? '0177', 8)
  let pending = forwards.length
  const ready = () => {
    if (--pending === 0) log({ args: argv, forwarding: forwards })
  }
  for (const spec of forwards) {
    const tcp = /^127\.0\.0\.1:(\d+):(127(?:\.\d{1,3}){3}|\[::1\]):(\d+)$/.exec(spec)
    const split = spec.indexOf(':')
    const local = tcp ? null : spec.slice(0, split)
    const remote = tcp ? { host: tcp[2].replace(/^\[|\]$/g, ''), port: Number(tcp[3]) } : spec.slice(split + 1)
    if (!tcp && (!local.startsWith('/') || !remote.startsWith('/'))) {
      die(`fake ssh forwards Unix sockets and loopback TCP ports only: ${spec}`)
    }
    if (local && options.streamlocalbindunlink === 'yes') rmSync(local, { force: true })
    const server = createServer((client) => {
      const upstream = createConnection(remote)
      sockets.add(client)
      sockets.add(upstream)
      const close = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream) }
      client.on('error', close)
      upstream.on('error', close)
      client.on('close', close)
      upstream.on('close', close)
      client.pipe(upstream)
      upstream.pipe(client)
    })
    server.once('error', (error) => die(`bind [${local ?? spec}]: ${error.message}\r\nCould not request local forwarding.`))
    if (tcp) server.listen(Number(tcp[1]), '127.0.0.1', ready)
    else {
      server.listen(local, () => {
        chmodSync(local, 0o777 & ~mask)
        ready()
      })
    }
    servers.push({ server, local })
  }
  const shutdown = (code, message) => {
    for (const socket of sockets) socket.destroy()
    for (const { server, local } of servers) { server.close(); if (local) rmSync(local, { force: true }) }
    if (message) process.stderr.write(`${message}\n`)
    log({ args: argv, exit: code, stderr: message ?? null })
    process.exit(code)
  }
  process.on('SIGTERM', () => shutdown(0))
  process.on('SIGINT', () => shutdown(0))
  // The link is cut from outside by creating the flag file; drop every
  // forwarded connection as a network loss would.
  setInterval(() => {
    if (linkDown(host)) shutdown(255, `Connection to ${host.name} closed by remote host.`)
  }, 25)
} else {
  const run = () => {
    log({ args: argv, remote_command: command })
    const child = spawn('/bin/sh', ['-c', command], { cwd: remoteEnvironment.HOME, env: remoteEnvironment,
      stdio: 'inherit' })
    child.on('exit', (code, signal) => {
      log({ args: argv, remote_command: command, exit: code, signal })
      process.exit(code ?? 255)
    })
  }
  const hold = join(host.root, 'hold-commands')
  if (existsSync(hold)) {
    log({ args: argv, held: command })
    const timer = setInterval(() => {
      if (!existsSync(hold)) { clearInterval(timer); run() }
    }, 25)
  } else {
    run()
  }
}
