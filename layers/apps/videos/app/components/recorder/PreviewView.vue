<template>
  <div class="preview-view">
    <h2>Recording Complete!</h2>
    <p class="description">
      Your recording is ready. Preview it below and upload to share or download locally.
    </p>

    <div class="video-preview">
      <video
        :src="recordedVideoUrl"
        controls
        class="preview-video"
      ></video>
    </div>

    <div class="action-buttons">
      <UDropdownMenu :items="uploadOptions" :content="{ align: 'center' }">
        <UButton icon="i-lucide-upload" trailing-icon="i-lucide-chevron-down">
          Upload & Share
        </UButton>
      </UDropdownMenu>
      <UButton @click="$emit('download')" variant="outline">
        <template #leading>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
        </template>
        Download Only
      </UButton>
      <UButton @click="$emit('reset')" variant="outline">
        <template #leading>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
          <polyline points="1 4 1 10 7 10"></polyline>
          <polyline points="23 20 23 14 17 14"></polyline>
          <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"></path>
        </svg>
        </template>
        New Recording
      </UButton>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  recordedVideoUrl: string
}>()

const emit = defineEmits<{
  upload: [audience: VideoAudience]
  download: []
  reset: []
}>()

const { mode, teams } = useTeams('videos')

const uploadOptions = computed(() => [
  {
    label: 'Private',
    description: 'Only you can see it',
    icon: 'i-lucide-lock',
    onSelect: () => emit('upload', { visibility: 'private' })
  },
  ...(mode.value === 'teams'
    ? teams.value.filter(t => t.mine && !t.archived).map(t => ({
        label: t.name,
        description: 'Your team can see it',
        avatar: groupAvatarProps(t),
        onSelect: () => emit('upload', { visibility: 'team', teamId: t.id })
      }))
    : []),
  {
    label: 'Organization',
    description: 'Anyone signed in to your org can see it',
    icon: 'i-lucide-users',
    onSelect: () => emit('upload', { visibility: 'org' })
  },
  {
    label: 'Public link',
    description: 'Your org, and anyone with the link',
    icon: 'i-lucide-globe',
    onSelect: () => emit('upload', { visibility: 'org', linkEnabled: true })
  }
])
</script>

<style scoped>
.preview-view {
  padding: 2rem;
  text-align: center;
}

.preview-view h2 {
  font-size: 2rem;
  margin-bottom: 1rem;
  font-weight: 600;
}

.description {
  font-size: 1.1rem;
  color: var(--ui-text-muted);
  margin-bottom: 2rem;
  max-width: 600px;
  margin-left: auto;
  margin-right: auto;
}

.video-preview {
  margin: 2rem 0;
  border-radius: 0.5rem;
  overflow: hidden;
  background: #000;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
}

.preview-video {
  width: 100%;
  max-height: 500px;
  display: block;
}

.action-buttons {
  display: flex;
  gap: 1rem;
  justify-content: center;
  flex-wrap: wrap;
}

.action-buttons :deep(button),
.action-buttons :deep(a) {
  margin: 0 !important;
}

@media (max-width: 640px) {
  .preview-view h2 {
    font-size: 1.5rem;
  }

  .action-buttons {
    flex-direction: column;
  }
}
</style>
