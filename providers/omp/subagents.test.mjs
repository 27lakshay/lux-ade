import { test, expect } from 'bun:test'
import { Subagents } from './subagents.mjs'
const frame = (status, extra = {}) => ({
  type: 'subagent_lifecycle',
  payload: { id: 'child', parentToolCallId: 'call', agent: 'research', status, ...extra },
})

test('detached completion retains original turn and stable identity', () => {
  const children = new Subagents()
  const started = children.consume(frame('started'), 'first')
  expect(started.content.agents[0].state).toBe('running')
  expect(children.consume(frame('started'), 'first')).toBeNull()
  const completed = children.consume(frame('completed'), 'second')
  expect(completed.turn).toBe('first')
  expect(completed.id).toBe(started.id)
  expect(completed.content.agents[0].state).toBe('completed')
  expect(children.consume(frame('completed'), 'second')).toBeNull()
})

test('unknown children cannot attach to unrelated turns; cancellation differs from failure', () => {
  const children = new Subagents()
  expect(children.consume(frame('completed'), 'unrelated')).toBeNull()
  expect(children.consume(frame('started'), null)).toBeNull()
  children.consume(frame('started'), 'first')
  expect(children.consume(frame('failed', { parentToolCallId: 'other' }), 'second')).toBeNull()
  expect(children.consume(frame('aborted'), null).content.agents[0].state).toBe('interrupted')
  children.consume(frame('started', { parentToolCallId: 'other' }), 'second')
  expect(children.consume(frame('failed', { parentToolCallId: 'other' }), null).content.agents[0].state).toBe('failed')
})

test('child admission is bounded and terminal entries release capacity', () => {
  const children = new Subagents()
  for (let i = 0; i < 256; i++) children.consume(frame('started', { id: String(i) }), 'turn')
  expect(() => children.consume(frame('started', { id: 'overflow' }), 'turn')).toThrow('256')
  children.consume(frame('completed', { id: '0' }), null)
  expect(children.consume(frame('started', { id: 'overflow' }), 'turn')).not.toBeNull()
  expect(children.children.size).toBe(256)
  expect(() => children.consume(frame('invented'), 'turn')).toThrow('Invalid')
})

test('parked OMP child can wake under its original tool call after the parent turn ends', () => {
  const children = new Subagents()
  const first = children.consume(frame('started'), 'first')
  children.consume(frame('completed'), null)
  // The native IRC wake monitor reuses the captured parentToolCallId, including
  // when no parent turn is active. Its ordered lifecycle stream is authoritative.
  const wake = children.consume(frame('started'), null)
  expect(wake?.content.agents[0].state).toBe('running')
  expect(wake.id).toBe(first.id)
  expect(wake.turn).toBe('first')
  expect(children.consume(frame('started'), null)).toBeNull()
  const end = children.consume(frame('completed', { description: 'Answered follow-up' }), null)
  expect(end.id).toBe(first.id)
  expect(end.content.agents[0].state).toBe('completed')
  expect(end.content.agents[0].summary).toBe('Answered follow-up')
})
