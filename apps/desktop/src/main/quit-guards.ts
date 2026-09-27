import { app } from 'electron'
import { QuitCoordinator } from './quit-coordinator'

export type { QuitGuard, QuitTeardown } from './quit-coordinator'

const coordinator = new QuitCoordinator(() => app.quit())

export const registerQuitGuard = coordinator.registerGuard.bind(coordinator)
export const registerQuitTeardown = coordinator.registerTeardown.bind(coordinator)
export const holdQuit = coordinator.holdQuit.bind(coordinator)
export const finishQuit = coordinator.finishQuit.bind(coordinator)
