// Keys missing from the active locale render the English message. Layers may
// translate only part of their strings, so neither the miss nor the fallback
// is warned on.
export default defineI18nConfig(() => ({
  fallbackLocale: 'en',
  missingWarn: false,
  fallbackWarn: false
}))
