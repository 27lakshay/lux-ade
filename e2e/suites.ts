// Runner-native selection shared by all Playwright entry points.
export const suites = {
  protocol: {
    testDir: './e2e/protocol',
    testMatch: '**/*.spec.ts',
    testIgnore: '**/packaged/**',
    grepInvert: /@load|@system/,
  },
  devices: {
    testDir: './e2e/protocol',
    testMatch: ['**/devices/*.spec.ts', '**/devplug/device-input.spec.ts'],
  },
  performance: {
    testDir: './e2e/protocol',
    testMatch: '**/*.spec.ts',
    testIgnore: '**/packaged/**',
    grep: /@load/,
    grepInvert: /@system/,
  },
  system: {
    testDir: './e2e/protocol',
    testMatch: '**/*.spec.ts',
    testIgnore: '**/packaged/**',
    grep: /@system/,
    grepInvert: /@load/,
  },
  desktop: { testDir: './e2e/desktop', testMatch: '**/*.spec.ts' },
  packageProtocol: { testDir: './e2e/protocol', testMatch: '**/packaged/*.spec.ts' },
  packageDesktop: { testDir: './e2e/packaged', testMatch: '**/*.spec.ts', testIgnore: '**/current.spec.ts' },
  packageDesktopCurrent: { testDir: './e2e/packaged', testMatch: '**/current.spec.ts' },
  live: { testDir: './e2e/live', testMatch: '**/*.spec.ts' },
}
