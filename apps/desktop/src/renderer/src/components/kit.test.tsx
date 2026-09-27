// Smoke test for the stock shadcn/ui kit on Base UI: it resolves through the @/ alias, renders in
// Chromium, and its interactive parts work. The kit itself (./ui) stays unmodified.
import { expect, test } from 'vitest'
import { render } from 'vitest-browser-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import '@/shadcn.css'

test('a kit button renders with merged classes', async () => {
  const screen = await render(<Button className="w-40">Save</Button>)
  const button = screen.getByRole('button', { name: 'Save' })
  await expect.element(button).toHaveClass('w-40')
})

test('a kit dialog opens from its trigger', async () => {
  const screen = await render(
    <Dialog>
      <DialogTrigger render={<Button />}>Open</DialogTrigger>
      <DialogContent>
        <DialogTitle>Settings</DialogTitle>
      </DialogContent>
    </Dialog>,
  )
  await screen.getByRole('button', { name: 'Open' }).click()
  await expect.element(screen.getByRole('dialog', { name: 'Settings' })).toBeVisible()
})
