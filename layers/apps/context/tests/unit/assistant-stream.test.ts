// The client-side stream helpers: SSE frames reassembled from arbitrary
// chunking, and section-update blocks kept out of streamed text.
import { describe, it, expect } from 'vitest'
import { parseSse, splitStreamingReply } from '../../app/utils/assistant-stream'

async function* chunks(parts: string[]): AsyncIterable<string> {
  for (const p of parts) yield p
}

async function frames(parts: string[]) {
  const out: Array<{ event: string, data: string }> = []
  for await (const f of parseSse(chunks(parts))) out.push(f)
  return out
}

describe('parseSse', () => {
  it('yields one frame per event, joins multi-line data, and skips comments', async () => {
    const out = await frames([
      ': keep-alive\n\nevent: status\ndata: {"text":"Reading Team…"}\n\n',
      'data: line one\ndata: line two\n\n'
    ])
    expect(out).toEqual([
      { event: 'status', data: '{"text":"Reading Team…"}' },
      { event: 'message', data: 'line one\nline two' }
    ])
  })

  it('handles a frame split across chunks, CRLF endings, and a missing final blank line', async () => {
    const out = await frames(['event: del', 'ta\r\ndata: {"te', 'xt":"hi"}\r\n\r\nevent: done\r\ndata: {}'])
    expect(out).toEqual([
      { event: 'delta', data: '{"text":"hi"}' },
      { event: 'done', data: '{}' }
    ])
  })
})

describe('splitStreamingReply', () => {
  it('hides an unfinished block and names the section once its title has streamed', () => {
    const before = splitStreamingReply('Here is the update:\n\n```section-update\nSECTION_KEY: team\nSECTION_TI')
    expect(before).toEqual({ visible: 'Here is the update:', drafting: [''] })
    const after = splitStreamingReply('Here is the update:\n\n```section-update\nSECTION_KEY: team\nSECTION_TITLE: Team\n---\nNew te')
    expect(after).toEqual({ visible: 'Here is the update:', drafting: ['Team'] })
  })

  it('hides finished blocks and keeps the text around them', () => {
    const text = 'Two changes.\n\n```section-update\nSECTION_KEY: team\nSECTION_TITLE: Team\n---\nA\n```\n\nAnd also:\n\n```section-update\nSECTION_KEY: vision\nSECTION_TITLE: Vision\n---\nB\n```\n\nDone.'
    expect(splitStreamingReply(text)).toEqual({ visible: 'Two changes.\n\n\n\nAnd also:\n\n\n\nDone.', drafting: ['Team', 'Vision'] })
    expect(splitStreamingReply('Plain reply, no blocks.')).toEqual({ visible: 'Plain reply, no blocks.', drafting: [] })
  })
})
