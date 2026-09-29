import { classRules } from './oxlint-rules-classes.mjs'

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
  property.key?.type === 'Identifier'
    ? property.key.name
    : typeof property.key?.value === 'string'
      ? property.key.value
      : null

const literalValue = (node) => (node?.type === 'Literal' ? node.value : undefined)

const findProperty = (object, name) =>
  object.properties.find((property) => property.type === 'Property' && keyName(property) === name)

const electronWebPreferences = {
  meta: {
    type: 'problem',
    docs: { description: "Every BrowserWindow and WebContentsView keeps Electron's security settings on." },
  },
  create(context) {
    return {
      NewExpression(node) {
        if (node.callee.type !== 'Identifier' || !CONSTRUCTORS.has(node.callee.name)) return
        const options = node.arguments[0]
        const where = node.callee.name
        if (options?.type !== 'ObjectExpression') {
          context.report({
            node,
            message: `Pass ${where} an object literal with webPreferences, so its security settings can be checked.`,
          })
          return
        }
        const preferences = findProperty(options, 'webPreferences')?.value
        if (preferences?.type !== 'ObjectExpression') {
          context.report({
            node,
            message: `${where} needs a webPreferences object literal stating contextIsolation: true, sandbox: true and nodeIntegration: false.`,
          })
          return
        }
        for (const property of preferences.properties) {
          if (property.type === 'SpreadElement') {
            context.report({
              node: property,
              message: 'Do not spread into webPreferences; state each setting so it can be checked.',
            })
          }
        }
        for (const [name, expected] of Object.entries(REQUIRED)) {
          const property = findProperty(preferences, name)
          if (!property || literalValue(property.value) !== expected) {
            context.report({
              node: property ?? preferences,
              message: `${where} webPreferences must state ${name}: ${expected}.`,
            })
          }
        }
        for (const [name, unsafe] of Object.entries(FORBIDDEN)) {
          const property = findProperty(preferences, name)
          if (property && literalValue(property.value) !== !unsafe) {
            context.report({
              node: property,
              message: `${where} webPreferences must not set ${name} to ${unsafe} or a computed value.`,
            })
          }
        }
      },
    }
  },
}

// Store hooks that must be given a selector: without one, a component re-renders on every change.
const STORE_HOOKS = { useStore: 2, useDaemon: 1 }

const requireStoreSelector = {
  meta: {
    type: 'problem',
    docs: { description: 'A component reads a store through a selector, never the whole store.' },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || !(node.callee.name in STORE_HOOKS)) return
        const needed = STORE_HOOKS[node.callee.name]
        if (node.arguments.length < needed) {
          context.report({
            node,
            message: `${node.callee.name} without a selector re-renders on every store change; pass a selector that picks only what the component renders.`,
          })
        }
      },
    }
  },
}

const LOOSE_VALUES = new Set(['TSUnknownKeyword', 'TSAnyKeyword'])

const noLooseRecord = {
  meta: {
    type: 'problem',
    docs: { description: 'A typed boundary names its data; it never falls back to Record<string, unknown>.' },
  },
  create(context) {
    return {
      TSTypeReference(node) {
        if (node.typeName.type !== 'Identifier' || node.typeName.name !== 'Record') return
        const [key, value] = (node.typeArguments ?? node.typeParameters)?.params ?? []
        if (key?.type !== 'TSStringKeyword' || !LOOSE_VALUES.has(value?.type)) return
        context.report({
          node,
          message:
            "Record<string, unknown> drops the contract's types at this boundary. Use the daemon contract's type (DailyUseRequest, DailyUseResponse, CallRequest) or a named type for what main returns.",
        })
      },
    }
  },
}

const noLayoutDouble = {
  meta: {
    type: 'problem',
    docs: { description: 'The app never applies a layout itself; the layout double is for tests and the bench.' },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (!/(^|\/)layout-double(\/|$)/.test(node.source.value)) return
        context.report({
          node,
          message:
            'The daemon applies every layout change (daemon authority decision 1): send it with layout.apply through model/layout-store.ts. dev/layout-double is a test and ?bench double only.',
        })
      },
    }
  },
}

const noNativeTitle = {
  meta: {
    type: 'problem',
    docs: { description: "Tooltips use the kit's Tooltip, not the browser's title attribute." },
  },
  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'title') return
        const element = node.parent?.name
        // Lowercase names are HTML and SVG elements; components may take a `title` prop of their own.
        if (element?.type !== 'JSXIdentifier' || !/^[a-z]/.test(element.name)) return
        context.report({
          node,
          message:
            "The native title tooltip is slow, unstyled and invisible to keyboard users. Wrap the element in the kit's Tooltip (components/ui/tooltip), or give it an aria-label.",
        })
      },
    }
  },
}

const iconsFromTable = {
  meta: {
    type: 'problem',
    docs: { description: 'Icons come from the icon table, so each idea has one icon.' },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const source = node.source.value
        if (source !== 'lucide-react' && !source.startsWith('lucide-react/')) return
        context.report({
          node,
          message:
            'Draw icons with <Icon name="…" /> from src/renderer/src/icons/Icon.tsx. Add a missing icon to icons/icons.ts under the name of what it means.',
        })
      },
    }
  },
}

// Every string literal inside an attribute value: "a b", `a ${x}`, cn('a', cond && 'b').
function stringsIn(node) {
  if (!node) return []
  if (node.type === 'Literal') return typeof node.value === 'string' ? [node.value] : []
  if (node.type === 'TemplateLiteral') return node.quasis.map((quasi) => quasi.value.cooked ?? '')
  if (node.type === 'JSXExpressionContainer') return stringsIn(node.expression)
  if (node.type === 'CallExpression') return node.arguments.flatMap(stringsIn)
  if (node.type === 'LogicalExpression' || node.type === 'BinaryExpression')
    return [...stringsIn(node.left), ...stringsIn(node.right)]
  if (node.type === 'ConditionalExpression') return [...stringsIn(node.consequent), ...stringsIn(node.alternate)]
  return []
}

const attribute = (element, name) =>
  element.attributes.find(
    (attr) => attr.type === 'JSXAttribute' && attr.name.type === 'JSXIdentifier' && attr.name.name === name,
  )

const SIZE_CLASS = /(^|[\s:])(size|w|h)-/

const iconSizeClass = {
  meta: {
    type: 'problem',
    docs: { description: 'Icons take their size from the scale, not from classes.' },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'Icon') return
        const className = attribute(node, 'className')
        if (!className || !stringsIn(className.value).some((value) => SIZE_CLASS.test(value))) return
        context.report({
          node: className,
          message: 'Size an icon with size="xs" | "sm" | "md" | "lg" (12, 14, 16, 18px), not a size, w- or h- class.',
        })
      },
    }
  },
}

const iconButtonLabel = {
  meta: {
    type: 'problem',
    docs: { description: 'A button showing only an icon has a name for screen readers.' },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'Button') return
        const size = attribute(node, 'size')?.value
        if (size?.type !== 'Literal' || typeof size.value !== 'string' || !size.value.startsWith('icon')) return
        const named = node.attributes.some(
          (attr) =>
            attr.type === 'JSXSpreadAttribute' ||
            (attr.name?.type === 'JSXIdentifier' && ['aria-label', 'aria-labelledby'].includes(attr.name.name)),
        )
        if (named) return
        context.report({
          node,
          message: 'An icon-only button needs aria-label (and a Tooltip with the same words for sighted users).',
        })
      },
    }
  },
}

const TEXT_ELEMENTS = {
  p: '<Body>',
  h1: '<Heading>',
  h2: '<Title>',
  h3: '<Title as="h3">',
  h4: '<Title as="h4">',
  h5: '<Caption as="h4">',
  h6: '<Caption as="h4">',
}

const textElements = {
  meta: {
    type: 'problem',
    docs: { description: 'Paragraphs and headings are rendered through the typography components.' },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== 'JSXIdentifier' || !Object.hasOwn(TEXT_ELEMENTS, node.name.name)) return
        context.report({
          node,
          message: `Use ${TEXT_ELEMENTS[node.name.name]} from components/Typography.tsx instead of <${node.name.name}>: it sets the size, weight and line height.`,
        })
      },
    }
  },
}

// The kit's Button defaults to 32px; ADE's default control is 28px, so every Button states its size.
const kitButtonSize = {
  meta: { type: 'problem', docs: { description: 'Every kit Button states its size.' } },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'Button') return
        if (node.attributes.some((attr) => attr.type === 'JSXSpreadAttribute') || attribute(node, 'size')) return
        context.report({
          node,
          message:
            'Give <Button> a size: "sm" is ADE\'s default 28px control, "xs" 24px, "icon-sm" a 28px icon button (prefer <IconButton>).',
        })
      },
    }
  },
}

// Button copy: sentence case, and say what happens.
const VAGUE = new Set(['ok', 'okay', 'yes', 'no', 'submit', 'done'])
const TITLE_CASE = /^[A-Z][a-z]+( [A-Z][a-z]+)+…?$/

function copyProblem(text) {
  const words = text.trim()
  if (!words) return null
  if (VAGUE.has(words.toLowerCase()))
    return `"${words}" does not say what happens. Name the action: "Delete branch", "Close tab".`
  if (TITLE_CASE.test(words))
    return `"${words}": use sentence case ("${words[0]}${words.slice(1).toLowerCase()}"). See docs/agents/ui-copy.md.`
  return null
}

const buttonCopy = {
  meta: { type: 'problem', docs: { description: 'Button labels are sentence case and name the action.' } },
  create(context) {
    return {
      JSXElement(node) {
        const name = node.openingElement.name
        if (name.type !== 'JSXIdentifier') return
        if (name.name === 'Button' || name.name === 'AlertDialogAction' || name.name === 'AlertDialogCancel') {
          const text = node.children
            .filter((child) => child.type === 'JSXText')
            .map((child) => child.value)
            .join(' ')
          const problem = copyProblem(text.replace(/\s+/g, ' '))
          if (problem) context.report({ node, message: problem })
        }
        if (name.name === 'IconButton') {
          const label = attribute(node.openingElement, 'label')?.value
          const problem = label?.type === 'Literal' && typeof label.value === 'string' ? copyProblem(label.value) : null
          if (problem) context.report({ node, message: problem })
        }
      },
    }
  },
}

// Motion: animate only what the compositor handles, time everything with the presets, and never
// measure layout on every render.
const MOTION_TARGETS = new Set([
  'animate',
  'initial',
  'exit',
  'whileHover',
  'whileTap',
  'whileFocus',
  'whileDrag',
  'whileInView',
])
const COMPOSITED = new Set([
  'opacity',
  'transform',
  'x',
  'y',
  'scale',
  'scaleX',
  'scaleY',
  'rotate',
  'filter',
  'clipPath',
  'transition',
])

const motionProps = {
  meta: { type: 'problem', docs: { description: 'Motion animates composited properties with preset timing.' } },
  create(context) {
    return {
      JSXOpeningElement(node) {
        for (const attr of node.attributes) {
          if (attr.type !== 'JSXAttribute' || attr.name.type !== 'JSXIdentifier') continue
          const value = attr.value?.type === 'JSXExpressionContainer' ? attr.value.expression : null
          if (MOTION_TARGETS.has(attr.name.name) && value?.type === 'ObjectExpression') {
            for (const property of value.properties) {
              const key = property.type === 'Property' ? keyName(property) : null
              if (key && !COMPOSITED.has(key))
                context.report({
                  node: property,
                  message: `Animating "${key}" runs layout or paint every frame. Animate opacity or transforms (x, y, scale), or use the layout prop for size and position.`,
                })
            }
          }
          if (attr.name.name === 'transition' && value?.type === 'ObjectExpression')
            context.report({
              node: attr,
              message: 'Use a preset from app/motion.ts (transition={transitions.layout}), not inline timing.',
            })
        }
        const layout = attribute(node, 'layout')
        if (layout && !attribute(node, 'layoutDependency'))
          context.report({
            node: layout,
            message:
              'Give a layout animation a layoutDependency (the order or structure that changes), so Motion measures only when it changes, not on every render.',
          })
      },
    }
  },
}

export default {
  meta: { name: 'ade' },
  rules: {
    'electron-web-preferences': electronWebPreferences,
    'require-store-selector': requireStoreSelector,
    'no-loose-record': noLooseRecord,
    'no-native-title': noNativeTitle,
    'no-layout-double': noLayoutDouble,
    'icons-from-table': iconsFromTable,
    'icon-size-class': iconSizeClass,
    'icon-button-label': iconButtonLabel,
    ...classRules,
    'kit-button-size': kitButtonSize,
    'button-copy': buttonCopy,
    'motion-props': motionProps,
    'text-elements': textElements,
  },
}
