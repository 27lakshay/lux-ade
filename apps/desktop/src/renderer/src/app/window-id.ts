/**
 * This window's daemon record, as main named it in the window's URL (`?window=<ID>`), or null when
 * main opened the window before the daemon answered; main then sends it (`layouts.onWindowId`).
 */
export const URL_WINDOW_ID = new URLSearchParams(window.location.search).get('window')
