import { useEffect, useState } from 'react'
import type { Conversation, RecoveredAttempt } from '@ade/contracts'
import { Body, Caption } from '@/components/Typography'
import { Button } from '@/components/ui/button'
import { messageOf } from './ConversationComposerSupport'

const STOPPED = ['interrupted', 'error', 'disconnected', 'unavailable']

/**
 * Recovery for a conversation whose agent stopped: Resume reconnects it. When the newest prompt's
 * outcome is unknown the daemon refuses an implicit resume, because the native session may
 * continue that work; the refusal is shown and only an explicit choice resumes anyway. Runtime
 * attempts with no evidence of how they ended are listed with the daemon's evidence, and can be
 * released as stopped. Nothing here resends a prompt.
 */
export function ConversationRecovery({ conversation }: { conversation: Conversation }) {
  const host = window.adeHost!.conversations
  const [refusal, setRefusal] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [attempts, setAttempts] = useState<Array<{ report: string; attempt: RecoveredAttempt }>>([])
  const stopped = STOPPED.includes(conversation.status)
  useEffect(() => {
    let active = true
    host.request('runtime.recovery', {}).then(
      (recovery) =>
        active &&
        setAttempts(
          (Array.isArray(recovery?.reports) ? recovery.reports : []).flatMap((report) =>
            report.attempts
              .filter((attempt) => attempt.key === `agent:${conversation.id}` && attempt.resolved_at === null)
              .map((attempt) => ({ report: report.id, attempt })),
          ),
        ),
      () => undefined,
    )
    return () => {
      active = false
    }
  }, [conversation.id, conversation.status, host])
  if (!stopped && attempts.length === 0) return null
  const resume = async (continueInterrupted: boolean) => {
    setWorking(true)
    setMessage(null)
    try {
      await host.request('agent.resume', {
        operation_id: crypto.randomUUID(),
        conversation_id: conversation.id,
        ...(continueInterrupted ? { continue_interrupted: true } : {}),
      })
      setRefusal(null)
      setMessage('Resumed. No prompt was sent again.')
    } catch (error) {
      const reason = messageOf(error)
      if (/continue_interrupted/.test(reason)) setRefusal(reason)
      else setMessage("Couldn't resume. " + reason)
    } finally {
      setWorking(false)
    }
  }
  const release = async (report: string, attempt: RecoveredAttempt) => {
    try {
      await host.request('runtime.recovery.release', { report_id: report, attempt_key: attempt.key })
      setAttempts((all) => all.filter((entry) => entry.attempt.key !== attempt.key || entry.report !== report))
    } catch (error) {
      setMessage("Couldn't release the attempt. " + messageOf(error))
    }
  }
  return (
    <section aria-label="Conversation recovery" className="flex flex-col gap-2 rounded-lg bg-panel px-4 py-3">
      {attempts.map(({ report, attempt }) => (
        <div key={report + attempt.key} className="flex flex-col gap-1">
          <Caption>
            Runtime attempt {attempt.classification}: {attempt.reason}
            {attempt.outcome_unknown ? ' Its turn may have had effects and was not replayed.' : ''}
          </Caption>
          {attempt.classification === 'unknown' && (
            <Button size="sm" variant="outline" className="self-start" onClick={() => void release(report, attempt)}>
              Accept that this attempt stopped
            </Button>
          )}
        </div>
      ))}
      {refusal ? (
        <>
          <Body role="alert">{refusal.replace(/; resume with continue_interrupted to accept that/, '.')}</Body>
          <Button size="sm" className="self-start" disabled={working} onClick={() => void resume(true)}>
            Resume and let the session continue that work
          </Button>
        </>
      ) : (
        stopped && (
          <Button size="sm" className="self-start" disabled={working} onClick={() => void resume(false)}>
            Resume agent
          </Button>
        )
      )}
      {message && <Body role="status">{message}</Body>}
    </section>
  )
}
