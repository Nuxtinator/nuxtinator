<script setup lang="ts">
// Language picker over every locale the loaded layers declare. Renders nothing
// when only one locale exists.
const { locale, locales, setLocale } = useI18n()

const items = computed(() => locales.value.map(l => ({ label: l.name ?? l.code, value: l.code })))
</script>

<template>
  <USelect
    v-if="items.length > 1"
    :model-value="locale"
    :items="items"
    icon="i-lucide-languages"
    variant="ghost"
    aria-label="Language"
    @update:model-value="code => setLocale(code as typeof locale)"
  />
</template>
