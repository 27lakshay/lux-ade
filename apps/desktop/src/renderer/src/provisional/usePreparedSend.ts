import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { pluginUi, usePreparedInput } from '../plugins/ui-host'
import type { ConversationsBridge } from '../../../shared/bridge/conversations'

/**
 * The composer's saved draft (text and context references) and the prompt a send delivers from
 * it. Plugin transforms prepare the saved text, so a transform that hangs the window runs only on a
 * draft the daemon already holds. A send delivers a transformed prompt only once it was shown.
 */
export function usePreparedSend({
  conversations,
  conversationId,
}: {
  conversations: ConversationsBridge
  conversationId: string
}) {
  const [contextNodes, setContextNodes] = useState<unknown[]>([])
  const [savedText, settle] = useState('')
  const prepared = usePreparedInput(savedText, contextNodes)
  const shown = useRef<string | null>(null)
  useLayoutEffect(() => {
    shown.current = prepared.text !== savedText ? prepared.text : null
  }, [prepared, savedText])

  /** The text a send of `text` delivers, or why it cannot be sent as it is. */
  const resolve = useCallback(
    (text: string): { text: string } | { refused: string } => {
      const final = pluginUi.prepare({ text, context_nodes: contextNodes })
      if (!final.blocked && (final.text === text || shown.current === final.text)) return { text: final.text }
      settle(text)
      return {
        refused:
          final.blocked ?? 'Plugins prepared this prompt differently. Review the prepared prompt, then send again.',
      }
    },
    [contextNodes],
  )
  /** A draft restored from the daemon replaces the text and its references together. */
  const restore = useCallback((text: string, nodes: unknown[]) => {
    setContextNodes(nodes)
    settle(text)
  }, [])
  return { contextNodes, savedText, settle, restore, prepared, resolve, conversations, conversationId }
}

export type PreparedSend = ReturnType<typeof usePreparedSend>
