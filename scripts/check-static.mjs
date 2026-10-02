// Static and in-process validation. Full application acceptance adds protocol and desktop E2E.
import { analysisEvidence } from './check-analysis.mjs'
import { nodeTestGlobs, pythonChecks } from './test-catalog.mjs'
import { selectStaticStages } from './static-stage-groups.mjs'
import { createRun, runStages } from './run-stages.mjs'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--group'))
  throw new Error('Use --group javascript or --group native, or omit it for the complete gate')
const group = args[1] ?? 'all'
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const cargo = ['node', 'scripts/cargo.mjs']
const features = ['--features', 'ade-runtime/native-terminal']
const directory = process.env.ADE_STATIC_REPORT_DIR ?? createRun(root, 'static')
// Parent benchmark runs may supply a fresh directory.
mkdirSync(directory, { recursive: true })
const reportFile = (name) => resolve(directory, name)
const nextestConfig = reportFile('nextest.toml')
const originalNextest = readFileSync(resolve(root, '.config/nextest.toml'), 'utf8')
const junitSetting = 'path = "junit.xml"'
if (originalNextest.split(junitSetting).length !== 2)
  throw new Error('Expected one nextest JUnit path; update run-specific reporting for the changed configuration')
writeFileSync(
  nextestConfig,
  originalNextest.replace(
    junitSetting,
    `path = ${JSON.stringify(reportFile('nextest.xml'))}\nreport-skipped = "ignored"`,
  ),
)
const steps = [
  ['rustfmt', [...cargo, 'fmt', '--all', '--check']],
  // Nx schedules independent repository checks; each retains its own fresh stage report.
  [
    'static analysis',
    ['pnpm', 'check:analysis'],
    {
      env: { ADE_STATIC_REPORT_DIR: directory },
      after: () => analysisEvidence(directory),
    },
  ],
  ['nx graph', ['pnpm', 'nx:check']],
  // TypeScript and JavaScript formatting (.oxfmtrc.json).
  ['oxfmt', ['pnpm', 'format:check']],
  // The committed packages/contracts must match the Rust contract types.
  ['contract check', ['pnpm', 'contract:check']],
  ['theme defaults', ['node', 'scripts/generate-theme-css.mjs', '--check']],
  ['architecture', ['python3', 'scripts/check_architecture.py']],
  // Unique checks retained from the older shell gate, shared with discovery.
  ...pythonChecks.map((file) => [
    file,
    file === 'test_native_accessibility.py'
      ? ['python3', `scripts/${file}`]
      : ['python3', 'scripts/run_python_tests.py', file, reportFile(`${file}.json`)],
    file === 'test_native_accessibility.py' ? {} : { reports: [reportFile(`${file}.json`)] },
  ]),
  // Dependent packages typecheck against the SDK's built declarations.
  ['sdk build', ['pnpm', 'build:sdk']],
  ['typecheck', ['pnpm', 'typecheck']],
  // The SDK was built before typecheck; consumers reuse that immutable output.
  ['cli build', ['pnpm', 'exec', 'nx', 'run', '@ade/cli:build']],
  ['desktop build', ['pnpm', 'exec', 'nx', 'run', '@ade/desktop:build']],
  // In-process tests of pure TypeScript cores, beside their modules.
  [
    'js pure tests',
    [
      'node',
      '--test',
      ...(process.env.ADE_TEST_WORKERS ? [`--test-concurrency=${process.env.ADE_TEST_WORKERS}`] : []),
      '--test-reporter=spec',
      '--test-reporter=junit',
      '--test-reporter-destination=stdout',
      `--test-reporter-destination=${reportFile('node.xml')}`,
      ...nodeTestGlobs,
    ],
    { reports: [reportFile('node.xml')] },
  ],
  [
    'provider tests',
    ['pnpm', 'test:providers'],
    {
      env: { ADE_PROVIDER_REPORT_DIR: reportFile('providers') },
      reports: ['claude', 'opencode', 'omp', 'acp'].map((name) => reportFile(`providers/provider-${name}.xml`)),
    },
  ],
  // Renderer stores and components, in headless Chromium (apps/desktop/vitest.config.ts).
  [
    'renderer tests',
    ['pnpm', '--filter', '@ade/desktop', 'test'],
    { env: { ADE_BROWSER_REPORT_DIR: reportFile('browser') }, reports: [reportFile('browser/vitest.json')] },
  ],
  ['clippy', [...cargo, 'clippy', '--locked', '--workspace', ...features, '--all-targets', '--', '-D', 'warnings']],
  [
    'test discovery',
    ['pnpm', 'exec', 'nx', 'run', 'lux-ade-workspace:discovery'],
    {
      env: { ADE_DISCOVERY_REPORT: reportFile('discovery.json') },
      after: () => {
        const native = JSON.parse(readFileSync(reportFile('discovery.json'), 'utf8'))
        return { nativeReport: 'discovery.json', rustTests: native.rustTests, ignoredRust: native.ignoredRust }
      },
    },
  ],
  [
    'legacy rust tests',
    [
      ...cargo,
      'nextest',
      'run',
      '--config-file',
      nextestConfig,
      '--locked',
      '--workspace',
      ...features,
      '--profile',
      'ci',
    ],
    {
      reports: [reportFile('nextest.xml')],
    },
  ],
  // nextest does not run doctests; preserve the older shell gate's documentation checks.
  ['rust doctests', [...cargo, 'test', '--locked', '--workspace', ...features, '--doc']],
]

const toolPaths = [resolve(root, '.ade/tools/bin'), join(homedir(), '.cargo/bin'), '/opt/homebrew/opt/rustup/bin']
const env = { ...process.env, PATH: [...toolPaths.filter(existsSync), process.env.PATH ?? ''].join(':') }
process.exitCode = await runStages(selectStaticStages(steps, group), { root, env, directory })
