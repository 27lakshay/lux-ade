import { expect, test } from 'vitest'
import { latestSave } from './latestSave'

function gate() {
  let open: () => void = () => undefined
  const promise = new Promise<void>((resolve) => (open = resolve))
  return { promise, open }
}

test('an edit is handed to the writer synchronously when nothing is in flight', () => {
  const written: string[] = []
  const save = latestSave(async (text) => {
    written.push(text)
  })
  save('a')
  expect(written).toEqual(['a'])
})

test('edits made while a write is in flight collapse to the newest', async () => {
  const written: string[] = []
  const first = gate()
  const save = latestSave((text) => {
    written.push(text)
    return written.length === 1 ? first.promise : Promise.resolve()
  })
  save('a')
  save('ab')
  save('abc')
  expect(written).toEqual(['a'])
  first.open()
  await expect.poll(() => written).toEqual(['a', 'abc'])
})

test('flush starts the pending write now and cancel drops it', async () => {
  const written: string[] = []
  const first = gate()
  const save = latestSave((text) => {
    written.push(text)
    return written.length === 1 ? first.promise : Promise.resolve()
  })
  save('a')
  save('ab')
  save.flush()
  expect(written).toEqual(['a', 'ab'])
  save('abc')
  save.cancel()
  first.open()
  await first.promise
  await Promise.resolve()
  expect(written).toEqual(['a', 'ab'])
})
