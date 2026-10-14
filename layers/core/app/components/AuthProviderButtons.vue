<script setup lang="ts">
// One button per registered sign-in provider (see the server's
// auth-provider-registry). Renders nothing when no provider is registered.
const props = withDefaults(defineProps<{
  intent?: 'login' | 'link' | 'reauth'
  invite?: string
  redirect?: string
  // Text between the buttons and whatever follows them, e.g. "or".
  separator?: string
}>(), {
  intent: 'login',
  invite: undefined,
  redirect: undefined,
  separator: undefined
})

interface ProviderButton {
  id: string
  label: string
  icon: string
  startPath: string
}

const { data: providers } = useLazyFetch<ProviderButton[]>('/api/_auth-providers', {
  key: 'auth-providers',
  default: () => []
})

function startUrl(p: ProviderButton): string {
  const params = new URLSearchParams({ intent: props.intent })
  if (props.invite) params.set('invite', props.invite)
  if (props.redirect && props.redirect.startsWith('/')) params.set('redirect', props.redirect)
  return `${p.startPath}?${params.toString()}`
}

const verb = computed(() => props.intent === 'link' ? 'Link' : 'Continue with')
</script>

<template>
  <div
    v-if="providers.length"
    class="space-y-3"
  >
    <UButton
      v-for="p in providers"
      :key="p.id"
      :to="startUrl(p)"
      external
      color="neutral"
      variant="outline"
      size="lg"
      block
      :icon="p.icon"
    >
      {{ verb }} {{ p.label }}
    </UButton>

    <USeparator
      v-if="separator"
      :label="separator"
      class="pt-3"
      :ui="{ container: 'font-normal text-muted' }"
    />
  </div>
</template>
