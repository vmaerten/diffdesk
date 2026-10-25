// A language server for the UI suites: it speaks LSP on stdio and answers the
// requests the review server makes, the way a real one would.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stdin, stdout } from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

interface Message {
  id?: number | string
  method?: string
  params?: unknown
}

function send(message: object) {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message })
  stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}

interface Position {
  textDocument: { uri: string }
  position: { line: number; character: number }
}

let root = ''
// What the client sent, which wins over the disk, as in a real server.
const documents = new Map<string, string>()

function text(uri: string): string {
  return documents.get(uri) ?? readFileSync(fileURLToPath(uri), 'utf8')
}

function wordAt({ textDocument, position }: Position): string {
  const line = text(textDocument.uri).split('\n')[position.line] ?? ''
  const word = /[\w$]+/g
  for (let match = word.exec(line); match; match = word.exec(line)) {
    if (match.index <= position.character && position.character < match.index + match[0].length)
      return match[0]
  }
  return ''
}

/** The workspace's TypeScript files, the one asked about first. */
function sources(first: string): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry.name)) found.push(path)
    }
  }
  walk(root)
  return [first, ...found.filter((path) => path !== first)]
}

/** Where `const`, `function` or `class` names the word. */
function definition(request: Position) {
  const word = wordAt(request)
  if (!word) return null
  const declaration = new RegExp(`\\b(?:const|let|function|class)\\s+(${word})\\b`)
  for (const path of sources(fileURLToPath(request.textDocument.uri))) {
    const lines = text(pathToFileURL(path).href).split('\n')
    for (const [index, line] of lines.entries()) {
      const match = declaration.exec(line)
      if (!match) continue
      const character = line.indexOf(word, match.index)
      return {
        uri: pathToFileURL(path).href,
        range: {
          start: { line: index, character },
          end: { line: index, character: character + word.length },
        },
      }
    }
  }
  return null
}

function answer(message: Message): unknown {
  switch (message.method) {
    case 'initialize':
      root = fileURLToPath((message.params as { rootUri: string }).rootUri)
      return { capabilities: {}, serverInfo: { name: 'fake', version: '1.0' } }
    case 'textDocument/hover': {
      const word = wordAt(message.params as Position)
      return word
        ? {
            contents: {
              kind: 'markdown',
              value: `\`\`\`typescript\nconst ${word}: number\n\`\`\`\n\n${word} is a fixture value.`,
            },
          }
        : null
    }
    case 'textDocument/definition':
      return definition(message.params as Position)
    default:
      return null
  }
}

function remember(message: Message) {
  const params = message.params as {
    textDocument: { uri: string; text?: string }
    contentChanges?: { text: string }[]
  }
  const content = params.textDocument.text ?? params.contentChanges?.at(-1)?.text
  if (content !== undefined) documents.set(params.textDocument.uri, content)
}

let buffer = Buffer.alloc(0)
stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n')
    if (end < 0) return
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())?.[1])
    if (buffer.length < end + 4 + length) return
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString()) as Message
    buffer = buffer.subarray(end + 4 + length)
    if (message.method === 'exit') process.exit(0)
    if (message.method === 'textDocument/didOpen' || message.method === 'textDocument/didChange')
      remember(message)
    // Requests carry an id; notifications and replies to our own requests need nothing.
    if (message.id !== undefined && message.method)
      send({ id: message.id, result: answer(message) })
  }
})
stdin.on('end', () => process.exit(0))
