<script setup lang="ts">
definePageMeta({
  layout: false
})
</script>

<template>
  <div class="max-w-2xl mx-auto p-8 space-y-4">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-semibold">
        {{ $t('dev.i18n.title') }}
      </h1>
      <LocaleSwitcher />
    </div>
    <p>{{ $t('dev.i18n.intro') }}</p>
    <p>{{ $t('dev.i18n.greeting', { name: 'Ada' }) }}</p>
    <p class="text-muted">
      {{ $t('dev.i18n.untranslated') }}
    </p>
    <UCalendar weekday-format="short" />
  </div>
</template>
