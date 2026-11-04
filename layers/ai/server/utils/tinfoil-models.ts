// Pure: Tinfoil's model catalog (the JSON its pricing page reads) → the chat,
// transcription and decision models this layer can run. Chat models must
// support tool calling on /v1/chat/completions; transcription models must take
// a file on /v1/audio/transcriptions (streaming-only audio models are
// skipped); decision models must serve /v1/decisions. Reasoning
// on/off request fragments are read from each model's `chatConfig`, so no model
// name lives in code.
import type { AiProviderModelInfo, AiReasoningSpec } from '../../types/ai-ext'
import { TINFOIL_MODEL_PREFIX } from './ai-provider'

const CHAT_ENDPOINT = '/v1/chat/completions'
const TRANSCRIPTION_ENDPOINT = '/v1/audio/transcriptions'
const DECISION_ENDPOINT = '/v1/decisions'

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
}

function price(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

function parseReasoning(chatConfig: Record<string, unknown> | null): AiReasoningSpec | null {
  const cfg = asRecord(chatConfig?.reasoningConfig)
  const params = asRecord(asRecord(cfg?.params)?.[CHAT_ENDPOINT])
  if (!cfg || !params) return null
  const enable = asRecord(params.enable)
  const disable = asRecord(params.disable)
  if (!enable && !disable) return null
  const effortMap: AiReasoningSpec['effortMap'] = {}
  const rawMap = asRecord(cfg.effortMap) ?? {}
  for (const level of ['low', 'medium', 'high'] as const) {
    if (typeof rawMap[level] === 'string') effortMap[level] = rawMap[level] as string
  }
  return { enable, disable, effortMap }
}

export function parseTinfoilModels(payload: unknown): AiProviderModelInfo[] {
  const list = Array.isArray(payload) ? payload : []
  const out: AiProviderModelInfo[] = []
  const seen = new Set<string>()
  for (const raw of list) {
    const m = asRecord(raw)
    if (!m) continue
    const name = typeof m.modelName === 'string' ? m.modelName.trim() : ''
    if (!name || seen.has(name)) continue
    const endpoints = Array.isArray(m.endpoints) ? m.endpoints.filter(e => typeof e === 'string') as string[] : []
    const isChat = m.type === 'chat' && m.toolCalling === true && endpoints.includes(CHAT_ENDPOINT)
    const isTranscription = m.type === 'audio' && endpoints.includes(TRANSCRIPTION_ENDPOINT)
    const isDecision = m.type === 'decision' && endpoints.includes(DECISION_ENDPOINT)
    if (!isChat && !isTranscription && !isDecision) continue
    seen.add(name)
    const pricing = asRecord(m.pricing) ?? {}
    const requestPrice = price(pricing.requestPrice)
    const chatConfig = asRecord(m.chatConfig)
    out.push({
      id: `${TINFOIL_MODEL_PREFIX}${name}`,
      name: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : name,
      provider: 'tinfoil',
      kind: isChat ? 'chat' : isTranscription ? 'transcription' : 'decision',
      promptPrice: price(pricing.inputTokenPricePer1M),
      completionPrice: price(pricing.outputTokenPricePer1M),
      requestPrice: requestPrice && requestPrice > 0 ? requestPrice : null,
      contextLength: typeof m.contextWindowTokens === 'number' && m.contextWindowTokens > 0 ? m.contextWindowTokens : null,
      supportsTemperature: isChat,
      supportsCaching: false,
      supportsImages: isChat && m.multimodal === true,
      reasoning: isChat ? parseReasoning(chatConfig) : null
    })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}
