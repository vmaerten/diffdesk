// A language server for the UI suites: it speaks LSP on stdio and answers the
// requests the review server makes, the way a real one would.
import { stdin, stdout } from 'node:process'

interface Message {
  id?: number | string
  method?: string
  params?: unknown
}

function send(message: object) {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message })
  stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}

function answer(message: Message): unknown {
  switch (message.method) {
    case 'initialize':
      return { capabilities: {}, serverInfo: { name: 'fake', version: '1.0' } }
    default:
      return null
  }
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
    // Requests carry an id; notifications and replies to our own requests need nothing.
    if (message.id !== undefined && message.method)
      send({ id: message.id, result: answer(message) })
  }
})
stdin.on('end', () => process.exit(0))
