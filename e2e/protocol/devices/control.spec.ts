// Device control (F098, F099, F100 "view/control"). The register asks for
// input control of an explicitly targeted display, application, simulator
// and Android device. No `device.*` input operation exists yet, so these are
// recorded gaps, not passing coverage.
import { test } from '../fixtures'

// Gap: no input operation (tap, type, key) for displays, and no application
// target (`app:<bundle>` or window) with caller attribution. F098 needs both,
// plus a focus change that must not redirect the input.
test.fixme('F098: input to an explicit display or application target never follows focus', async () => {})

// Gap: no simulator input operation (simctl io / HID). F099 needs control of
// the selected simulator with its host identity.
test.fixme('F099: input to one selected simulator reaches only that simulator', async () => {})

// Gap: no Android input operation (adb shell input). F100 needs control of the
// selected device, refused after disconnect or on an unauthorized device.
test.fixme('F100: input to one selected Android device, refused after disconnect', async () => {})
