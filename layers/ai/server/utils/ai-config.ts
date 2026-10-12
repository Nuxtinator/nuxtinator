import type { AiProvider } from '../../types/ai-ext'

// Env-derived provider settings. A provider's env key is the host key for that
// provider and wins over one stored on /admin/ai (see ai-settings). An org
// with its own stored key for a provider never uses the host's.
export interface OpenRouterConfig {
  apiKey: string
  baseUrl: string
  referer: string
  title: string
}

export function getOpenRouterConfig(): OpenRouterConfig {
  const c = useRuntimeConfig()
  return {
    apiKey: (c.openrouterApiKey as string) || process.env.OPENROUTER_API_KEY || '',
    baseUrl: ((c.openrouterBaseUrl as string) || 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
    referer: (c.aiHttpReferer as string) || '',
    title: (c.aiAppTitle as string) || ''
  }
}

export interface TinfoilConfig {
  apiKey: string
  catalogUrl: string
}

export function getTinfoilConfig(): TinfoilConfig {
  const c = useRuntimeConfig()
  return {
    apiKey: (c.tinfoilApiKey as string) || process.env.TINFOIL_API_KEY || '',
    catalogUrl: (c.tinfoilCatalogUrl as string) || 'https://api.tinfoil.sh/api/config/models'
  }
}

export interface DirectProviderConfig {
  apiKey: string
  baseUrl: string
}

export function getOpenAiConfig(): DirectProviderConfig {
  const c = useRuntimeConfig()
  return {
    apiKey: (c.openaiApiKey as string) || process.env.OPENAI_API_KEY || '',
    baseUrl: ((c.openaiBaseUrl as string) || 'https://api.openai.com/v1').replace(/\/$/, '')
  }
}

export function getAnthropicConfig(): DirectProviderConfig {
  const c = useRuntimeConfig()
  return {
    apiKey: (c.anthropicApiKey as string) || process.env.ANTHROPIC_API_KEY || '',
    baseUrl: ((c.anthropicBaseUrl as string) || 'https://api.anthropic.com/v1').replace(/\/$/, '')
  }
}

// The provider's key from the environment; '' when unset.
export function getEnvApiKey(provider: AiProvider): string {
  switch (provider) {
    case 'openrouter': return getOpenRouterConfig().apiKey
    case 'tinfoil': return getTinfoilConfig().apiKey
    case 'openai': return getOpenAiConfig().apiKey
    case 'anthropic': return getAnthropicConfig().apiKey
  }
}
