// OpenRouter stream reassembly: text fragments forwarded and joined, tool-call
// argument fragments merged by index, lines split across chunks, keep-alive
// comments ignored, an error chunk surfaced as a retryable failure.
import { describe, it, expect } from 'vitest'
import { readCompletionStream } from '../../server/utils/ai-stream'

async function* chunks(parts: string[]): AsyncIterable<string> {
  for (const p of parts) yield p
}

function data(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

describe('readCompletionStream', () => {
  it('joins text deltas, forwards each one, and reads the finish reason and usage', async () => {
    const seen: string[] = []
    const turn = await readCompletionStream(chunks([
      ': OPENROUTER PROCESSING\n\n',
      data({ choices: [{ delta: { content: 'Hel' } }] }),
      data({ choices: [{ delta: { content: 'lo' }, finish_reason: null }] }),
      data({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      data({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
      'data: [DONE]\n\n'
    ]), d => seen.push(d))
    expect(turn.text).toBe('Hello')
    expect(seen).toEqual(['Hel', 'lo'])
    expect(turn.finishReason).toBe('stop')
    expect(turn.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2 })
    expect(turn.toolCalls).toEqual([])
  })

  it('reassembles tool calls from index-keyed fragments in order', async () => {
    const turn = await readCompletionStream(chunks([
      data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'load_section', arguments: '' } }] } }] }),
      data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"section_' } }] } }] }),
      data({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'load_portfolio', arguments: '{}' } }] } }] }),
      data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'key":"team"}' } }] }, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n'
    ]))
    expect(turn.finishReason).toBe('tool_calls')
    expect(turn.toolCalls).toEqual([
      { id: 'c1', name: 'load_section', arguments: '{"section_key":"team"}' },
      { id: 'c2', name: 'load_portfolio', arguments: '{}' }
    ])
  })

  it('handles lines split across chunks and CRLF line ends', async () => {
    const whole = data({ choices: [{ delta: { content: 'split' } }] }).replace(/\n/g, '\r\n')
    const cut = 20
    const turn = await readCompletionStream(chunks([whole.slice(0, cut), whole.slice(cut), 'data: [DONE]\r\n\r\n']))
    expect(turn.text).toBe('split')
  })

  it('stops reading at [DONE] and tolerates a stream that ends without it', async () => {
    const stopped = await readCompletionStream(chunks([
      data({ choices: [{ delta: { content: 'a' } }] }),
      'data: [DONE]\n\n',
      data({ choices: [{ delta: { content: 'ignored' } }] })
    ]))
    expect(stopped.text).toBe('a')
    const unterminated = await readCompletionStream(chunks([data({ choices: [{ delta: { content: 'b' } }] }).trimEnd()]))
    expect(unterminated.text).toBe('b')
  })

  it('surfaces an error chunk as a retryable failure', async () => {
    await expect(readCompletionStream(chunks([
      data({ choices: [{ delta: { content: 'partial' } }] }),
      data({ error: { code: 502, message: 'upstream' } })
    ]))).rejects.toMatchObject({ statusCode: 502 })
  })
})
