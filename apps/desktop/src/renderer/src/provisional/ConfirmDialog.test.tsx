import { expect, test } from 'vitest'
import { render } from 'vitest-browser-react'
import '../app/app.css'
import { confirm, ConfirmHost } from './ConfirmDialog'

test('confirm() resolves with the answer, one question at a time', async () => {
  const screen = await render(<ConfirmHost />)
  const first = confirm({ title: 'Delete the branch?', confirmLabel: 'Delete', destructive: true })
  const second = confirm({ title: 'Close the tab?' })

  await screen.getByRole('button', { name: 'Delete' }).click()
  await expect(first).resolves.toBe(true)

  await expect.element(screen.getByText('Close the tab?')).toBeVisible()
  await screen.getByRole('button', { name: 'Cancel' }).click()
  await expect(second).resolves.toBe(false)
})
