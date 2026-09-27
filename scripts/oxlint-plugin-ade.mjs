// ADE's own Oxlint rules. Each rule has cases in oxlint-plugin-ade.test.mjs.

// Settings every window and view must state, and the value each must have.
const REQUIRED = { contextIsolation: true, sandbox: true, nodeIntegration: false }
// Settings that must never take the unsafe value.
const FORBIDDEN = {
  nodeIntegrationInSubFrames: true,
  nodeIntegrationInWorker: true,
  webSecurity: false,
  allowRunningInsecureContent: true,
  webviewTag: true,
  experimentalFeatures: true,
}
const CONSTRUCTORS = new Set(['BrowserWindow', 'WebContentsView'])

const keyName = (property) =>
  property.key?.type === 'Identifier' ? property.key.name : typeof property.key?.value === 'string' ? property.key.value : null

const literalValue = (node) => (node?.type === 'Literal' ? node.value : undefined)

const findProperty = (object, name) =>
  object.properties.find((property) => property.type === 'Property' && keyName(property) === name)

const electronWebPreferences = {
  meta: {
    type: 'problem',
    docs: { description: 'Every BrowserWindow and WebContentsView keeps Electron\'s security settings on.' },
  },
  create(context) {
    return {
      NewExpression(node) {
        if (node.callee.type !== 'Identifier' || !CONSTRUCTORS.has(node.callee.name)) return
        const options = node.arguments[0]
        const where = node.callee.name
        if (options?.type !== 'ObjectExpression') {
          context.report({ node, message: `Pass ${where} an object literal with webPreferences, so its security settings can be checked.` })
          return
        }
        const preferences = findProperty(options, 'webPreferences')?.value
        if (preferences?.type !== 'ObjectExpression') {
          context.report({ node, message: `${where} needs a webPreferences object literal stating contextIsolation: true, sandbox: true and nodeIntegration: false.` })
          return
        }
        for (const property of preferences.properties) {
          if (property.type === 'SpreadElement') {
            context.report({ node: property, message: 'Do not spread into webPreferences; state each setting so it can be checked.' })
          }
        }
        for (const [name, expected] of Object.entries(REQUIRED)) {
          const property = findProperty(preferences, name)
          if (!property || literalValue(property.value) !== expected) {
            context.report({ node: property ?? preferences, message: `${where} webPreferences must state ${name}: ${expected}.` })
          }
        }
        for (const [name, unsafe] of Object.entries(FORBIDDEN)) {
          const property = findProperty(preferences, name)
          if (property && literalValue(property.value) !== !unsafe) {
            context.report({ node: property, message: `${where} webPreferences must not set ${name} to ${unsafe} or a computed value.` })
          }
        }
      },
    }
  },
}

export default {
  meta: { name: 'ade' },
  rules: { 'electron-web-preferences': electronWebPreferences },
}
