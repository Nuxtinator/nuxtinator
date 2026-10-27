<script setup lang="ts">
definePageMeta({
  layout: false
})

const route = useRoute()
const toast = useToast()
const token = computed(() => route.params.token as string)
const { isLoggedIn } = useAuth()

const loading = ref(true)
const error = ref<string | null>(null)
const needsLogin = ref(false)
const videoUrl = ref<string | null>(null)
const videoPlayer = ref<HTMLVideoElement | null>(null)
const videoTitle = ref('')
const isOwner = ref(false)
const isEditing = ref(false)
const editTitle = ref('')
const viewCount = ref(0)
const playCount = ref(0)
const hasTrackedPlay = ref(false)

const hasRecentView = (key: string): boolean => {
  if (typeof window === 'undefined') return false
  const last = localStorage.getItem(`video_view_${key}`)
  if (!last) return false
  return Date.now() - parseInt(last, 10) < 12 * 60 * 60 * 1000
}

const markAsViewed = (key: string) => {
  if (typeof window === 'undefined') return
  localStorage.setItem(`video_view_${key}`, Date.now().toString())
}

onMounted(async () => {
  try {
    loading.value = true
    error.value = null

    const shouldCount = !hasRecentView(token.value)

    const response = await $fetch<{
      videoUrl: string
      title: string | null
      videoId: string
      isOwner: boolean
      viewCount: number
      playCount: number
    }>(`/api/videos/share/${token.value}`)

    if (!response || !response.videoUrl) throw new Error('Video not found')

    videoUrl.value = response.videoUrl
    videoTitle.value = response.title || 'Untitled Video'
    isOwner.value = response.isOwner || false
    viewCount.value = response.viewCount || 0
    playCount.value = response.playCount || 0

    if (shouldCount) {
      try {
        await $fetch(`/api/videos/share/${token.value}/view`, { method: 'POST' })
        markAsViewed(token.value)
      } catch (viewErr) {
        console.warn('Failed to track view:', viewErr)
      }
    }
  } catch (err: any) {
    console.error('Error loading video:', err)
    // 401 = an org-shared video and no session — offer sign-in instead of
    // an error (the login page returns here via ?redirect=).
    if (err?.statusCode === 401 || err?.status === 401) {
      needsLogin.value = true
    } else {
      error.value = err.message || 'Failed to load video'
    }
  } finally {
    loading.value = false
  }
})

const trackPlayProgress = () => {
  const video = videoPlayer.value
  if (!video) return
  const progress = (video.currentTime / video.duration) * 100
  if (progress < 80 && hasTrackedPlay.value) hasTrackedPlay.value = false
  if (progress >= 90 && !hasTrackedPlay.value) {
    hasTrackedPlay.value = true
    $fetch(`/api/videos/share/${token.value}/play`, { method: 'POST' }).catch((err) => {
      console.warn('Failed to track play:', err)
    })
  }
}

watch(videoPlayer, (player) => {
  if (player) player.addEventListener('timeupdate', trackPlayProgress)
})

onUnmounted(() => {
  if (videoPlayer.value) videoPlayer.value.removeEventListener('timeupdate', trackPlayProgress)
})

const startEdit = () => {
  if (isEditing.value) {
    saveTitle()
  } else {
    isEditing.value = true
    editTitle.value = videoTitle.value
  }
}

const saveTitle = async () => {
  if (!editTitle.value || editTitle.value.trim() === '') {
    cancelEdit()
    return
  }
  try {
    await $fetch(`/api/videos/share/${token.value}`, {
      method: 'PATCH',
      credentials: 'include',
      body: { title: editTitle.value.trim() }
    })
    videoTitle.value = editTitle.value.trim()
    isEditing.value = false
    editTitle.value = ''
  } catch (err: any) {
    console.error('Error updating title:', err)
    toast.add({ title: 'Failed to update title', description: err.data?.message, color: 'error' })
    cancelEdit()
  }
}

const cancelEdit = () => {
  isEditing.value = false
  editTitle.value = ''
}

useHead({ title: 'Watch Video' })
</script>

<template>
  <div class="watch-page">
    <header v-if="isLoggedIn" class="watch-topbar">
      <UButton to="/videos" variant="ghost" icon="i-lucide-library" size="sm">Library</UButton>
    </header>

    <div class="watch-container">
      <div v-if="loading" class="loading-view">
        <div class="spinner"></div>
        <p>Loading video...</p>
      </div>

      <div v-else-if="needsLogin" class="signin-card">
        <h2>Sign in to watch</h2>
        <p>This video is shared with an organization. Sign in to watch it.</p>
        <UButton :to="`/login?redirect=${encodeURIComponent(route.fullPath)}`" size="lg" icon="i-lucide-log-in">Sign In</UButton>
      </div>

      <div v-else-if="error" class="error-card">
        <h2>Error Loading Video</h2>
        <p>{{ error }}</p>
        <UButton to="/videos/record" size="lg" icon="i-lucide-circle">Create Your Own Recording</UButton>
      </div>

      <div v-else-if="videoUrl" class="player-view">
        <div class="video-title-section">
          <input
            v-if="isEditing"
            v-model="editTitle"
            @blur="saveTitle"
            @keyup.enter="saveTitle"
            @keyup.esc="cancelEdit"
            class="video-title-input"
            autofocus
          />
          <h1 v-else class="video-title">{{ videoTitle }}</h1>
          <button v-if="isOwner" @click="startEdit" class="edit-title-btn" :title="isEditing ? 'Save' : 'Edit title'">
            <UIcon :name="isEditing ? 'i-lucide-check' : 'i-lucide-pencil'" />
          </button>
        </div>

        <div v-if="isOwner" class="stats-container">
          <div class="stat-item">
            <UIcon name="i-lucide-eye" />
            <span>{{ viewCount }} {{ viewCount === 1 ? 'view' : 'views' }}</span>
          </div>
          <div class="stat-divider">•</div>
          <div class="stat-item">
            <UIcon name="i-lucide-play" />
            <span>{{ playCount }} {{ playCount === 1 ? 'play' : 'plays' }}</span>
          </div>
        </div>

        <div class="video-container">
          <video ref="videoPlayer" :src="videoUrl" controls autoplay class="video-player"></video>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.watch-page {
  min-height: 100vh;
  background: var(--ui-bg);
  color: var(--ui-text);
}

.watch-topbar {
  display: flex;
  justify-content: flex-end;
  padding: 0.75rem 1.5rem;
  border-bottom: 1px solid var(--ui-border);
}

.watch-container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 2rem;
}

.loading-view {
  text-align: center;
  padding: 4rem 2rem;
}

.spinner {
  width: 40px;
  height: 40px;
  border: 4px solid var(--ui-border);
  border-top: 4px solid var(--ui-text);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin: 0 auto 1rem;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.loading-view p { color: var(--ui-text-muted); font-size: 1.1rem; }

.error-card {
  background: var(--ui-bg-elevated);
  border: 2px solid #dc2626;
  border-radius: 0.5rem;
  padding: 2rem;
  text-align: center;
  max-width: 600px;
  margin: 0 auto;
}

.error-card h2 { color: #dc2626; margin-bottom: 1rem; font-size: 1.5rem; }
.error-card p { color: var(--ui-text-muted); margin-bottom: 1.5rem; }

.signin-card {
  background: var(--ui-bg-elevated);
  border: 1px solid var(--ui-border);
  border-radius: 0.5rem;
  padding: 2rem;
  text-align: center;
  max-width: 600px;
  margin: 0 auto;
}

.signin-card h2 { margin-bottom: 1rem; font-size: 1.5rem; }
.signin-card p { color: var(--ui-text-muted); margin-bottom: 1.5rem; }

.player-view { text-align: center; }

.video-title-section {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  margin-bottom: 0.75rem;
}

.video-title {
  font-size: 1.75rem;
  font-weight: 600;
  margin: 0;
  color: var(--ui-text);
}

.video-title-input {
  flex: 1;
  max-width: 600px;
  padding: 0.5rem 0.75rem;
  border: 2px solid var(--ui-text);
  background: var(--ui-bg);
  color: var(--ui-text);
  border-radius: 0.375rem;
  font-size: 1.75rem;
  font-weight: 600;
  outline: none;
  text-align: center;
}

.edit-title-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.5rem;
  background: transparent;
  border: none;
  color: var(--ui-text-muted);
  cursor: pointer;
  border-radius: 0.375rem;
  transition: all 0.2s;
}

.edit-title-btn:hover {
  color: var(--ui-text);
  background: var(--ui-bg-elevated);
}

.stats-container {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  margin-bottom: 1.5rem;
  color: var(--ui-text-muted);
  font-size: 0.95rem;
}

.stat-item { display: flex; align-items: center; gap: 0.5rem; }
.stat-divider { opacity: 0.5; }

.video-container {
  border-radius: 0.5rem;
  overflow: hidden;
  background: #000;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
  margin-bottom: 2rem;
}

.video-player {
  width: 100%;
  min-height: 500px;
  max-height: 80vh;
  display: block;
}

@media (max-width: 640px) {
  .watch-container { padding: 1rem; }
  .video-title { font-size: 1.25rem; }
  .video-title-input { font-size: 1.25rem; max-width: 100%; }
  .video-title-section { flex-direction: column; gap: 0.5rem; }
}
</style>
