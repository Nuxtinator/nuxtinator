// Translation between the OpenAI-compatible chat-completions shape the rest of
// the client speaks and Anthropic's Messages API (`POST /v1/messages`). Pure —
// unit-tested without a network.
//
// Requests: system messages become the top-level `system` blocks; tool
// results become `tool_result` blocks in a user turn; images become base64
// image blocks; `cache_control` on text parts carries over. An assistant turn
// that came from Anthropic keeps its original content blocks (`native`), so
// thinking blocks go back unchanged on the next tool round as the API
// requires. A forced tool call is sent as `auto` with a closing instruction,
// since newer models reject forced `tool_choice`.
//
// Responses: text and `tool_use` blocks map to the OpenAI-style message and
// tool calls, the stop reason to a finish reason, and the usage block to the
// OpenRouter-style fields the usage log reads.
import { createError } from 'h3'
import type { ProviderToolCall } from './ai-tool-loop'
import type { StreamedTurn } from './ai-stream'

type Json = Record<string, unknown>

// An assistant message carrying the content blocks Anthropic returned.
export interface NativeAssistantMessage {
  role: 'assistant'
  content: unknown
  tool_calls?: unknown[]
  native?: unknown[]
}

function textBlock(part: Json): Json {
  return {
    type: 'text',
    text: String(part.text ?? ''),
    ...(part.cache_control ? { cache_control: part.cache_control } : {})
  }
}

function imageBlock(part: Json): Json | null {
  const url = String((part.image_url as Json | undefined)?.url ?? '')
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  if (!match) return null
  return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }
}

// OpenAI-style message content → Anthropic content (string or blocks).
function toContent(content: unknown): string | Json[] {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const out: Json[] = []
  for (const part of content as Json[]) {
    if (part?.type === 'text') out.push(textBlock(part))
    else if (part?.type === 'image_url') {
      const img = imageBlock(part)
      if (img) out.push(img)
    }
  }
  return out
}

function toSystemBlocks(content: unknown): Json[] {
  const c = toContent(content)
  return typeof c === 'string' ? (c ? [{ type: 'text', text: c }] : []) : c.filter(b => b.type === 'text')
}

function parseArguments(raw: unknown): Json {
  if (typeof raw !== 'string' || !raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function assistantContent(m: NativeAssistantMessage): string | Json[] {
  if (Array.isArray(m.native)) return m.native as Json[]
  const blocks: Json[] = []
  const text = typeof m.content === 'string' ? m.content : ''
  if (text) blocks.push({ type: 'text', text })
  for (const tc of (m.tool_calls ?? []) as Json[]) {
    const fn = (tc.function ?? {}) as Json
    blocks.push({ type: 'tool_use', id: String(tc.id ?? ''), name: String(fn.name ?? ''), input: parseArguments(fn.arguments) })
  }
  if (blocks.length === 1 && blocks[0]!.type === 'text') return text
  return blocks
}

// OpenAI-style messages → Anthropic `system` + `messages`. Consecutive tool
// results share one user turn.
export function toAnthropicMessages(messages: unknown[]): { system: Json[], messages: Json[] } {
  const system: Json[] = []
  const out: Json[] = []
  for (const raw of messages as Json[]) {
    if (raw.role === 'system') {
      system.push(...toSystemBlocks(raw.content))
      continue
    }
    if (raw.role === 'tool') {
      const result = { type: 'tool_result', tool_use_id: String(raw.tool_call_id ?? ''), content: String(raw.content ?? '') }
      const last = out[out.length - 1]
      if (last?.role === 'user' && Array.isArray(last.content) && (last.content as Json[]).every(b => b.type === 'tool_result')) {
        (last.content as Json[]).push(result)
      } else {
        out.push({ role: 'user', content: [result] })
      }
      continue
    }
    if (raw.role === 'assistant') {
      out.push({ role: 'assistant', content: assistantContent(raw as unknown as NativeAssistantMessage) })
      continue
    }
    out.push({ role: 'user', content: toContent(raw.content) })
  }
  return { system, messages: out }
}

// An OpenAI-style chat-completions body → an Anthropic Messages body. Fields
// the Messages API shares or that came from the model's reasoning spec
// (`output_config`) pass through.
export function toAnthropicBody(body: Json): Json {
  const { model, messages, max_tokens, temperature, tools, tool_choice, stream, ...rest } = body
  const converted = toAnthropicMessages(messages as unknown[])
  const out: Json = { model, max_tokens, messages: converted.messages, ...rest }

  if (Array.isArray(tools) && tools.length) {
    out.tools = (tools as Json[]).map((t) => {
      const fn = (t.function ?? {}) as Json
      return { name: fn.name, description: fn.description, input_schema: fn.parameters }
    })
  }
  if (tool_choice === 'none') {
    out.tool_choice = { type: 'none' }
  } else if (tool_choice && typeof tool_choice === 'object') {
    const name = String(((tool_choice as Json).function as Json | undefined)?.name ?? '')
    out.tool_choice = { type: 'auto', disable_parallel_tool_use: true }
    converted.system.push({ type: 'text', text: `Respond only by calling the ${name} tool.` })
  }
  if (converted.system.length) out.system = converted.system
  if (temperature !== undefined) out.temperature = temperature
  if (stream) out.stream = true
  return out
}

function finishReasonOf(stopReason: unknown): string {
  switch (stopReason) {
    case 'max_tokens': return 'length'
    case 'tool_use': return 'tool_calls'
    case 'refusal': return 'refusal'
    default: return 'stop'
  }
}

// Anthropic usage → the OpenRouter-style fields the usage log reads.
export function anthropicUsage(usage: unknown): Json | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const u = usage as Record<string, number | undefined>
  const cached = u.cache_read_input_tokens ?? 0
  const written = u.cache_creation_input_tokens ?? 0
  return {
    prompt_tokens: (u.input_tokens ?? 0) + cached + written,
    completion_tokens: u.output_tokens ?? 0,
    prompt_tokens_details: { cached_tokens: cached, cache_write_tokens: written }
  }
}

function toolCallsOf(blocks: Json[]): ProviderToolCall[] {
  return blocks
    .filter(b => b.type === 'tool_use')
    .map(b => ({ id: String(b.id ?? ''), name: String(b.name ?? ''), arguments: JSON.stringify(b.input ?? {}) }))
}

function textOf(blocks: Json[]): string {
  return blocks.filter(b => b.type === 'text').map(b => String(b.text ?? '')).join('')
}

// A Messages API response → the chat-completions response shape, with the
// original content blocks on the message as `native`.
export function fromAnthropicResponse(data: unknown): Json {
  const d = (data ?? {}) as Json
  const blocks = Array.isArray(d.content) ? d.content as Json[] : []
  const toolCalls = toolCallsOf(blocks)
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: textOf(blocks),
        tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } })),
        native: blocks
      },
      finish_reason: finishReasonOf(d.stop_reason)
    }],
    usage: anthropicUsage(d.usage)
  }
}

export interface AnthropicStreamedTurn extends StreamedTurn {
  native: unknown[]
}

// Reader for a streamed Messages response: SSE `event:`/`data:` pairs. Blocks
// are reassembled by index (tool inputs arrive as JSON fragments, thinking
// text and signatures as deltas); text fragments go to `onTextDelta`.
export async function readAnthropicStream(
  chunks: AsyncIterable<string>,
  onTextDelta?: (delta: string) => void
): Promise<AnthropicStreamedTurn> {
  const blocks = new Map<number, Json>()
  const partialJson = new Map<number, string>()
  let stopReason: unknown = null
  let usage: Record<string, number> = {}
  let buffer = ''

  const handle = (line: string): boolean => {
    if (!line.startsWith('data:')) return false
    let ev: Json
    try {
      ev = JSON.parse(line.slice(5).trim())
    } catch {
      return false
    }
    switch (ev.type) {
      case 'message_start':
        usage = { ...usage, ...((ev.message as Json | undefined)?.usage as Record<string, number> ?? {}) }
        break
      case 'content_block_start':
        blocks.set(Number(ev.index), { ...(ev.content_block as Json) })
        break
      case 'content_block_delta': {
        const index = Number(ev.index)
        const block = blocks.get(index)
        const delta = (ev.delta ?? {}) as Json
        if (!block) break
        if (delta.type === 'text_delta') {
          const text = String(delta.text ?? '')
          block.text = String(block.text ?? '') + text
          if (text) onTextDelta?.(text)
        } else if (delta.type === 'input_json_delta') {
          partialJson.set(index, (partialJson.get(index) ?? '') + String(delta.partial_json ?? ''))
        } else if (delta.type === 'thinking_delta') {
          block.thinking = String(block.thinking ?? '') + String(delta.thinking ?? '')
        } else if (delta.type === 'signature_delta') {
          block.signature = String(delta.signature ?? '')
        }
        break
      }
      case 'content_block_stop': {
        const index = Number(ev.index)
        const block = blocks.get(index)
        if (block?.type === 'tool_use') block.input = parseArguments(partialJson.get(index) || '{}')
        break
      }
      case 'message_delta':
        if ((ev.delta as Json | undefined)?.stop_reason) stopReason = (ev.delta as Json).stop_reason
        usage = { ...usage, ...((ev.usage as Record<string, number> | undefined) ?? {}) }
        break
      case 'message_stop':
        return true
      case 'error':
        if (!process.env.VITEST) console.error('[ai] Anthropic stream error:', JSON.stringify(ev.error).slice(0, 500))
        throw createError({ statusCode: 502, statusMessage: 'The AI provider failed mid-response. Try again.' })
    }
    return false
  }

  outer:
  for await (const chunk of chunks) {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const raw of lines) {
      if (handle(raw.replace(/\r$/, ''))) break outer
    }
  }
  if (buffer) handle(buffer.replace(/\r$/, ''))

  const native = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b)
  return {
    text: textOf(native),
    finishReason: finishReasonOf(stopReason),
    toolCalls: toolCallsOf(native),
    usage: anthropicUsage(usage),
    native
  }
}
