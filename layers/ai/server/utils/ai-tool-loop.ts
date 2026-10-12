// Provider-agnostic tool-call loop for `complete()`. Pure: the provider round
// trip is injected, so the loop is unit-testable without a key or a network.
// Speaks the OpenAI-compatible wire shape (`tool_calls` on the assistant turn,
// `role: 'tool'` results keyed by `tool_call_id`) that OpenRouter accepts for
// every model.
import type { AiTool, AiToolHandler, AiToolCallRecord } from '#core/ai-fallback/types'

export interface ProviderToolCall {
  id: string
  name: string
  // Raw JSON string of the call's arguments, as the provider returns it.
  arguments: string
}

export interface ProviderTurn {
  text: string
  finishReason: string
  toolCalls: ProviderToolCall[]
  // The provider's own content blocks for this turn, when it needs them sent
  // back unchanged on the next round (Anthropic's thinking blocks).
  native?: unknown[]
}

// One provider round trip: the full message list so far, the tool definitions
// to send (undefined = none), and whether the model may call them. Sending the
// definitions with calls forbidden keeps the request's cached prefix intact —
// tool definitions lead it — while still forcing a text answer.
export type ProviderCall = (
  apiMessages: unknown[],
  apiTools: unknown[] | undefined,
  allowToolCalls: boolean
) => Promise<ProviderTurn>

export interface CompletionLoopOptions {
  apiMessages: unknown[]
  tools?: AiTool[]
  onToolCall?: AiToolHandler
  maxToolRounds: number
  // Fires when a round that produced text ends in tool calls: that text is not
  // part of the reply, so a streaming consumer drops what it showed.
  onTextDiscard?: () => void
}

export interface CompletionLoopResult {
  text: string
  finishReason: string
  toolCalls: AiToolCallRecord[]
}

export function toApiTool(tool: AiTool): unknown {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }
}

function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

export async function runCompletionLoop(
  call: ProviderCall,
  opts: CompletionLoopOptions
): Promise<CompletionLoopResult> {
  const messages = [...opts.apiMessages]
  const apiTools = opts.tools?.length && opts.onToolCall ? opts.tools.map(toApiTool) : undefined
  const resolved: AiToolCallRecord[] = []

  for (let round = 0; ; round++) {
    // Past the round cap the tools stay in the request but may not be called,
    // which forces a text answer instead of another round of loading.
    const allowToolCalls = apiTools !== undefined && round < opts.maxToolRounds
    const turn = await call(messages, apiTools, allowToolCalls)

    if (!allowToolCalls || turn.toolCalls.length === 0) {
      return { text: turn.text, finishReason: turn.finishReason, toolCalls: resolved }
    }
    if (turn.text) opts.onTextDiscard?.()

    messages.push({
      role: 'assistant',
      content: turn.text || null,
      tool_calls: turn.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments || '{}' }
      })),
      ...(turn.native ? { native: turn.native } : {})
    })

    for (const tc of turn.toolCalls) {
      const input = parseToolArguments(tc.arguments)
      const result = await opts.onToolCall!(tc.name, input)
      resolved.push({ name: tc.name, input })
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result })
    }
  }
}
