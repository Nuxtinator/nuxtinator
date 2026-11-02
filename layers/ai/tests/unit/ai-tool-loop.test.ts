// The provider-agnostic tool loop: resolves tool calls through the handler,
// feeds results back in the OpenAI wire shape, stops on a text answer, and
// forces a text answer once the round cap is hit.
import { describe, it, expect } from 'vitest'
import { runCompletionLoop, type ProviderCall, type ProviderTurn } from '../../server/utils/ai-tool-loop'

const TOOL = { name: 'load', description: 'Load a thing', parameters: { type: 'object', properties: {} } }

function scripted(turns: ProviderTurn[]): { call: ProviderCall, seen: Array<{ messages: unknown[], tools: unknown[] | undefined, allowCalls: boolean }> } {
  const seen: Array<{ messages: unknown[], tools: unknown[] | undefined, allowCalls: boolean }> = []
  let i = 0
  const call: ProviderCall = async (messages, tools, allowCalls) => {
    seen.push({ messages: [...messages], tools, allowCalls })
    const turn = turns[Math.min(i, turns.length - 1)]!
    i++
    return turn
  }
  return { call, seen }
}

describe('runCompletionLoop', () => {
  it('returns the text answer when the model makes no tool calls', async () => {
    const { call, seen } = scripted([{ text: 'hi', finishReason: 'stop', toolCalls: [] }])
    const res = await runCompletionLoop(call, {
      apiMessages: [{ role: 'user', content: 'hello' }],
      tools: [TOOL],
      onToolCall: async () => 'unused',
      maxToolRounds: 4
    })
    expect(res.text).toBe('hi')
    expect(res.toolCalls).toEqual([])
    expect(seen).toHaveLength(1)
    expect(seen[0]!.tools).toHaveLength(1)
  })

  it('resolves tool calls and appends assistant + tool turns before asking again', async () => {
    const { call, seen } = scripted([
      { text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'load', arguments: '{"key":"a"}' }] },
      { text: 'done', finishReason: 'stop', toolCalls: [] }
    ])
    const handled: Array<{ name: string, input: Record<string, unknown> }> = []
    const res = await runCompletionLoop(call, {
      apiMessages: [{ role: 'user', content: 'go' }],
      tools: [TOOL],
      onToolCall: async (name, input) => {
        handled.push({ name, input })
        return 'RESULT'
      },
      maxToolRounds: 4
    })
    expect(res.text).toBe('done')
    expect(handled).toEqual([{ name: 'load', input: { key: 'a' } }])
    expect(res.toolCalls).toEqual([{ name: 'load', input: { key: 'a' } }])

    const second = seen[1]!.messages
    expect(second).toHaveLength(3)
    expect(second[1]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'c1', type: 'function' }] })
    expect(second[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'RESULT' })
  })

  it('keeps the tools but forbids calling them once the round cap is reached', async () => {
    const toolTurn: ProviderTurn = {
      text: '',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'c', name: 'load', arguments: '{}' }]
    }
    const { call, seen } = scripted([toolTurn, toolTurn, { text: 'forced', finishReason: 'stop', toolCalls: [] }])
    const res = await runCompletionLoop(call, {
      apiMessages: [],
      tools: [TOOL],
      onToolCall: async () => 'r',
      maxToolRounds: 2
    })
    expect(res.text).toBe('forced')
    expect(res.toolCalls).toHaveLength(2)
    expect(seen.every(s => s.tools !== undefined)).toBe(true)
    expect(seen.map(s => s.allowCalls)).toEqual([true, true, false])
  })

  it('offers no tools when no handler is given', async () => {
    const { call, seen } = scripted([{ text: 'x', finishReason: 'stop', toolCalls: [] }])
    await runCompletionLoop(call, { apiMessages: [], tools: [TOOL], maxToolRounds: 4 })
    expect(seen[0]!.tools).toBeUndefined()
  })

  it('passes an empty object for unparseable tool arguments', async () => {
    const { call } = scripted([
      { text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'load', arguments: 'not json' }] },
      { text: 'ok', finishReason: 'stop', toolCalls: [] }
    ])
    let got: Record<string, unknown> | null = null
    await runCompletionLoop(call, {
      apiMessages: [],
      tools: [TOOL],
      onToolCall: async (_n, input) => {
        got = input
        return ''
      },
      maxToolRounds: 4
    })
    expect(got).toEqual({})
  })
})

describe('runCompletionLoop text discard', () => {
  it('fires onTextDiscard when a round with text ends in tool calls, and not otherwise', async () => {
    const { call } = scripted([
      { text: 'Let me look.', finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'load', arguments: '{}' }] },
      { text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'c2', name: 'load', arguments: '{}' }] },
      { text: 'final', finishReason: 'stop', toolCalls: [] }
    ])
    let discards = 0
    const res = await runCompletionLoop(call, {
      apiMessages: [],
      tools: [TOOL],
      onToolCall: async () => 'r',
      maxToolRounds: 4,
      onTextDiscard: () => { discards++ }
    })
    expect(res.text).toBe('final')
    expect(discards).toBe(1)
  })

  it('keeps discarded text out of the history sent back to the model', async () => {
    const { call, seen } = scripted([
      {
        text: 'The answer is 42.',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'c1', name: 'load', arguments: '{}' }],
        native: [
          { type: 'thinking', thinking: 'hmm', signature: 'sig' },
          { type: 'text', text: 'The answer is 42.' },
          { type: 'tool_use', id: 'c1', name: 'load', input: {} }
        ]
      },
      { text: 'final', finishReason: 'stop', toolCalls: [] }
    ])
    await runCompletionLoop(call, {
      apiMessages: [],
      tools: [TOOL],
      onToolCall: async () => 'r',
      maxToolRounds: 4
    })
    expect(seen[1]!.messages[0]).toMatchObject({
      role: 'assistant',
      content: null,
      native: [
        { type: 'thinking', thinking: 'hmm', signature: 'sig' },
        { type: 'tool_use', id: 'c1', name: 'load', input: {} }
      ]
    })
  })
})
