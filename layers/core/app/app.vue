<script setup lang="ts">
import * as uiLocales from '@nuxt/ui/locale'

const { locale, locales } = useI18n()

// Nuxt UI's own strings and text direction follow the active i18n locale.
const uiLocale = computed(() => {
  const code = locale.value.toLowerCase()
  const all = Object.values(uiLocales)
  return all.find(l => l.code.toLowerCase() === code)
    ?? all.find(l => l.code.toLowerCase() === code.split('-')[0])
    ?? uiLocales.en
})

const activeLocale = computed(() => locales.value.find(l => l.code === locale.value))

useHead({
  htmlAttrs: {
    lang: () => activeLocale.value?.language ?? locale.value,
    dir: () => activeLocale.value?.dir ?? uiLocale.value.dir ?? 'ltr'
  }
})
</script>

<template>
  <UApp :locale="uiLocale" :toaster="{ progress: false, duration: 3000 }">
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
