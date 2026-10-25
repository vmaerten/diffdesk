// A three-layer stack: the bottom layer is merged and pruned, so the one under review falls back to the trunk.

import type { DiffSide } from '../../../../src/types.ts'

export interface DemoFile {
  path: string
  /** Null for a file the layer adds. */
  before: string | null
  after: string
}

export interface DemoComment {
  id: string
  path: string
  side: DiffSide
  start: number
  end: number
  body: string
}

export interface DemoLayer {
  branch: string
  pr: number
  /** What the layer is compared with: the nearest live layer below it, or the trunk. */
  base: string
  pruned: boolean
  files: DemoFile[]
  viewed: string[]
  comments: DemoComment[]
}

const reviewingBefore = `## Bases and stacks

Stack metadata is read from \`.git/gh-stack\`, without calling GitHub. Each layer is compared with the layer below it.

Press \`[\` and \`]\` to review the layer below or above.
`

const reviewingAfter = `## Bases and stacks

Stack metadata is read from \`.git/gh-stack\`, without calling GitHub. Each layer is compared with the nearest live layer below it; merged layers stay visible while upper layers fall back past them.

Press \`[\` and \`]\` to review the layer below or above.
`

const stackBefore = `export interface Layer {
  branch: string
  pullRequest: number | null
  merged: boolean
}

/** The layer reviewed after this one, towards the top of the stack. */
export function layerAbove(stack: Layer[], branch: string) {
  const index = stack.findIndex((layer) => layer.branch === branch)
  return stack[index - 1]
}

/** The layer reviewed before this one, towards the trunk. */
export function layerBelow(stack: Layer[], branch: string) {
  const live = stack.filter((layer) => !layer.merged)
  const index = live.findIndex((layer) => layer.branch === branch)
  return index < 0 ? null : (live[index + 1] ?? null)
}
`

const stackAfter = `export interface Layer {
  branch: string
  pullRequest: number | null
  merged: boolean
}

/** The layer reviewed after this one, towards the top of the stack. */
export function layerAbove(stack: Layer[], branch: string) {
  const live = stack.filter((layer) => !layer.merged)
  const index = live.findIndex((layer) => layer.branch === branch)
  return index > 0 ? live[index - 1] : undefined
}

/** The layer reviewed before this one, towards the trunk. */
export function layerBelow(stack: Layer[], branch: string) {
  const live = stack.filter((layer) => !layer.merged)
  const index = live.findIndex((layer) => layer.branch === branch)
  return index < 0 ? null : (live[index + 1] ?? null)
}
`

export const firstComment: DemoComment = {
  id: '4e23a9bb-1f0c-4c8e-9a51-6d2f0b7e3c11',
  path: 'web/src/stack.ts',
  side: 'additions',
  start: 11,
  end: 11,
  body: 'Return null here, like layerBelow does.',
}

// Not on the demo's layer at first: the export further down the page shows it beside the first one.
export const goComment: DemoComment = {
  id: '05de55da-7b3e-4f21-8c94-2a6e1d9f4b02',
  path: 'go/internal/app/stack.go',
  side: 'additions',
  start: 8,
  end: 9,
  body: 'Log why the layer is skipped.',
}

/** Bottom layer first, as gh stack lists them. */
export const layers: DemoLayer[] = [
  {
    branch: 'stack-model',
    pr: 209,
    base: 'main',
    pruned: true,
    files: [],
    viewed: [],
    comments: [],
  },
  {
    branch: 'stack-nav',
    pr: 211,
    base: 'main',
    pruned: false,
    files: [
      { path: 'docs/reviewing.md', before: reviewingBefore, after: reviewingAfter },
      {
        path: 'go/internal/app/stack.go',
        before: `package app

// liveLayers drops the layers whose pull request is merged, so that each
// remaining layer is compared with the nearest live one below it.
func liveLayers(stack []Layer) []Layer {
	live := make([]Layer, 0, len(stack))
	for _, layer := range stack {
		live = append(live, layer)
	}
	return live
}
`,
        after: `package app

// liveLayers drops the layers whose pull request is merged, so that each
// remaining layer is compared with the nearest live one below it.
func liveLayers(stack []Layer) []Layer {
	live := make([]Layer, 0, len(stack))
	for _, layer := range stack {
		if layer.Merged {
			continue
		}
		live = append(live, layer)
	}
	return live
}
`,
      },
      { path: 'web/src/stack.ts', before: stackBefore, after: stackAfter },
    ],
    // Two files already read, so the review opens on the one with a comment.
    viewed: ['docs/reviewing.md', 'go/internal/app/stack.go'],
    comments: [firstComment],
  },
  {
    branch: 'stack-picker',
    pr: 212,
    base: 'stack-nav',
    pruned: false,
    files: [
      {
        path: 'docs/reviewing.md',
        before: reviewingAfter,
        after: reviewingAfter.replace(
          'Press `[` and `]` to review the layer below or above.',
          'Press `s` or click the layer, such as `2/3`, to list the stack and pick a layer, or press `[` and `]` to review the layer below or above.',
        ),
      },
      {
        path: 'web/src/StackPicker.tsx',
        before: null,
        after: `import type { Layer } from './stack.ts'

interface Props {
  stack: Layer[]
  current: string
  onPick: (branch: string) => void
}

/** The stack under review, top layer first. */
export function StackPicker({ stack, current, onPick }: Props) {
  return (
    <ol className="stack-list">
      {stack.toReversed().map((layer) => (
        <li key={layer.branch} aria-current={layer.branch === current}>
          <button type="button" disabled={layer.merged} onClick={() => onPick(layer.branch)}>
            {layer.branch}
          </button>
        </li>
      ))}
    </ol>
  )
}
`,
      },
    ],
    viewed: ['docs/reviewing.md'],
    comments: [
      {
        id: 'c3a8e1f4-5d27-4b90-a613-8e4f7c2d9a53',
        path: 'web/src/StackPicker.tsx',
        side: 'additions',
        start: 10,
        end: 10,
        body: 'Focus the current layer when the list opens.',
      },
    ],
  },
]

export const startLayer = 1
