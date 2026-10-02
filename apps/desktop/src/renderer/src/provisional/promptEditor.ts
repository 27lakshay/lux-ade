import type { RefObject } from 'react'
import StarterKit from '@tiptap/starter-kit'
import { useEditor } from '@tiptap/react'

/** The prompt editor: plain text, Enter sends, Shift+Enter adds a line, each change is saved. */
export function usePromptEditor(
  promptId: string,
  submitRef: RefObject<() => Promise<void>>,
  scheduleSaveRef: RefObject<(text: string) => void>,
) {
  return useEditor({
    extensions: [StarterKit],
    content: '',
    editable: false,
    editorProps: {
      attributes: {
        id: promptId,
        role: 'textbox',
        'aria-label': 'Prompt',
        'aria-multiline': 'true',
        class:
          'min-h-12 max-h-48 overflow-y-auto rounded-md border border-input bg-background px-3 py-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
      },
      handleKeyDown: (_view, event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return false
        event.preventDefault()
        void submitRef.current()
        return true
      },
    },
    onUpdate: ({ editor: updated }) => scheduleSaveRef.current(updated.getText({ blockSeparator: '\n' })),
  })
}
