import { Ellipsis, FileCode, Folder } from 'lucide-react'
import { IconButton } from './IconButton'
import { LEADING_SLOT, STRIP_H, TOGGLE_SIZE } from '../layout'

const TREE: [string, string | null, boolean?][] = [
  ['apps/desktop/src/renderer/src', null],
  ['services.tsx', '+24 −6', true],
  ['main.tsx', '+8 −2'],
  ['style.css', '+12 −0'],
  ['crates/ade-daemon/src', null],
  ['services.rs', '+146 −31'],
  ['store.rs', '+62 −9'],
  ['e2e/specs', null],
  ['desktop-services.spec.ts', '+60 −0'],
]

// `side` is where the panel sits: its tab strip leaves room for the title-bar controls there (the
// traffic lights and sidebar toggle on the left, the side-panel toggle on the right).
export function ChangesPanel({ side }: { side: 'left' | 'right' }) {
  return (
    <div className="flex h-full flex-col">
      <div className="drag flex shrink-0 items-center gap-0.5 px-1.5" style={{ height: STRIP_H }}>
        {side === 'left' ? <span className="shrink-0" style={{ width: LEADING_SLOT }} /> : null}
        {[
          ['Changes', '7', true],
          ['Files', '', false],
          ['Preview', '', false],
        ].map(([l, c, a]) => (
          <button
            key={l as string}
            role="tab"
            type="button"
            aria-selected={a as boolean}
            className={`flex h-[30px] items-center gap-1.5 rounded-md px-2.5 text-[12px] ${a ? 'bg-selected font-medium' : 'text-fg-muted'}`}
          >
            {l as string}
            {c ? <span className="text-[11px] text-fg-muted">{c as string}</span> : null}
          </button>
        ))}
        <div className="flex-1" />
        <IconButton label="Panel menu">
          <Ellipsis size={16} />
        </IconButton>
        {side === 'right' ? <span className="shrink-0" style={{ width: TOGGLE_SIZE }} /> : null}
      </div>
      <div className="flex items-center gap-2 px-3.5 pb-2.5 pt-1 text-[12px]">
        <span className="flex-1 text-fg-muted">Uncommitted</span>
        <span className="font-mono text-success">+312</span>
        <span className="font-mono text-destructive">−48</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-1.5">
        {TREE.map(([name, diff, sel]) => {
          const [a, d] = diff ? diff.split(' ') : []
          return (
            <div
              key={name}
              className={`flex items-center gap-2 rounded-md py-[5px] pr-2 ${diff ? 'pl-6' : 'pl-2'} ${sel ? 'bg-selected' : ''}`}
            >
              {diff ? <FileCode size={14} className="text-fg-muted" /> : <Folder size={14} className="text-fg-muted" />}
              <span className={`flex-1 truncate text-[12px] ${diff ? '' : 'font-mono text-fg-muted'}`}>{name}</span>
              {diff ? (
                <>
                  <span className="font-mono text-[11px] text-success">{a}</span>
                  <span className="font-mono text-[11px] text-destructive">{d}</span>
                </>
              ) : null}
            </div>
          )
        })}
      </div>
      <div className="flex gap-1.5 p-1.5">
        <button
          type="button"
          className="flex h-8 flex-1 items-center justify-center rounded-md bg-selected font-medium"
        >
          Review changes
        </button>
        <button
          type="button"
          className="flex h-8 flex-1 items-center justify-center rounded-md bg-fg font-medium text-inverse"
        >
          Commit…
        </button>
      </div>
    </div>
  )
}
