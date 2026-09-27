// Device control (F098, F099, F100 "view/control"). Simulator and Android
// input through `device.input` is proven in `../devplug/device-input.spec.ts`.
// Display and application input is not built, so F098's control remains a
// recorded gap.
import { test } from '../fixtures'

// Gap: no input to a display or an application target (`app:<bundle>` or
// window). F098 needs it, with a focus change that must not redirect the
// input. Displays report `input` unavailable and refuse it.
test.fixme('F098: input to an explicit display or application target never follows focus', async () => {})
