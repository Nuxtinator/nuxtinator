import { createError } from 'h3'
import type {
  AiCompleteResult,
  AiCompletionRun,
  AiContent,
  AiDbClient,
  AiEmbeddingRun,
  AiEmbedOptions,
  AiEmbedResult,
  AiGenerateResult,
  AiTextPart
} from '#core/ai-fallback/types'
import { AI_EMBED_DIMENSIONS } from '#core/ai-fallback/vectors'
import type {
  AiContentPart,
  AiProvider,
  AiProviderModelInfo,
  AiRichCompleteOptions,
  AiRichContent,
  AiRichGenerateOptions,
  AiRichMessage,
  AiTranscribeOptions,
  AiTranscribeResult
} from '../../types/ai-ext'
import { getAnthropicConfig, getOpenAiConfig, getOpenRouterConfig } from './ai-config'
import { ANTHROPIC_VERSION, getAllModels, getModelInfo, supportsTemperature } from './ai-model-list'
import { getOrgApiKey, getHostApiKey, getProviderApiKey, loadModelList, resolveFeatureModel, resolveEmbeddingModel } from './ai-settings'
import { getAiFeatureKind } from './ai-feature-registry'
import { AI_PROVIDERS, AI_PROVIDER_LABELS, providerOf, reasoningParams, wireModelId } from './ai-provider'
import { tinfoilFetch } from './tinfoil-client'
import { runCompletionLoop, type ProviderCall, type ProviderToolCall, type ProviderTurn } from './ai-tool-loop'
import { readCompletionStream, type StreamedTurn } from './ai-stream'
import { fromAnthropicResponse, readAnthropicStream, toAnthropicBody } from './anthropic-messages'
import { aiFakeComplete, aiFakeGenerate, aiFakeEmbed, aiFakeTranscribe } from './ai-test-fake'
import { withAiRetries } from './ai-retry'

// Chat and transcription client for four providers, picked by the resolved
// model id: OpenRouter and OpenAI (plain fetch to their OpenAI-compatible
// APIs), Tinfoil (the attested, body-encrypting fetch in tinfoil-client.ts)
// and Anthropic (plain fetch to the Messages API, translated to and from the
// OpenAI-compatible shape in anthropic-messages.ts). No provider SDKs,
// sidestepping the `@anthropic-ai/sdk` bundling caveats. `complete()` returns
// assistant text, resolving any tool calls the model makes through the
// caller's handler (see ai-tool-loop.ts);
// `generate()` forces a single tool call and returns its parsed arguments as
// structured output. Given `onTextDelta`, `complete()` streams each round and
// hands reply text over as it arrives (ai-stream.ts reassembles the turn).
//
// Both take the caller's `tx` and a feature key and resolve the key and model
// themselves (ai-settings.ts): the org's own key and choices when it has them,
// the host's otherwise. Under VITEST both route to the primeable fake in
// ai-test-fake.ts instead of the network.
//
// `transcribe()` sends an audio file to a transcription-kind feature's model.
//
// Error contract (consumers branch on these): 400 = the request can't run on
// the resolved model (e.g. images to a text-only model); 503 = not configured;
// 502 = transient upstream (retry); 500 = auth/other misconfig (check server logs).
// Non-streaming round trips retry 502s themselves (ai-retry.ts) before one
// surfaces. The raw provider message is never forwarded to the client.

// Under VITEST a feature with no configured model still runs against the fake.
const AI_TEST_FALLBACK_MODEL = 'test/alpha'
const AI_TEST_FALLBACK_TRANSCRIPTION_MODEL = 'test/whisper'

// Whether live generation is possible for the active org: for some provider,
// its own key, or the host's when it has none. Under VITEST it's always
// "configured" so suites run without a key — the network boundary is stubbed below.
export async function isAiConfigured(tx: AiDbClient): Promise<boolean> {
  if (process.env.VITEST) return true
  for (const provider of AI_PROVIDERS) {
    const org = await getOrgApiKey(tx, provider)
    if (org.status === 'ok') return true
    if (org.status === 'none' && await getHostApiKey(tx, provider)) return true
  }
  return false
}

// Resolve the key and model for `feature` through the caller's tx. Pass the
// result to `complete()` / `generate()` / `transcribe()` as `run` to make the
// provider call after the transaction has committed.
export async function resolveAiRun(tx: AiDbClient, feature: string): Promise<AiCompletionRun> {
  // Warm the list so the synchronous capability lookups in buildBody see it.
  await loadModelList(tx)
  const model = await resolveFeatureModel(tx, feature)
  if (process.env.VITEST) {
    const fallback = getAiFeatureKind(feature) === 'transcription' ? AI_TEST_FALLBACK_TRANSCRIPTION_MODEL : AI_TEST_FALLBACK_MODEL
    return { kind: 'completion', apiKey: 'test', model: model || fallback }
  }
  if (!model) {
    throw createError({ statusCode: 503, statusMessage: 'No AI model is enabled for this feature.' })
  }
  const provider = providerOf(model)
  const apiKey = await getProviderApiKey(tx, provider)
  if (!apiKey) {
    throw createError({
      statusCode: 503,
      statusMessage: `AI is not configured (no ${AI_PROVIDER_LABELS[provider]} API key for this organization or the host).`
    })
  }
  return { kind: 'completion', apiKey, model }
}

// A run plus what the request builders need to know about its model.
interface ResolvedRun {
  provider: AiProvider
  apiKey: string
  model: string
  info: AiProviderModelInfo | undefined
}

async function completionRun(opts: { tx?: AiDbClient, run?: AiCompletionRun, feature: string }): Promise<ResolvedRun> {
  let run = opts.run
  if (run) {
    // The run was resolved earlier; the model list may have gone cold since.
    await getAllModels({ [providerOf(run.model)]: run.apiKey })
  } else {
    if (!opts.tx) throw new Error('AI call needs `tx` or `run`')
    run = await resolveAiRun(opts.tx, opts.feature)
  }
  return { provider: providerOf(run.model), apiKey: run.apiKey, model: run.model, info: getModelInfo(run.model) }
}

export interface AiKeyCheck {
  ok: boolean
  // The provider's label for the key, when it reports one.
  label: string
  // Human-readable reason when not ok.
  message: string
}

// One authenticated read that proves a key works: OpenRouter's key-info
// endpoint, or the provider's model list.
async function keyCheckRequest(provider: AiProvider, key: string): Promise<Response> {
  const signal = AbortSignal.timeout(15_000)
  switch (provider) {
    case 'openrouter':
      return await fetch(`${getOpenRouterConfig().baseUrl}/auth/key`, { headers: { Authorization: `Bearer ${key}` }, signal })
    case 'openai':
      return await fetch(`${getOpenAiConfig().baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` }, signal })
    case 'anthropic':
      return await fetch(`${getAnthropicConfig().baseUrl}/models?limit=1`, {
        headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
        signal
      })
    case 'tinfoil':
      return await tinfoilFetch(key, '/v1/models', { method: 'GET', signal })
  }
}

// Verify a key against its provider before storing it. Under VITEST any
// non-empty key other than the literal 'invalid' passes.
export async function validateApiKey(key: string, provider: AiProvider = 'openrouter'): Promise<AiKeyCheck> {
  const name = AI_PROVIDER_LABELS[provider]
  if (process.env.VITEST) {
    return key && key !== 'invalid'
      ? { ok: true, label: 'test', message: '' }
      : { ok: false, label: '', message: `${name} rejected this key.` }
  }
  let res: Response
  try {
    res = await keyCheckRequest(provider, key)
  } catch {
    return { ok: false, label: '', message: `Could not reach ${name} to verify the key. Try again in a moment.` }
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, label: '', message: `${name} rejected this key.` }
  }
  if (!res.ok) {
    return { ok: false, label: '', message: `${name} answered ${res.status} while verifying the key. Try again in a moment.` }
  }
  const data = await res.json().catch(() => ({})) as { data?: { label?: unknown } }
  return { ok: true, label: typeof data?.data?.label === 'string' ? data.data.label : '', message: '' }
}

// Our content model → OpenAI-compatible content. A parts array becomes the
// content-parts form: images as data-URL `image_url` parts, and (OpenRouter
// and Anthropic only) `cache_control` on text parts flagged cacheable — a
// no-op on non-caching models, and a field Tinfoil's and OpenAI's servers
// don't accept.
function toApiContent(content: AiContent | AiRichContent, provider: AiProvider): unknown {
  if (typeof content === 'string') return content
  return (content as AiContentPart[]).map((p) => {
    if (p.type === 'image') {
      return { type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data}` } }
    }
    const text = p as AiTextPart
    return {
      type: 'text',
      text: text.text,
      ...(text.cache && (provider === 'openrouter' || provider === 'anthropic') ? { cache_control: { type: 'ephemeral' } } : {})
    }
  })
}

function hasImages(messages: AiRichMessage[]): boolean {
  return messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image'))
}

function toApiMessages(system: AiContent | undefined, messages: AiRichMessage[], run: ResolvedRun): unknown[] {
  if (hasImages(messages) && run.info && !run.info.supportsImages) {
    throw createError({ statusCode: 400, statusMessage: `The model ${run.info.name} can't read images.` })
  }
  const out: unknown[] = []
  if (system !== undefined) out.push({ role: 'system', content: toApiContent(system, run.provider) })
  for (const m of messages) out.push({ role: m.role, content: toApiContent(m.content, run.provider) })
  return out
}

function buildBody(
  run: ResolvedRun,
  apiMessages: unknown[],
  maxTokens: number,
  temperature: number | undefined,
  reasoning: AiRichCompleteOptions['reasoning'],
  extra: Record<string, unknown>
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: wireModelId(run.model),
    messages: apiMessages,
    // OpenAI's reasoning models reject `max_tokens`. Anthropic models that
    // think by default spend thinking from the same budget, so it gets
    // headroom; it stays a ceiling, not a target.
    ...(run.provider === 'openai'
      ? { max_completion_tokens: maxTokens }
      : { max_tokens: run.provider === 'anthropic' && run.info?.reasoning ? Math.max(maxTokens, ANTHROPIC_THINKING_MAX_TOKENS) : maxTokens })
  }
  // Only send sampling params to models that accept them — some models 400 on
  // an unrecognised `temperature`.
  if (temperature !== undefined && supportsTemperature(run.model)) {
    body.temperature = temperature
  }
  return { ...body, ...reasoningParams(run.info?.reasoning, reasoning), ...extra }
}

const ANTHROPIC_THINKING_MAX_TOKENS = 16_000

// Upper bound on one provider request, body included (a stream that stalls
// mid-reply is cut off too). Generous: long replies stream for a while.
const REQUEST_TIMEOUT_MS = { 'chat/completions': 120_000, 'audio/transcriptions': 120_000, 'embeddings': 60_000 } as Record<string, number>

// URL and auth headers for a plain-fetch provider. Anthropic's chat endpoint
// is `messages`; the body is already in its shape (see chatRequest).
function directEndpoint(run: ResolvedRun, endpoint: string): { url: string, headers: Record<string, string> } {
  if (run.provider === 'anthropic') {
    return {
      url: `${getAnthropicConfig().baseUrl}/${endpoint === 'chat/completions' ? 'messages' : endpoint}`,
      headers: { 'x-api-key': run.apiKey, 'anthropic-version': ANTHROPIC_VERSION }
    }
  }
  if (run.provider === 'openai') {
    return { url: `${getOpenAiConfig().baseUrl}/${endpoint}`, headers: { Authorization: `Bearer ${run.apiKey}` } }
  }
  const cfg = getOpenRouterConfig()
  return {
    url: `${cfg.baseUrl}/${endpoint}`,
    headers: {
      Authorization: `Bearer ${run.apiKey}`,
      ...(cfg.referer ? { 'HTTP-Referer': cfg.referer } : {}),
      ...(cfg.title ? { 'X-Title': cfg.title } : {})
    }
  }
}

// One POST to `endpoint` (relative to the provider's API root, e.g.
// 'chat/completions'), with non-2xx statuses mapped onto the error contract.
async function providerRequest(run: ResolvedRun, endpoint: string, body: BodyInit, contentType?: string): Promise<Response> {
  let res: Response
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS[endpoint] ?? 60_000)
  if (run.provider === 'tinfoil') {
    res = await tinfoilFetch(run.apiKey, `/v1/${endpoint}`, {
      method: 'POST',
      signal,
      headers: contentType ? { 'Content-Type': contentType } : {},
      body
    })
  } else {
    const { url, headers } = directEndpoint(run, endpoint)
    try {
      res = await fetch(url, {
        method: 'POST',
        signal,
        headers: { ...headers, ...(contentType ? { 'Content-Type': contentType } : {}) },
        body
      })
    } catch {
      // Network/connection failure — retryable.
      throw createError({
        statusCode: 502,
        statusMessage: 'AI request failed to reach the provider. Try again in a moment.'
      })
    }
  }

  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 500)
    } catch {
      // ignore — the status alone drives the mapping
    }
    if (!process.env.VITEST) {
      console.error(`[ai] ${AI_PROVIDER_LABELS[run.provider]} ${res.status}: ${detail}`)
    }
    if (res.status === 429 || res.status >= 500) {
      throw createError({ statusCode: 502, statusMessage: 'The AI provider is busy. Try again in a moment.' })
    }
    if (res.status === 401 || res.status === 403) {
      throw createError({ statusCode: 500, statusMessage: 'AI provider auth failed — check the server logs.' })
    }
    throw createError({ statusCode: 500, statusMessage: 'AI request was rejected — check the server logs.' })
  }

  return res
}

function chatRequest(run: ResolvedRun, body: Record<string, unknown>): Promise<Response> {
  const wire = run.provider === 'anthropic' ? toAnthropicBody(body) : body
  return providerRequest(run, 'chat/completions', JSON.stringify(wire), 'application/json')
}

// One whole non-streaming round trip, retried on transient failure. A
// provider that fails part-way answers 200 with an error body, so a success
// status alone does not mean there is a usable result.
async function callChat(run: ResolvedRun, body: Record<string, unknown>): Promise<any> {
  return await withAiRetries(async () => {
    const res = await chatRequest(run, body)
    const raw = await res.json()
    const data = run.provider === 'anthropic' && !raw?.error ? fromAnthropicResponse(raw) : raw
    if (data?.error) {
      if (!process.env.VITEST) {
        console.error(`[ai] ${AI_PROVIDER_LABELS[run.provider]} upstream error (HTTP ${res.status}): ${JSON.stringify(data.error).slice(0, 500)}`)
      }
      throw createError({ statusCode: 502, statusMessage: 'The AI provider reported an upstream error. Try again in a moment.' })
    }
    logUsage(run.model, data?.usage)
    return data
  })
}

// The same request with `stream: true`, reassembled from the SSE body while
// text fragments go to `onTextDelta`.
async function streamChat(
  run: ResolvedRun,
  body: Record<string, unknown>,
  onTextDelta: (delta: string) => void
): Promise<StreamedTurn & { native?: unknown[] }> {
  const res = await chatRequest(run, {
    ...body,
    stream: true,
    ...(run.provider === 'openai' ? { stream_options: { include_usage: true } } : {})
  })
  if (!res.body) {
    throw createError({ statusCode: 502, statusMessage: 'The AI provider returned an empty stream. Try again.' })
  }
  let turn: StreamedTurn & { native?: unknown[] }
  try {
    turn = run.provider === 'anthropic'
      ? await readAnthropicStream(textChunks(res.body), onTextDelta)
      : await readCompletionStream(textChunks(res.body), onTextDelta)
  } catch (err) {
    // The request timeout aborts a stalled body mid-read.
    if ((err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError') {
      throw createError({ statusCode: 502, statusMessage: 'The AI provider took too long to answer. Try again in a moment.' })
    }
    throw err
  }
  logUsage(run.model, turn.usage)
  return turn
}

async function* textChunks(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      yield decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

// One line per round trip so prompt-cache hits can be verified from the server
// log; OpenRouter reports cache reads and writes under prompt_tokens_details.
function logUsage(model: string, usage: any): void {
  if (!usage || typeof usage !== 'object') return
  const details = usage.prompt_tokens_details ?? {}
  const cost = typeof usage.cost === 'number' ? ` cost=$${usage.cost.toFixed(4)}` : ''
  console.info(
    `[ai] ${model} prompt=${usage.prompt_tokens ?? 0} cached=${details.cached_tokens ?? 0}`
    + ` cache_write=${details.cache_write_tokens ?? 0} completion=${usage.completion_tokens ?? 0}${cost}`
  )
}

// A `length` finish means the answer was cut off; both transports map it to
// the same retryable error.
function finishTurn(text: string, finishReason: string, toolCalls: ProviderToolCall[], native?: unknown[]): ProviderTurn {
  if (finishReason === 'length') {
    throw createError({ statusCode: 502, statusMessage: 'The AI response was cut off. Try again.' })
  }
  return { text: text.trim(), finishReason, toolCalls, ...(native ? { native } : {}) }
}

// One chat-completions round trip in the shape the tool loop consumes,
// streamed when the caller wants text as it arrives.
function providerCall(
  run: ResolvedRun,
  maxTokens: number,
  temperature: number | undefined,
  reasoning: AiRichCompleteOptions['reasoning'],
  onTextDelta: ((delta: string) => void) | undefined
): ProviderCall {
  return async (apiMessages, apiTools, allowToolCalls) => {
    const body = buildBody(run, apiMessages, maxTokens, temperature, reasoning, {
      ...(apiTools ? { tools: apiTools } : {}),
      ...(apiTools && !allowToolCalls ? { tool_choice: 'none' } : {})
    })
    if (onTextDelta) {
      const turn = await streamChat(run, body, onTextDelta)
      return finishTurn(turn.text, turn.finishReason, turn.toolCalls, turn.native)
    }
    const data = await callChat(run, body)
    const choice = data.choices?.[0]
    const rawCalls: any[] = Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : []
    return finishTurn(
      String(choice?.message?.content ?? ''),
      choice?.finish_reason ?? 'stop',
      rawCalls.map(tc => ({
        id: String(tc.id ?? ''),
        name: String(tc.function?.name ?? ''),
        arguments: String(tc.function?.arguments ?? '')
      })),
      Array.isArray(choice?.message?.native) ? choice.message.native : undefined
    )
  }
}

export async function complete(opts: AiRichCompleteOptions): Promise<AiCompleteResult> {
  const run = await completionRun(opts)
  const { model } = run
  if (process.env.VITEST) return aiFakeComplete(opts, model)

  const result = await runCompletionLoop(
    providerCall(run, opts.maxTokens ?? 2048, opts.temperature, opts.reasoning, opts.onTextDelta),
    {
      apiMessages: toApiMessages(opts.system, opts.messages, run),
      tools: opts.tools,
      onToolCall: opts.onToolCall,
      maxToolRounds: opts.maxToolRounds ?? 4,
      onTextDiscard: opts.onTextDiscard
    }
  )
  return { ...result, model }
}

// Force the model to call `opts.tool` and return its parsed arguments. A
// truncated forced-tool response comes back as partial JSON (not an error), so
// the `length` finish-reason is checked explicitly before parsing.
export async function generate<T = Record<string, unknown>>(
  opts: AiRichGenerateOptions
): Promise<AiGenerateResult<T>> {
  const run = await completionRun(opts)
  const { model } = run
  if (process.env.VITEST) return aiFakeGenerate<T>(opts, model)

  const body = buildBody(run, toApiMessages(opts.system, opts.messages, run), opts.maxTokens ?? 8192, opts.temperature, opts.reasoning, {
    tools: [
      {
        type: 'function',
        function: {
          name: opts.tool.name,
          description: opts.tool.description,
          parameters: opts.tool.parameters
        }
      }
    ],
    tool_choice: { type: 'function', function: { name: opts.tool.name } }
  })

  const data = await callChat(run, body)
  const choice = data.choices?.[0]
  const finishReason: string = choice?.finish_reason ?? 'stop'
  if (finishReason === 'length') {
    throw createError({
      statusCode: 502,
      statusMessage: 'The AI response was cut off before finishing. Try again.'
    })
  }
  // A model that declines is reported as either reason depending on the provider.
  if (finishReason === 'content_filter' || finishReason === 'refusal') {
    throw createError({ statusCode: 502, statusMessage: 'The AI provider refused the request.' })
  }

  const args = choice?.message?.tool_calls?.[0]?.function?.arguments
  if (!args) {
    throw createError({ statusCode: 502, statusMessage: 'The AI did not return a structured result. Try again.' })
  }
  let input: T
  try {
    input = JSON.parse(args)
  } catch {
    throw createError({ statusCode: 502, statusMessage: 'The AI returned an unparseable result. Try again.' })
  }
  return { input, model, finishReason }
}

// Transcription servers pick the decoder from the upload's file extension, so
// MIME subtypes that aren't extensions map to the one the format uses.
const AUDIO_EXTENSIONS: Record<string, string> = {
  'mpeg': 'mp3',
  'mp3': 'mp3',
  'x-m4a': 'm4a',
  'm4a': 'm4a',
  'mp4': 'mp4',
  'aac': 'aac',
  'wav': 'wav',
  'x-wav': 'wav',
  'wave': 'wav',
  'webm': 'webm',
  'ogg': 'ogg',
  'flac': 'flac',
  'x-flac': 'flac'
}

function audioExtension(mimeType: string): string {
  const subtype = mimeType.split('/')[1]?.split(';')[0]?.trim().toLowerCase() ?? ''
  return AUDIO_EXTENSIONS[subtype] ?? (subtype || 'bin')
}

// Speech-to-text through the OpenAI-compatible `audio/transcriptions`
// endpoint of the feature's model. Retried on transient failure like a
// non-streaming chat call.
export async function transcribe(opts: AiTranscribeOptions): Promise<AiTranscribeResult> {
  const run = await completionRun(opts)
  if (process.env.VITEST) return aiFakeTranscribe(opts, run.model)
  if (run.info && run.info.kind !== 'transcription') {
    throw createError({ statusCode: 400, statusMessage: `The model ${run.info.name} can't transcribe audio.` })
  }

  const blob = opts.audio instanceof Blob ? opts.audio : new Blob([opts.audio as BlobPart], { type: opts.mimeType })
  const filename = opts.filename || `audio.${audioExtension(opts.mimeType)}`

  const data = await withAiRetries(async () => {
    // A fresh form per attempt: a sent body stream can't be replayed.
    const form = new FormData()
    form.append('file', blob, filename)
    form.append('model', wireModelId(run.model))
    form.append('response_format', 'json')
    if (opts.prompt) form.append('prompt', opts.prompt)
    if (opts.language) form.append('language', opts.language)
    const res = await providerRequest(run, 'audio/transcriptions', form)
    return await res.json() as { text?: unknown }
  })
  if (typeof data?.text !== 'string') {
    throw createError({ statusCode: 502, statusMessage: 'The AI did not return a transcript. Try again.' })
  }
  console.info(`[ai] ${run.model} transcribed ${blob.size} bytes → ${data.text.length} chars`)
  return { text: data.text.trim(), model: run.model }
}

// --- Embeddings ---

// Whether this org can build or query a vector index: a key (org or host) and
// an embedding model that resolves. Under VITEST the fake embeds model-less
// (like `complete()`), so only the key check applies there.
export async function isEmbeddingConfigured(tx: AiDbClient): Promise<boolean> {
  try {
    if (!(await isAiConfigured(tx))) return false
    if (process.env.VITEST) return true
    return (await resolveEmbeddingModel(tx)) !== ''
  } catch {
    return false
  }
}

// OpenRouter batches: one request per this many inputs.
const EMBED_BATCH = 64
// Under VITEST an org with no embedding model set still embeds with the fake.
const AI_TEST_FALLBACK_EMBED_MODEL = 'test/embed-small'

async function embedBatch(apiKey: string, model: string, input: string[]): Promise<number[][]> {
  const data = await withAiRetries(async () => {
    // Embedding models come from OpenRouter's catalog only.
    const run: ResolvedRun = { provider: 'openrouter', apiKey, model, info: undefined }
    const res = await providerRequest(run, 'embeddings', JSON.stringify({
      model,
      input,
      dimensions: AI_EMBED_DIMENSIONS,
      encoding_format: 'float'
    }), 'application/json')
    const json = await res.json()
    if (json?.error) {
      if (!process.env.VITEST) {
        console.error(`[ai] OpenRouter embeddings upstream error (HTTP ${res.status}): ${JSON.stringify(json.error).slice(0, 500)}`)
      }
      throw createError({ statusCode: 502, statusMessage: 'The AI provider reported an upstream error. Try again in a moment.' })
    }
    return json
  })
  const rows: { index?: unknown, embedding?: unknown }[] = Array.isArray(data?.data) ? data.data : []
  if (rows.length !== input.length) {
    throw createError({ statusCode: 502, statusMessage: 'The AI provider returned an incomplete embedding response. Try again.' })
  }
  rows.sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
  const vectors = rows.map(r => (Array.isArray(r.embedding) ? (r.embedding as number[]) : []))
  for (const v of vectors) {
    if (v.length !== AI_EMBED_DIMENSIONS) {
      console.error(`[ai] embedding model ${model} returned ${v.length} dimensions, expected ${AI_EMBED_DIMENSIONS}`)
      throw createError({
        statusCode: 500,
        statusMessage: `The embedding model produces ${v.length}-dimension vectors; this deployment needs ${AI_EMBED_DIMENSIONS}. Pick another model.`
      })
    }
  }
  if (data?.usage) {
    console.info(`[ai] ${model} embed inputs=${input.length} prompt=${data.usage.prompt_tokens ?? 0}`)
  }
  return vectors
}

// Resolve the key and embedding model through the caller's tx, for `embed()`
// calls made after the transaction has committed.
export async function resolveAiEmbedRun(tx: AiDbClient): Promise<AiEmbeddingRun> {
  const model = await resolveEmbeddingModel(tx)
  if (process.env.VITEST) return { kind: 'embedding', apiKey: 'test', model: model || AI_TEST_FALLBACK_EMBED_MODEL }
  const apiKey = await getProviderApiKey(tx, 'openrouter')
  if (!apiKey) {
    throw createError({ statusCode: 503, statusMessage: 'AI is not configured (no OpenRouter API key for this organization or the host).' })
  }
  if (!model) {
    throw createError({ statusCode: 503, statusMessage: 'No embedding model is configured.' })
  }
  return { kind: 'embedding', apiKey, model }
}

// Embed `input` with the org's resolved embedding model. Empty input → empty
// result without a network call. Same error contract as `complete()`.
export async function embed(opts: AiEmbedOptions): Promise<AiEmbedResult> {
  let run = opts.run
  if (!run) {
    if (!opts.tx) throw new Error('embed() needs `tx` or `run`')
    run = await resolveAiEmbedRun(opts.tx)
  }
  const { apiKey, model } = run
  if (process.env.VITEST) return aiFakeEmbed(opts, model)
  if (opts.input.length === 0) return { vectors: [], model }
  const vectors: number[][] = []
  for (let i = 0; i < opts.input.length; i += EMBED_BATCH) {
    vectors.push(...await embedBatch(apiKey, model, opts.input.slice(i, i + EMBED_BATCH)))
  }
  return { vectors, model }
}

// One tiny embedding with a specific model and key, run before an admin's
// choice is stored: proves the key can use the model and that it yields
// AI_EMBED_DIMENSIONS-wide vectors. Throws the same errors `embed()` would.
export async function probeEmbeddingModel(apiKey: string, model: string): Promise<void> {
  if (process.env.VITEST) return
  await embedBatch(apiKey, model, ['probe'])
}
