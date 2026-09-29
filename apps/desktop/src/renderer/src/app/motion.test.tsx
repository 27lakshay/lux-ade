import * as m from 'motion/react-m'
import { afterEach, expect, test } from 'vitest'
import { render } from 'vitest-browser-react'
import './app.css'
import { DURATION, EASE_STANDARD } from './motion'
import { reducesMotion, setMotionPreference, startMotionPreference } from './motion-preference'
import { MotionProvider } from './MotionProvider'

afterEach(() => {
  setMotionPreference('system')
})

test('the CSS timing tokens equal the Motion presets', async () => {
  const screen = await render(<div data-testid="probe" className="ease-standard duration-200 transition-opacity" />)
  const probe = getComputedStyle(screen.getByTestId('probe').element())
  expect(probe.transitionTimingFunction).toBe(`cubic-bezier(${EASE_STANDARD.join(', ')})`)
  const root = getComputedStyle(document.documentElement)
  expect(root.getPropertyValue('--duration-fast').trim()).toBe(`${DURATION.fast * 1000}ms`)
  expect(root.getPropertyValue('--duration-base').trim()).toBe(`${DURATION.base * 1000}ms`)
  expect(root.getPropertyValue('--duration-slow').trim()).toBe(`${DURATION.slow * 1000}ms`)
})

test('m components render with the features the provider loads', async () => {
  const screen = await render(
    <MotionProvider>
      <m.div data-testid="light" initial={{ opacity: 0 }} animate={{ opacity: 1 }} />
    </MotionProvider>,
  )
  await expect.element(screen.getByTestId('light')).toBeInTheDocument()
})

test('reduce motion: follow the system, or on or off whatever the system says', () => {
  expect(reducesMotion('system', true)).toBe(true)
  expect(reducesMotion('system', false)).toBe(false)
  expect(reducesMotion('on', false)).toBe(true)
  expect(reducesMotion('off', true)).toBe(false)
})

test('when motion is reduced, CSS transitions and animations finish at once', async () => {
  startMotionPreference()
  const screen = await render(<div data-testid="probe" className="duration-200 transition-opacity" />)
  const probe = screen.getByTestId('probe').element()
  expect(getComputedStyle(probe).transitionDuration).toBe('0.2s')
  setMotionPreference('on')
  expect(document.documentElement.hasAttribute('data-reduced-motion')).toBe(true)
  expect(parseFloat(getComputedStyle(probe).transitionDuration)).toBeLessThan(0.001)
  setMotionPreference('off')
  expect(document.documentElement.hasAttribute('data-reduced-motion')).toBe(false)
})
