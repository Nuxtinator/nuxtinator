<script setup lang="ts">
definePageMeta({
  middleware: 'auth'
})

interface Video {
  id: string
  title: string | null
  duration: number
  thumbnailUrl: string | null
  shareToken: string
  visibility: 'private' | 'org' | 'public'
  viewCount: number
  playCount: number
  userId: string
  createdAt: string
  updatedAt: string
}

const toast = useToast()
const scope = ref<'mine' | 'team'>('mine')
const videos = ref<Video[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const copied = ref<string | null>(null)
const editingVideoId = ref<string | null>(null)
const editingTitle = ref('')

const tabs = [
  { label: 'My videos', value: 'mine', icon: 'i-lucide-user' },
  { label: 'Team library', value: 'team', icon: 'i-lucide-users' }
]

const loadVideos = async () => {
  try {
    loading.value = true
    error.value = null
    const response = await $fetch<{ videos: Video[] }>('/api/videos', {
      method: 'GET',
      query: { scope: scope.value },
      credentials: 'include'
    })
    videos.value = response.videos || []
  } catch (err: any) {
    console.error('Error loading videos:', err)
    error.value = err.data?.message || 'Failed to load videos'
    videos.value = []
  } finally {
    loading.value = false
  }
}

watch(scope, () => loadVideos())
onMounted(() => loadVideos())

const deleteTarget = ref<Video | null>(null)
const deleting = ref(false)
const deleteError = ref<string | null>(null)
const deleteModalOpen = computed({
  get: () => deleteTarget.value !== null,
  set: (val: boolean) => { if (!val) { deleteTarget.value = null; deleteError.value = null } }
})

const requestDelete = (video: Video) => {
  deleteTarget.value = video
  deleteError.value = null
}

const confirmDelete = async () => {
  if (!deleteTarget.value) return
  const id = deleteTarget.value.id
  deleting.value = true
  deleteError.value = null
  try {
    await $fetch(`/api/videos/${id}`, { method: 'DELETE', credentials: 'include' })
    videos.value = videos.value.filter(v => v.id !== id)
    deleteTarget.value = null
  } catch (err: any) {
    console.error('Error deleting video:', err)
    deleteError.value = err.data?.message || 'Failed to delete video'
  } finally {
    deleting.value = false
  }
}

const copyLink = async (video: Video) => {
  try {
    const shareUrl = `${window.location.origin}/watch/${video.shareToken}`
    await navigator.clipboard.writeText(shareUrl)
    copied.value = video.id
    setTimeout(() => { copied.value = null }, 2000)
  } catch (err) {
    console.error('Failed to copy:', err)
  }
}

const setVisibility = async (video: Video, visibility: Video['visibility']) => {
  try {
    await $fetch(`/api/videos/${video.id}`, {
      method: 'PATCH',
      credentials: 'include',
      body: { visibility }
    })
    video.visibility = visibility
  } catch (err: any) {
    console.error('Error updating visibility:', err)
    toast.add({ title: 'Failed to update visibility', description: err.data?.message, color: 'error' })
  }
}

const formatDate = (dateString: string) => {
  const date = new Date(dateString)
  const diffMs = Date.now() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)
  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins} min ago`
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`
  if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`
  return date.toLocaleDateString()
}

const formatDuration = (seconds: number) => {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

const startEditTitle = (video: Video) => {
  if (editingVideoId.value === video.id) {
    saveTitle(video.id)
  } else {
    editingVideoId.value = video.id
    editingTitle.value = video.title || ''
  }
}

const saveTitle = async (videoId: string) => {
  if (!editingTitle.value || editingTitle.value.trim() === '') {
    cancelEdit()
    return
  }
  try {
    await $fetch(`/api/videos/${videoId}`, {
      method: 'PATCH',
      credentials: 'include',
      body: { title: editingTitle.value.trim() }
    })
    const video = videos.value.find(v => v.id === videoId)
    if (video) video.title = editingTitle.value.trim()
    editingVideoId.value = null
    editingTitle.value = ''
  } catch (err: any) {
    console.error('Error updating title:', err)
    toast.add({ title: 'Failed to update title', description: err.data?.message, color: 'error' })
    cancelEdit()
  }
}

const cancelEdit = () => {
  editingVideoId.value = null
  editingTitle.value = ''
}

useHead({ title: 'Video Library' })
</script>

<template>
  <div class="library-page">
    <div class="library-container">
      <div class="library-header">
        <UTabs v-model="scope" :items="tabs" :content="false" class="flex-1" />
        <div class="header-actions">
          <UButton to="/videos/upload" variant="outline" icon="i-lucide-upload">Upload</UButton>
          <UButton to="/videos/record" icon="i-lucide-circle">New Recording</UButton>
        </div>
      </div>

      <div v-if="loading" class="loading-state">
        <UIcon name="i-lucide-loader-2" class="loading-spinner" />
        <p>Loading recordings...</p>
      </div>

      <div v-else-if="videos.length === 0" class="empty-state">
        <UIcon :name="scope === 'mine' ? 'i-lucide-video-off' : 'i-lucide-users'" class="empty-icon" />
        <h2>{{ scope === 'mine' ? 'No Recordings Yet' : 'Nothing shared with the team' }}</h2>
        <p v-if="scope === 'mine'">Create your first screen recording to get started.</p>
        <p v-else>When teammates set a video to <strong>org</strong>, it shows up here.</p>
        <UButton v-if="scope === 'mine'" to="/videos/record" size="lg" icon="i-lucide-circle">Start Recording</UButton>
      </div>

      <div v-else class="video-grid">
        <div v-for="video in videos" :key="video.id" class="video-card">
          <div class="video-thumbnail">
            <NuxtLink :to="`/watch/${video.shareToken}`" class="thumbnail-link">
              <img v-if="video.thumbnailUrl" :src="video.thumbnailUrl" :alt="video.title || 'Video'" class="thumbnail-image" />
              <UIcon v-else name="i-lucide-play" class="play-icon" />
            </NuxtLink>
          </div>

          <div class="video-info">
            <div class="video-title-section">
              <input
                v-if="editingVideoId === video.id"
                v-model="editingTitle"
                @blur="saveTitle(video.id)"
                @keyup.enter="saveTitle(video.id)"
                @keyup.esc="cancelEdit"
                class="video-title-input"
                autofocus
              />
              <h3 v-else class="video-title">{{ video.title }}</h3>
              <button @click="startEditTitle(video)" class="edit-title-btn" :title="editingVideoId === video.id ? 'Save' : 'Edit title'">
                <UIcon :name="editingVideoId === video.id ? 'i-lucide-check' : 'i-lucide-pencil'" />
              </button>
            </div>

            <div class="video-meta">
              <span class="video-date">{{ formatDate(video.createdAt) }}</span>
              <span class="video-duration">{{ formatDuration(video.duration) }}</span>
            </div>

            <div class="video-visibility">
              <USelect
                :model-value="video.visibility"
                :items="[
                  { label: 'Private', value: 'private', icon: 'i-lucide-lock' },
                  { label: 'Org', value: 'org', icon: 'i-lucide-users' },
                  { label: 'Public link', value: 'public', icon: 'i-lucide-globe' }
                ]"
                size="xs"
                @update:model-value="(v: string) => setVisibility(video, v as Video['visibility'])"
              />
            </div>

            <div class="video-actions">
              <UButton :to="`/watch/${video.shareToken}`" size="sm" icon="i-lucide-play" class="flex-1" block>
                Play
              </UButton>
              <UButton @click="copyLink(video)" variant="outline" size="sm"
                :icon="copied === video.id ? 'i-lucide-check' : 'i-lucide-copy'"
                class="flex-1" block>
                {{ copied === video.id ? 'Copied!' : 'Copy' }}
              </UButton>
              <UButton @click="requestDelete(video)" color="error" variant="outline" size="sm"
                icon="i-lucide-trash-2" class="flex-1" block>
                Delete
              </UButton>
            </div>
          </div>
        </div>
      </div>

      <div v-if="videos.length > 0" class="library-footer">
        <p class="video-count">{{ videos.length }} recording{{ videos.length === 1 ? '' : 's' }}</p>
      </div>
    </div>

    <UModal
      v-model:open="deleteModalOpen"
      :dismissible="!deleting"
    >
      <template #content>
        <div class="p-6 space-y-5">
          <div class="flex items-start gap-3">
            <div class="shrink-0 size-10 rounded-full bg-(--ui-error)/10 flex items-center justify-center">
              <UIcon
                name="i-lucide-triangle-alert"
                class="size-5 text-(--ui-error)"
              />
            </div>
            <div class="flex-1 min-w-0">
              <h3 class="text-lg font-semibold">
                Delete recording?
              </h3>
              <p class="text-sm text-(--ui-text-muted) mt-1">
                This will permanently delete
                <span class="font-medium text-(--ui-text)">{{ deleteTarget?.title || 'this recording' }}</span>.
                This action cannot be undone.
              </p>
              <p
                v-if="deleteError"
                class="text-sm text-(--ui-error) mt-2"
              >
                {{ deleteError }}
              </p>
            </div>
          </div>
          <div class="flex items-center justify-end gap-3 pt-2">
            <UButton
              variant="ghost"
              color="neutral"
              :disabled="deleting"
              @click="deleteModalOpen = false"
            >
              Cancel
            </UButton>
            <UButton
              color="error"
              icon="i-lucide-trash-2"
              :loading="deleting"
              @click="confirmDelete"
            >
              Delete
            </UButton>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
.library-page {
  min-height: 100%;
  background: var(--ui-bg);
  color: var(--ui-text);
}

.library-container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 1rem 2rem 2rem;
}

.library-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
  gap: 1rem;
  flex-wrap: wrap;
}

.header-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.loading-state {
  text-align: center;
  padding: 4rem 2rem;
}

.loading-spinner {
  font-size: 48px;
  color: var(--ui-text);
  margin: 0 auto 1rem;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.loading-state p { color: var(--ui-text-muted); font-size: 1.1rem; }

.empty-state {
  text-align: center;
  padding: 4rem 2rem;
}

.empty-icon {
  width: 80px;
  height: 80px;
  font-size: 80px;
  color: var(--ui-text);
  opacity: 0.3;
  margin: 0 auto 2rem;
}

.empty-state h2 { font-size: 1.5rem; margin-bottom: 1rem; }
.empty-state p { color: var(--ui-text-muted); margin-bottom: 2rem; font-size: 1.1rem; }

.video-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 1.5rem;
  margin-bottom: 2rem;
}

.video-card {
  background: var(--ui-bg-elevated);
  border: 1px solid var(--ui-border);
  border-radius: 0.5rem;
  overflow: hidden;
  transition: transform 0.2s, box-shadow 0.2s;
}

.video-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.video-thumbnail {
  position: relative;
  width: 100%;
  padding-top: 56.25%;
  background: var(--ui-border);
  overflow: hidden;
}

.thumbnail-link {
  position: absolute;
  top: 0; left: 0;
  width: 100%; height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, var(--ui-bg-elevated), var(--ui-border));
  color: var(--ui-text);
  text-decoration: none;
  transition: background 0.2s;
}

.thumbnail-link:hover {
  background: linear-gradient(135deg, var(--ui-border), var(--ui-bg-elevated));
}

.thumbnail-image {
  position: absolute;
  top: 0; left: 0;
  width: 100%; height: 100%;
  object-fit: cover;
}

.play-icon {
  font-size: 48px;
  opacity: 0.5;
  position: relative;
  z-index: 1;
}

.video-info { padding: 1rem; }

.video-title-section {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.video-title {
  font-size: 1rem;
  font-weight: 600;
  margin: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-text);
}

.video-title-input {
  flex: 1;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--ui-text);
  background: var(--ui-bg);
  color: var(--ui-text);
  border-radius: 0.25rem;
  font-size: 1rem;
  font-weight: 600;
  outline: none;
}

.edit-title-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.25rem;
  background: transparent;
  border: none;
  color: var(--ui-text-muted);
  cursor: pointer;
  border-radius: 0.25rem;
  transition: all 0.2s;
  flex-shrink: 0;
}

.edit-title-btn:hover {
  color: var(--ui-text);
  background: var(--ui-bg);
}

.video-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
  font-size: 0.875rem;
  color: var(--ui-text-muted);
}

.video-duration {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.video-visibility {
  margin-bottom: 0.75rem;
}

.video-actions {
  display: flex;
  gap: 0.5rem;
}

.video-actions .flex-1 { flex: 1; }

.library-footer {
  text-align: center;
  padding: 1rem;
  color: var(--ui-text-muted);
}

@media (max-width: 768px) {
  .library-container { padding: 1rem; }
  .library-header { flex-direction: column; align-items: stretch; }
  .video-grid { grid-template-columns: 1fr; }
}
</style>
