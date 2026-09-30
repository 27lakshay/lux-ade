import { invokeResult as invoke, subscribe } from './ipc'
import type { ThemesBridge } from '../shared/bridge/themes'

export const themes: ThemesBridge = {
  linkFile: () => invoke('ade:themes-link-file'),
  unlinkFile: (linkId) => invoke('ade:themes-unlink-file', linkId),
  onLinkedFile: (listener) => subscribe('ade:themes-linked-file', listener),
  exportGhostty: (id, revision) => invoke('ade:themes-export-ghostty', id, revision),
  saveGhostty: (id, revision) => invoke('ade:themes-save-ghostty', id, revision),
  chooseGhosttyFile: () => invoke('ade:themes-choose-ghostty-file'),
  validateGhostty: (request) => invoke('ade:themes-validate-ghostty', request),
  chooseWarpFile: () => invoke('ade:themes-choose-warp-file'),
  validateWarp: (request) => invoke('ade:themes-validate-warp', request),
  exportPack: (request) => invoke('ade:themes-export-pack', request),
  savePack: (request) => invoke('ade:themes-save-pack', request),
  validateFile: (source) => invoke('ade:themes-validate-file', source),
  saveFile: (id, revision) => invoke('ade:themes-save-file', id, revision),
  preview: (request) => invoke('ade:themes-preview', request),
  previewDraft: (request) => invoke('ade:themes-preview-draft', request),
  chooseFiles: () => invoke('ade:themes-choose-files'),
  validate: (source) => invoke('ade:themes-validate', source),
  list: (afterId) => invoke('ade:themes-list', afterId),
  inspect: (id) => invoke('ade:themes-inspect', id),
  install: (items) => invoke('ade:themes-install', items),
  rename: (id, name, revision) => invoke('ade:themes-rename', id, name, revision),
  export: (id, revision) => invoke('ade:themes-export', id, revision),
  removal: (id, afterKey) => invoke('ade:themes-removal', id, afterKey),
  remove: (id, revision, appearanceRevision) => invoke('ade:themes-remove', id, revision, appearanceRevision),
}
