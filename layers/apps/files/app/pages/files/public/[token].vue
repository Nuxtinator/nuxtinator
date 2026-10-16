<script setup lang="ts">
// Public, no-login share view. layout:false + no auth middleware so anonymous
// visitors render it. The `/files/public` prefix is whitelisted in the tenancy
// route guard's SYSTEM_PREFIXES.

definePageMeta({
  layout: false
})

const route = useRoute()
const token = computed(() => route.params.token as string)
const config = useRuntimeConfig()
const { user } = useAuth()

interface PublicDoc { kind: 'doc', title: string, body_md: string }
interface PublicFile { kind: 'file', title: string, filename: string | null, mime: string | null, size_bytes: string | null, url: string | null }
interface PublicSite { kind: 'site', title: string }
type PublicItem = PublicDoc | PublicFile | PublicSite

const item = ref<PublicItem | null>(null)
const bareSiteUrl = computed(() => `/files/site/${token.value}?bare=1`)
const loading = ref(true)
const error = ref<string | null>(null)

const isImage = computed(() =>
  item.value?.kind === 'file' && (item.value.mime ?? '').startsWith('image/')
)
const isVideo = computed(() =>
  item.value?.kind === 'file' && (item.value.mime ?? '').startsWith('video/')
)
const lightboxOpen = ref(false)

onMounted(async () => {
  try {
    const fetched = await $fetch<PublicItem>(`/api/files/public/${token.value}`)
    // Sites live at the raw serve route (full-tab HTML, outside the SPA).
    // A signed-in visitor sees it framed under the app's nav bar; anyone else
    // gets a full location replace (it's a Nitro route), with the spinner up
    // while the browser swaps pages.
    if (fetched.kind === 'site' && !user.value) {
      window.location.replace(bareSiteUrl.value)
      return
    }
    item.value = fetched
    loading.value = false
  } catch (e: unknown) {
    const err = e as { statusMessage?: string, message?: string }
    error.value = err.statusMessage || err.message || 'This link is no longer available.'
    loading.value = false
  }
})

useHead({ title: computed(() => item.value?.kind === 'site' ? item.value.title : 'Shared file') })
</script>

<template>
  <div v-if="item?.kind === 'site'" class="flex flex-col h-screen bg-(--ui-bg) text-(--ui-text)">
    <header class="flex items-center gap-2 h-11 px-3 shrink-0 border-b border-(--ui-border) bg-(--chrome-bg)">
      <UButton to="/" icon="i-lucide-house" variant="ghost" color="neutral" size="sm">
        {{ config.public.appName }}
      </UButton>
      <UButton to="/files" icon="i-lucide-folder" variant="ghost" color="neutral" size="sm">
        Files
      </UButton>
      <span class="flex-1 min-w-0 truncate text-sm text-(--ui-text-muted)">{{ item.title }}</span>
      <UButton
        :href="bareSiteUrl"
        external
        icon="i-lucide-maximize-2"
        variant="ghost"
        color="neutral"
        size="sm"
      >
        Open without bar
      </UButton>
    </header>
    <!-- The served HTML carries its own CSP sandbox; the attribute repeats it. -->
    <iframe
      :src="bareSiteUrl"
      :title="item.title"
      sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-popups-to-escape-sandbox"
      class="flex-1 w-full border-0 bg-white"
    />
  </div>

  <div v-else class="min-h-screen bg-(--ui-bg) text-(--ui-text)">
    <div class="max-w-3xl mx-auto px-4 py-10">
      <div v-if="loading" class="text-center py-16 text-(--ui-text-muted)">
        <UIcon name="i-lucide-loader-circle" class="size-6 animate-spin" />
      </div>

      <UEmpty
        v-else-if="error || !item"
        icon="i-lucide-link-2-off"
        title="Link unavailable"
        :description="error ?? 'This link is no longer available.'"
      />

      <template v-else>
        <h1 class="text-2xl font-semibold mb-6">{{ item.title }}</h1>

        <div v-if="item.kind === 'doc'" class="rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-6">
          <FilesRenderer :body-md="item.body_md" />
        </div>

        <!-- Sites never render here — they render framed above, or onMounted
             redirects them to the raw serve route before `item` is set. -->
        <div v-else-if="item.kind === 'file'" class="flex flex-col items-center gap-4">
          <img
            v-if="isImage && item.url"
            :src="item.url"
            :alt="item.title"
            class="max-w-full max-h-[75vh] rounded-lg border border-(--ui-border) cursor-zoom-in"
            @click="lightboxOpen = true"
          >
          <FilesImageLightbox
            v-if="isImage && item.url"
            v-model:open="lightboxOpen"
            :src="item.url"
            :alt="item.title"
          />
          <video
            v-if="isVideo && item.url"
            :src="item.url"
            controls
            preload="metadata"
            class="max-w-full max-h-[75vh] rounded-lg border border-(--ui-border) bg-black"
          />
          <UButton
            v-if="item.url"
            :href="item.url"
            target="_blank"
            external
            size="lg"
            icon="i-lucide-download"
          >
            Download {{ item.filename }}
          </UButton>
        </div>
      </template>

      <p class="text-center text-xs text-(--ui-text-muted) mt-10">
        Shared via Files
      </p>
    </div>
  </div>
</template>
