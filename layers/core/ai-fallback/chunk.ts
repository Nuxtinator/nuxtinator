// Markdown chunker for vector indexing. Pure; shared by every indexing layer
// through `#ai/server` (see vectors.ts for why it lives in core).
//
// Strategy: split on ATX headings first so each chunk carries the heading it
// sits under, then pack paragraphs up to `maxChars`, then hard-wrap any single
// paragraph that is still too long. Consecutive chunks overlap by
// `overlapChars` (taken from the tail of the previous chunk) so a sentence cut
// at a boundary is still findable.

export interface AiChunk {
  ordinal: number
  // Nearest heading above the chunk ('' at the top of a document).
  heading: string
  text: string
}

export interface AiChunkOptions {
  maxChars?: number
  overlapChars?: number
}

const DEFAULT_MAX = 2000
const DEFAULT_OVERLAP = 200

interface Block {
  heading: string
  text: string
}

// Split into (heading, body) blocks at every ATX heading line.
function splitOnHeadings(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let heading = ''
  let buf: string[] = []
  const flush = () => {
    const text = buf.join('\n').trim()
    if (text) blocks.push({ heading, text })
    buf = []
  }
  for (const line of lines) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (m) {
      flush()
      heading = m[1]!.trim()
      continue
    }
    buf.push(line)
  }
  flush()
  return blocks
}

// Break one paragraph that exceeds `max` at sentence ends where possible, else
// at whitespace, else hard.
function hardWrap(text: string, max: number): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > max) {
    const window = rest.slice(0, max)
    const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('.\n'), window.lastIndexOf('! '), window.lastIndexOf('? '))
    let cut: number
    if (sentence > max * 0.4) {
      cut = sentence + 1
    } else {
      const space = window.lastIndexOf(' ')
      cut = space > max * 0.4 ? space : max
    }
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out
}

export function chunkMarkdown(markdown: string, opts: AiChunkOptions = {}): AiChunk[] {
  const max = Math.max(200, opts.maxChars ?? DEFAULT_MAX)
  const overlap = Math.min(Math.max(0, opts.overlapChars ?? DEFAULT_OVERLAP), Math.floor(max / 2))
  const chunks: AiChunk[] = []
  let previousTail = ''

  const push = (heading: string, text: string) => {
    const body = text.trim()
    if (!body) return
    const prefix = previousTail ? `${previousTail}\n\n` : ''
    chunks.push({ ordinal: chunks.length, heading, text: `${prefix}${body}` })
    previousTail = overlap > 0 ? body.slice(-overlap).trimStart() : ''
  }

  for (const block of splitOnHeadings(markdown)) {
    const paragraphs = block.text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
    let buf = ''
    for (const para of paragraphs) {
      const pieces = para.length > max ? hardWrap(para, max) : [para]
      for (const piece of pieces) {
        if (!buf) {
          buf = piece
          continue
        }
        if (buf.length + 2 + piece.length <= max) {
          buf = `${buf}\n\n${piece}`
        } else {
          push(block.heading, buf)
          buf = piece
        }
      }
    }
    if (buf) push(block.heading, buf)
  }
  return chunks
}
