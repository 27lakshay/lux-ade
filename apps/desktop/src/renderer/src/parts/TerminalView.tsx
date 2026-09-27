// Static stand-in for an xterm.js terminal. The real one keeps its output outside React state.
const OUTPUT: Record<string, string[]> = {
  'pnpm dev': [
    '$ pnpm dev',
    '',
    '> @ade/desktop@0.1.0 dev',
    '> electron-vite dev',
    '',
    'vite v7.3.6 building for development...',
    '✓ main process built in 41ms',
    '✓ preload built in 6ms',
    '',
    '  ➜  Local:   http://localhost:5173/',
    '',
    'starting electron app...',
  ],
  'cargo test': [
    '$ cargo test -p ade-daemon',
    '   Compiling ade-daemon v0.1.0',
    '    Finished `test` profile in 8.42s',
    '     Running unittests src/lib.rs',
    '',
    'running 48 tests',
    'test services::assigned_port_is_not_listening ... ok',
    'test services::bind_marks_listening ... ok',
    'test store::round_trips_sessions ... ok',
    '',
    'test result: ok. 48 passed; 0 failed',
  ],
}

export function TerminalView({ title }: { title: string }) {
  const lines = OUTPUT[title] ?? [`$ ${title}`]
  return (
    <div className="h-full overflow-hidden px-4 pt-2 font-mono text-[12px] leading-[1.6] text-fg">
      {lines.map((line, i) => (
        <div key={i} className={line.startsWith('$') ? 'text-fg' : 'text-fg-muted'}>
          {line || ' '}
        </div>
      ))}
      <div className="mt-0.5 h-4 w-2 bg-fg-muted" aria-hidden />
    </div>
  )
}
