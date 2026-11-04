// Reader for OpenRouter's streamed chat-completions body: SSE `data:` lines
// carrying chunk JSON, `[DONE]` last, comment lines in between as keep-alives.
// Pure — it consumes any async iterable of text, so it is unit-tested without
// a network — and reassembles the shape a non-streamed response yields: the
// text, the tool calls (which arrive as index-keyed argument fragments), the
// finish reason and the usage block. Text fragments are handed to
// `onTextDelta` as they land.
import { createError } from 'h3'
import type { ProviderToolCall } from './ai-tool-loop'

export interface StreamedTurn {
  text: string
  finishReason: string
  toolCalls: ProviderToolCall[]
  usage: unknown
}

export async function readCompletionStream(
  chunks: AsyncIterable<string>,
  onTextDelta?: (delta: string) => void
): Promise<StreamedTurn> {
  const calls = new Map<number, ProviderToolCall>()
  let text = ''
  let finishReason = 'stop'
  let usage: unknown
  let buffer = ''

  const handleLine = (line: string): boolean => {
    if (line === '' || line.startsWith(':') || !line.startsWith('data:')) return false
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') return true
    let chunk: any
    try {
      chunk = JSON.parse(payload)
    } catch {
      return false
    }
    if (chunk?.error) {
      if (!process.env.VITEST) console.error('[ai] OpenRouter stream error:', JSON.stringify(chunk.error).slice(0, 500))
      throw createError({ statusCode: 502, statusMessage: 'The AI provider failed mid-response. Try again.' })
    }
    if (chunk?.usage) usage = chunk.usage
    const choice = chunk?.choices?.[0]
    if (!choice) return false
    if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason
    const delta = choice.delta ?? {}
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      text += delta.content
      onTextDelta?.(delta.content)
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const index = typeof tc?.index === 'number' ? tc.index : 0
        const call = calls.get(index) ?? { id: '', name: '', arguments: '' }
        if (typeof tc?.id === 'string' && tc.id) call.id = tc.id
        if (typeof tc?.function?.name === 'string' && tc.function.name) call.name = tc.function.name
        if (typeof tc?.function?.arguments === 'string') call.arguments += tc.function.arguments
        calls.set(index, call)
      }
    }
    return false
  }

  outer:
  for await (const chunk of chunks) {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const raw of lines) {
      if (handleLine(raw.replace(/\r$/, ''))) break outer
    }
  }
  if (buffer) handleLine(buffer.replace(/\r$/, ''))

  return {
    text,
    finishReason,
    toolCalls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call),
    usage
  }
}
