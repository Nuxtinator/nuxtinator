// Translation to and from Anthropic's Messages API: system and tool-result
// placement, image and cache-control mapping, forced tool calls sent as auto,
// thinking blocks carried back unchanged, and stream reassembly.
import { describe, it, expect } from 'vitest'
import { fromAnthropicResponse, readAnthropicStream, toAnthropicBody } from '../../server/utils/anthropic-messages'

async function* chunks(parts: string[]): AsyncIterable<string> {
  for (const p of parts) yield p
}

function event(obj: { type: string } & Record<string, unknown>): string {
  return `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`
}

describe('toAnthropicBody', () => {
  it('lifts system messages, keeps cache control, and converts images', () => {
    const body = toAnthropicBody({
      model: 'claude-opus-5-5',
      max_tokens: 1000,
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Grounding', cache_control: { type: 'ephemeral' } }] },
        { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }
      ]
    })
    expect(body.system).toEqual([{ type: 'text', text: 'Grounding', cache_control: { type: 'ephemeral' } }])
    expect(body.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
      ]
    }])
  })

  it('turns tool rounds into tool_use and grouped tool_result blocks, preferring native content', () => {
    const native = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'load', input: { k: 1 } }]
    const body = toAnthropicBody({
      model: 'm',
      max_tokens: 10,
      messages: [
        { role: 'user', content: 'Go' },
        { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'load', arguments: '{"k":1}' } }], native },
        { role: 'tool', tool_call_id: 't1', content: 'one' },
        { role: 'assistant', content: 'Next', tool_calls: [{ id: 't2', type: 'function', function: { name: 'a', arguments: '{}' } }, { id: 't3', type: 'function', function: { name: 'b', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 't2', content: 'two' },
        { role: 'tool', tool_call_id: 't3', content: 'three' }
      ]
    })
    const messages = body.messages as { role: string, content: unknown }[]
    expect(messages[1]!.content).toBe(native)
    expect(messages[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'one' }] })
    expect(messages[3]!.content).toEqual([
      { type: 'text', text: 'Next' },
      { type: 'tool_use', id: 't2', name: 'a', input: {} },
      { type: 'tool_use', id: 't3', name: 'b', input: {} }
    ])
    expect((messages[4]!.content as unknown[]).length).toBe(2)
  })

  it('sends a forced tool call as auto with an instruction, and tool_choice none as none', () => {
    const tools = [{ type: 'function', function: { name: 'submit', description: 'Submit', parameters: { type: 'object' } } }]
    const forced = toAnthropicBody({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'x' }], tools, tool_choice: { type: 'function', function: { name: 'submit' } } })
    expect(forced.tools).toEqual([{ name: 'submit', description: 'Submit', input_schema: { type: 'object' } }])
    expect(forced.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true })
    expect(forced.system).toEqual([{ type: 'text', text: 'Respond only by calling the submit tool.' }])

    const none = toAnthropicBody({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'x' }], tools, tool_choice: 'none' })
    expect(none.tool_choice).toEqual({ type: 'none' })
  })
})

describe('fromAnthropicResponse', () => {
  it('maps text, tool calls, stop reason and usage', () => {
    const data = fromAnthropicResponse({
      content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'Hi' }, { type: 'tool_use', id: 'x', name: 'f', input: { a: 1 } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 }
    }) as { choices: { message: Record<string, unknown>, finish_reason: string }[], usage: Record<string, unknown> }
    const choice = data.choices[0]!
    expect(choice.message.content).toBe('Hi')
    expect(choice.message.tool_calls).toEqual([{ id: 'x', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }])
    expect((choice.message.native as unknown[]).length).toBe(3)
    expect(choice.finish_reason).toBe('tool_calls')
    expect(data.usage).toEqual({ prompt_tokens: 110, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 0 } })
  })

  it('maps max_tokens to length and refusal to refusal', () => {
    expect((fromAnthropicResponse({ content: [], stop_reason: 'max_tokens' }) as any).choices[0].finish_reason).toBe('length')
    expect((fromAnthropicResponse({ content: [], stop_reason: 'refusal' }) as any).choices[0].finish_reason).toBe('refusal')
  })
})

describe('readAnthropicStream', () => {
  it('reassembles text, tool input and thinking signatures', async () => {
    const seen: string[] = []
    const turn = await readAnthropicStream(chunks([
      event({ type: 'message_start', message: { usage: { input_tokens: 7 } } }),
      event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      event({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }),
      event({ type: 'content_block_stop', index: 0 }),
      event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hel' } }),
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_d',
      'elta","text":"lo"}}\n\n',
      event({ type: 'content_block_stop', index: 1 }),
      event({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'c1', name: 'load', input: {} } }),
      event({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"key":' } }),
      event({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"team"}' } }),
      event({ type: 'content_block_stop', index: 2 }),
      event({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }),
      event({ type: 'message_stop' })
    ]), d => seen.push(d))

    expect(seen).toEqual(['Hel', 'lo'])
    expect(turn.text).toBe('Hello')
    expect(turn.finishReason).toBe('tool_calls')
    expect(turn.toolCalls).toEqual([{ id: 'c1', name: 'load', arguments: '{"key":"team"}' }])
    expect(turn.native[0]).toEqual({ type: 'thinking', thinking: '', signature: 'sig' })
    expect(turn.usage).toMatchObject({ prompt_tokens: 7, completion_tokens: 9 })
  })

  it('surfaces a stream error as a retryable failure', async () => {
    await expect(readAnthropicStream(chunks([
      event({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })
    ]))).rejects.toMatchObject({ statusCode: 502 })
  })
})
