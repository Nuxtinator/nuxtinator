// Type surface this layer adds on top of core's `#core/ai-fallback/types`:
// providers, model kinds (chat vs transcription), image content, reasoning
// levels and transcription. Pure types, outside `server/utils/` so auto-import
// ignores it; imported by both the server code and the `#ai` client alias.

import type {
  AiCompleteOptions,
  AiCompletionRun,
  AiContent,
  AiFeature,
  AiGenerateOptions,
  AiModelInfo,
  AiScoped,
  AiTextPart
} from '#core/ai-fallback/types'

export type AiProvider = 'openrouter' | 'tinfoil' | 'openai' | 'anthropic'

// What a model is used for: chat completions (complete/generate) or
// speech-to-text (transcribe).
export type AiModelKind = 'chat' | 'transcription'

// Per-call reasoning request. Sent only to models whose catalog entry says how
// to turn reasoning on or off; ignored elsewhere.
export type AiReasoningLevel = 'off' | 'low' | 'medium' | 'high'

// An inline image, base64-encoded without the `data:` prefix.
export interface AiImagePart {
  type: 'image'
  mediaType: string
  data: string
}

export type AiContentPart = AiTextPart | AiImagePart
export type AiRichContent = string | AiContentPart[]

export interface AiRichMessage {
  role: 'system' | 'user' | 'assistant'
  content: AiRichContent
}

// How a model's request body turns reasoning on and off, as its provider
// catalog describes it. `enable` may contain the string "$EFFORT", replaced by
// the requested level (mapped through `effortMap` when present).
export interface AiReasoningSpec {
  enable: Record<string, unknown> | null
  disable: Record<string, unknown> | null
  effortMap: Partial<Record<'low' | 'medium' | 'high', string>>
}

export interface AiProviderModelInfo extends AiModelInfo {
  provider: AiProvider
  kind: AiModelKind
  supportsImages: boolean
  // USD per request for request-priced models; null when priced by token.
  requestPrice: number | null
  reasoning: AiReasoningSpec | null
}

// Which kind of model powers a feature: a chat or transcription model it
// picks per feature, or (for 'embedding') the scope's one embedding model.
export type AiFeatureKind = AiModelKind | 'embedding'

export type AiFeatureDef = Omit<AiFeature, 'kind'> & {
  // Default 'chat'.
  kind?: AiFeatureKind
}

// Omit applied to each member of a union, so the tx-or-run choice in the
// option types survives.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export type AiRichCompleteOptions = DistributiveOmit<AiCompleteOptions, 'system' | 'messages'> & {
  system?: AiContent
  messages: AiRichMessage[]
  reasoning?: AiReasoningLevel
}

export type AiRichGenerateOptions = DistributiveOmit<AiGenerateOptions, 'system' | 'messages'> & {
  system?: AiContent
  messages: AiRichMessage[]
  reasoning?: AiReasoningLevel
}

export type AiTranscribeOptions = AiScoped<AiCompletionRun> & {
  // A registered feature of kind 'transcription'. Ignored when `run` is given.
  feature: string
  audio: Uint8Array | Blob
  mimeType: string
  filename?: string
  // Vocabulary / context hint (names, jargon) for models that accept one.
  prompt?: string
  // ISO-639-1 code; omitted = auto-detect.
  language?: string
}

export interface AiTranscribeResult {
  text: string
  model: string
}
