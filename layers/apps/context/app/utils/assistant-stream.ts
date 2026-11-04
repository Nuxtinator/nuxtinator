// Client-side pieces of a streamed assistant turn: a reader for the messages
// endpoint's server-sent events, and a splitter that keeps section-update
// blocks out of the text shown while the reply streams.

export interface SseFrame {
  event: string
  data: string
}

// One frame per event. Comment lines and `id`/`retry` fields are ignored;
// multi-line `data` joins with newlines, per the spec.
export async function* parseSse(chunks: AsyncIterable<string>): AsyncGenerator<SseFrame> {
  let buffer = ''
  let event = 'message'
  let data: string[] = []

  const take = (): SseFrame | null => {
    const frame = data.length ? { event, data: data.join('\n') } : null
    event = 'message'
    data = []
    return frame
  }
  const feed = (line: string): SseFrame | null => {
    if (line === '') return take()
    if (line.startsWith(':')) return null
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    return null
  }

  for await (const chunk of chunks) {
    buffer += chunk
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const frame = feed(line)
      if (frame) yield frame
    }
  }
  if (buffer) feed(buffer)
  const last = take()
  if (last) yield last
}

export async function* bodyChunks(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      yield decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

export function readSseBody(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  return parseSse(bodyChunks(body))
}

const UPDATE_FENCE = '```section-update'

export interface StreamingReply {
  // Reply text with every section-update block removed, finished or not.
  visible: string
  // Section titles of the blocks seen so far, in order; '' until a block's
  // title line has arrived.
  drafting: string[]
}

export function splitStreamingReply(text: string): StreamingReply {
  let visible = ''
  const drafting: string[] = []
  let pos = 0
  while (true) {
    const start = text.indexOf(UPDATE_FENCE, pos)
    if (start === -1) {
      visible += text.slice(pos)
      break
    }
    visible += text.slice(pos, start)
    const headerEnd = text.indexOf('\n', start)
    const close = headerEnd === -1 ? -1 : text.indexOf('\n```', headerEnd)
    const block = text.slice(start, close === -1 ? undefined : close)
    drafting.push(/SECTION_TITLE:[ \t]*(.+)/.exec(block)?.[1]?.trim() ?? '')
    if (close === -1) break
    pos = close + 4
  }
  return { visible: visible.trim(), drafting }
}
