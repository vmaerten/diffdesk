// What tsc and gopls answer about the demo's names, for the app's own symbol card.

import type {
  HoverBlock,
  LanguageStatus,
  SymbolAnswer,
  SymbolQuery,
} from '../../../../src/types.ts'
import { layers } from './fixtures.ts'

const running = (
  id: string,
  label: string,
  extensions: string[],
  server: string,
): LanguageStatus => ({
  id,
  label,
  extensions,
  choice: 'auto',
  choices: ['auto'],
  server: { name: server, path: server, origin: 'PATH' },
  state: 'ready',
})

/** The servers ghl runs on the demo's checkout; Markdown has none. */
export const languages: LanguageStatus[] = [
  running('typescript', 'TypeScript', ['.ts', '.tsx'], 'tsc'),
  running('go', 'Go', ['.go'], 'gopls'),
]

const layerGo = `package app

// Layer is one branch of the stack, as gh stack records it.
type Layer struct {
	Branch      string
	PullRequest int
	Merged      bool
}
`

/** The checkout: each file as the last layer leaves it, and one that no layer changes. */
const checkout = new Map<string, string[]>([
  ...layers.flatMap((layer) =>
    layer.files.map((file) => [file.path, file.after.split('\n')] as const),
  ),
  ['go/internal/app/layer.go', layerGo.split('\n')],
])

interface Declaration {
  name: string
  /** Reached through a dot, as a field or a method is. */
  member: boolean
  hover: HoverBlock[]
  /** A line of the checkout, or a file outside the repository. */
  at: { path: string; line: number } | { outside: string }
}

const STACK_TS = 'web/src/stack.ts'
const STACK_GO = 'go/internal/app/stack.go'
const LAYER_GO = 'go/internal/app/layer.go'
const PICKER = 'web/src/StackPicker.tsx'
const LIB = '/usr/local/lib/node_modules/typescript/lib'
const BUILTIN = '/usr/local/go/src/builtin/builtin.go'

const ts = (text: string): HoverBlock => ({ kind: 'code', language: 'typescript', text })
const go = (text: string): HoverBlock => ({ kind: 'code', language: 'go', text })
const doc = (text: string): HoverBlock => ({ kind: 'text', text })

/** name, declared on each line of path that holds text or matches it. */
function declared(
  path: string,
  text: string | RegExp,
  name: string,
  ...hover: HoverBlock[]
): Declaration[] {
  return checkout
    .get(path)!
    .flatMap((line, index) =>
      (typeof text === 'string' ? line.includes(text) : text.test(line))
        ? [{ name, member: false, hover, at: { path, line: index + 1 } }]
        : [],
    )
}

/** A field, declared like a name but reached through a dot. */
const field = (path: string, text: string | RegExp, name: string, ...hover: HoverBlock[]) =>
  declared(path, text, name, ...hover).map((declaration) => ({ ...declaration, member: true }))

const method = (name: string, lib: string, ...hover: HoverBlock[]): Declaration => ({
  name,
  member: true,
  hover,
  at: { outside: `${LIB}/${lib}` },
})

const builtin = (name: string, ...hover: HoverBlock[]): Declaration => ({
  name,
  member: false,
  hover,
  at: { outside: BUILTIN },
})

const layerFields = [
  ...field(STACK_TS, /^\s+branch: string$/, 'branch', ts('(property) Layer.branch: string')),
  ...field(
    STACK_TS,
    'pullRequest:',
    'pullRequest',
    ts('(property) Layer.pullRequest: number | null'),
  ),
  ...field(STACK_TS, 'merged: boolean', 'merged', ts('(property) Layer.merged: boolean')),
]

/** What each file's names may mean, from that file. */
const declarations: Record<string, Declaration[]> = {
  [STACK_TS]: [
    ...layerFields,
    ...declared(STACK_TS, 'export interface Layer', 'Layer', ts('interface Layer')),
    ...declared(
      STACK_TS,
      'export function layerAbove',
      'layerAbove',
      ts('function layerAbove(stack: Layer[], branch: string): Layer | undefined'),
      doc('The layer reviewed after this one, towards the top of the stack.'),
    ),
    ...declared(
      STACK_TS,
      'export function layerBelow',
      'layerBelow',
      ts('function layerBelow(stack: Layer[], branch: string): Layer | null'),
      doc('The layer reviewed before this one, towards the trunk.'),
    ),
    ...declared(STACK_TS, 'stack: Layer[]', 'stack', ts('(parameter) stack: Layer[]')),
    ...declared(STACK_TS, 'branch: string)', 'branch', ts('(parameter) branch: string')),
    ...declared(STACK_TS, 'const live', 'live', ts('const live: Layer[]')),
    ...declared(STACK_TS, 'const index', 'index', ts('const index: number')),
    ...declared(STACK_TS, '(layer) =>', 'layer', ts('(parameter) layer: Layer')),
    method(
      'filter',
      'lib.es5.d.ts',
      ts(
        '(method) Array<Layer>.filter(predicate: (value: Layer, index: number, array: Layer[]) => unknown, thisArg?: any): Layer[] (+1 overload)',
      ),
      doc(
        'Returns the elements of an array that meet the condition specified in a callback function.',
      ),
    ),
    method(
      'findIndex',
      'lib.es2015.core.d.ts',
      ts(
        '(method) Array<Layer>.findIndex(predicate: (value: Layer, index: number, obj: Layer[]) => unknown, thisArg?: any): number',
      ),
      doc(
        'Returns the index of the first element in the array where predicate is true, and -1 otherwise.',
      ),
    ),
  ],
  [PICKER]: [
    ...layerFields,
    {
      name: 'Layer',
      member: false,
      hover: [ts('(alias) interface Layer\nimport Layer')],
      at: { path: STACK_TS, line: 1 },
    },
    ...declared(PICKER, 'interface Props', 'Props', ts('interface Props')),
    ...field(PICKER, 'stack: Layer[]', 'stack', ts('(property) Props.stack: Layer[]')),
    ...field(PICKER, 'current: string', 'current', ts('(property) Props.current: string')),
    ...field(
      PICKER,
      'onPick: (',
      'onPick',
      ts('(property) Props.onPick: (branch: string) => void'),
    ),
    ...declared(PICKER, '(branch: string)', 'branch', ts('(parameter) branch: string')),
    ...declared(
      PICKER,
      'export function StackPicker',
      'StackPicker',
      ts('function StackPicker({ stack, current, onPick }: Props): JSX.Element'),
      doc('The stack under review, top layer first.'),
    ),
    ...declared(PICKER, '{ stack, current, onPick }', 'stack', ts('(parameter) stack: Layer[]')),
    ...declared(PICKER, '{ stack, current, onPick }', 'current', ts('(parameter) current: string')),
    ...declared(
      PICKER,
      '{ stack, current, onPick }',
      'onPick',
      ts('(parameter) onPick: (branch: string) => void'),
    ),
    ...declared(PICKER, '(layer) =>', 'layer', ts('(parameter) layer: Layer')),
    method(
      'toReversed',
      'lib.es2023.array.d.ts',
      ts('(method) Array<Layer>.toReversed(): Layer[]'),
      doc('Returns a copy of an array with its elements reversed.'),
    ),
    method(
      'map',
      'lib.es5.d.ts',
      ts(
        '(method) Array<Layer>.map<JSX.Element>(callbackfn: (value: Layer, index: number, array: Layer[]) => JSX.Element, thisArg?: any): JSX.Element[]',
      ),
      doc(
        'Calls a defined callback function on each element of an array, and returns an array that contains the results.',
      ),
    ),
  ],
  [STACK_GO]: [
    ...declared(
      STACK_GO,
      'func liveLayers',
      'liveLayers',
      go('func liveLayers(stack []Layer) []Layer'),
      doc(
        'liveLayers drops the layers whose pull request is merged, so that each remaining layer is compared with the nearest live one below it.',
      ),
    ),
    ...declared(
      LAYER_GO,
      'type Layer struct',
      'Layer',
      go(layerGo.slice(layerGo.indexOf('type Layer')).trimEnd()),
      doc('Layer is one branch of the stack, as gh stack records it.'),
    ),
    ...field(LAYER_GO, 'Merged ', 'Merged', go('field Merged bool')),
    ...declared(STACK_GO, 'func liveLayers', 'stack', go('var stack []Layer')),
    ...declared(STACK_GO, 'live :=', 'live', go('var live []Layer')),
    ...declared(STACK_GO, 'for _, layer', 'layer', go('var layer Layer')),
    builtin(
      'make',
      go('func make(t Type, size ...IntegerType) Type'),
      doc(
        'The make built-in function allocates and initializes an object of type slice, map, or chan (only).',
      ),
    ),
    builtin(
      'len',
      go('func len(v Type) int'),
      doc('The len built-in function returns the length of v, according to its type.'),
    ),
    builtin(
      'append',
      go('func append(slice []Type, elems ...Type) []Type'),
      doc('The append built-in function appends elements to the end of a slice.'),
    ),
  ],
}

/**
 * The declaration a name stands for where the query points: through a dot, a
 * member; otherwise the nearest one declared at or above it in the file, which
 * is how scopes nest in code this short, or else one from another file.
 */
function resolve({ path, line, character, token }: SymbolQuery): Declaration | undefined {
  const before = checkout.get(path)?.[line - 1]?.[character - 1]
  // aria-current is one attribute, not a name.
  if (before === '-') return undefined
  const named = (declarations[path] ?? []).filter((declaration) => declaration.name === token)
  if (before === '.') return named.find((declaration) => declaration.member)
  const lineIn = (declaration: Declaration) =>
    'path' in declaration.at && declaration.at.path === path ? declaration.at.line : null
  // A field counts only where it is declared: elsewhere a dot reaches it.
  const visible = named.filter((declaration) => {
    const at = lineIn(declaration)
    return at !== null && (at === line || (!declaration.member && at < line))
  })
  return (
    visible.sort((a, b) => lineIn(b)! - lineIn(a)!)[0] ??
    named.find((declaration) => !declaration.member && lineIn(declaration) === null)
  )
}

/** The demo's language servers, answering at once. */
export async function lookUpDemoSymbol(query: SymbolQuery): Promise<SymbolAnswer> {
  const declaration = resolve(query)
  const gopls = query.path.endsWith('.go')
  const answer: SymbolAnswer = {
    language: gopls ? 'go' : 'typescript',
    server: gopls ? 'gopls' : 'tsc',
    hover: declaration?.hover ?? [],
    definitions: [],
  }
  if (!declaration) return answer
  if ('outside' in declaration.at) {
    answer.definitions.push({ path: declaration.at.outside, line: 1, character: 0, inRepo: false })
  } else {
    // As the review server sends a definition: with its first ten lines.
    const { path, line } = declaration.at
    const lines = checkout.get(path)!
    answer.definitions.push({
      path,
      line,
      character: Math.max(0, lines[line - 1]!.indexOf(declaration.name)),
      inRepo: true,
      snippet: { start: line, lines: lines.slice(line - 1, line + 9) },
    })
  }
  return answer
}
