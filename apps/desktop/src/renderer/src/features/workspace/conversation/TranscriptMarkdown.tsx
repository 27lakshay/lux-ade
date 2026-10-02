import { Children, isValidElement, useEffect, useState, type ComponentProps, type ReactNode } from 'react'
import { getSingletonHighlighter } from 'shiki'
import { Streamdown, type Components } from 'streamdown'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import { adeCodeTheme } from '../../code/code-theme'

const LANGUAGES = {
  bash: 'bash',
  javascript: 'javascript',
  json: 'json',
  python: 'python',
  rust: 'rust',
  typescript: 'typescript',
} as const

const LANGUAGE_ALIASES: Record<string, keyof typeof LANGUAGES> = {
  bash: 'bash',
  sh: 'bash',
  js: 'javascript',
  javascript: 'javascript',
  json: 'json',
  py: 'python',
  python: 'python',
  rs: 'rust',
  rust: 'rust',
  ts: 'typescript',
  tsx: 'typescript',
  typescript: 'typescript',
}

type PreProps = ComponentProps<'pre'> & { node?: unknown }

function CodeScrollArea({ children }: { children: ReactNode }) {
  return (
    <ScrollArea className="w-full min-w-0 max-w-full">
      {children}
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  )
}

function HighlightedCode({ code, language }: { code: string; language: string }) {
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void getSingletonHighlighter({ themes: [adeCodeTheme], langs: Object.values(LANGUAGES) })
      .then((highlighter) => {
        if (!active) return
        try {
          setHtml(highlighter.codeToHtml(code, { lang: language, theme: adeCodeTheme.name! }))
        } catch {
          setHtml(null)
        }
      })
      .catch(() => {
        if (active) setHtml(null)
      })
    return () => {
      active = false
    }
  }, [code, language])

  return html ? (
    <CodeScrollArea>
      <div className="w-max min-w-full" dangerouslySetInnerHTML={{ __html: html }} />
    </CodeScrollArea>
  ) : (
    <CodeScrollArea>
      <pre className="w-max min-w-full rounded-md bg-panel px-3 py-2">
        <code>{code}</code>
      </pre>
    </CodeScrollArea>
  )
}

function HighlightPre({ children, node: _node, ...props }: PreProps) {
  const preChildren = Children.toArray(children)
  const codeNode = preChildren.length === 1 && isValidElement(preChildren[0]) ? preChildren[0] : null
  if (!codeNode) {
    return (
      <CodeScrollArea>
        <pre {...props} className={['w-max min-w-full whitespace-pre', props.className].filter(Boolean).join(' ')}>
          {children}
        </pre>
      </CodeScrollArea>
    )
  }
  const codeProps = codeNode.props as { className?: string; children?: ReactNode }
  const languageToken = codeProps.className?.match(/(?:^|\s)language-([^\s]+)/)?.[1]?.toLowerCase()
  const language = languageToken ? LANGUAGE_ALIASES[languageToken] : undefined
  const codeChildren = Children.toArray(codeProps.children)
  const code = codeChildren.every((child) => typeof child === 'string' || typeof child === 'number')
    ? codeChildren
        .map((child) => (typeof child === 'string' ? child : String(child)))
        .join('')
        .replace(/\n$/, '')
    : null
  if (!language || code === null) {
    return (
      <CodeScrollArea>
        <pre {...props} className={['w-max min-w-full whitespace-pre', props.className].filter(Boolean).join(' ')}>
          {children}
        </pre>
      </CodeScrollArea>
    )
  }
  return <HighlightedCode code={code} language={LANGUAGES[language]} />
}

const components: Components = { pre: HighlightPre }

export function TranscriptMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <Streamdown
      components={components}
      mode="streaming"
      isAnimating={streaming}
      className="min-w-0 [overflow-wrap:anywhere]"
    >
      {text}
    </Streamdown>
  )
}
