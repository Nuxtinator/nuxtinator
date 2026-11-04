<template>
  <div class="share-view">
    <div class="success-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    </div>
    <h2>Video Uploaded Successfully!</h2>
    <p class="description">
      Your recording has been saved. Share the link below with anyone you want.
    </p>

    <div class="share-link-container">
      <input
        :value="shareableLink"
        readonly
        class="share-link-input"
        @click="selectShareLink"
      />
      <UButton @click="copyShareLink">
        <template #leading>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
        </template>
        {{ copied ? 'Copied!' : 'Copy Link' }}
      </UButton>
    </div>

    <div class="action-buttons">
      <UButton :to="`/watch/${shareToken}`">
        <template #leading>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
          </svg>
        </template>
        Watch Video
      </UButton>
      <UButton to="/videos" variant="outline">
        <template #leading>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
            <rect x="2" y="3" width="20" height="18" rx="2" ry="2"></rect>
            <line x1="8" y1="10" x2="16" y2="10"></line>
            <line x1="8" y1="14" x2="16" y2="14"></line>
          </svg>
        </template>
        View Library
      </UButton>
      <UButton @click="$emit('reset-recording')" variant="outline">
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
const props = defineProps<{
  shareableLink: string
  shareToken: string | null
}>()

defineEmits<{
  'reset-recording': []
}>()

const copied = ref(false)

const copyShareLink = async () => {
  try {
    await navigator.clipboard.writeText(props.shareableLink)
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch (err) {
    console.error('Failed to copy:', err)
  }
}

const selectShareLink = (event: Event) => {
  const input = event.target as HTMLInputElement
  input.select()
}
</script>

<style scoped>
.share-view {
  padding: 2rem;
  text-align: center;
}

.success-icon {
  width: 80px;
  height: 80px;
  margin: 0 auto 2rem;
  border-radius: 50%;
  background: #10b981;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
}

.success-icon svg {
  width: 48px;
  height: 48px;
  stroke-width: 3;
}

.share-view h2 {
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

.share-link-container {
  display: flex;
  gap: 1rem;
  max-width: 700px;
  margin: 2rem auto;
  padding: 1.5rem;
  background: var(--ui-bg-elevated);
  border: 1px solid var(--ui-border);
  border-radius: 0.5rem;
}

.share-link-input {
  flex: 1;
  padding: 0.75rem;
  border: 1px solid var(--ui-border);
  border-radius: 0.25rem;
  background: var(--ui-bg);
  color: var(--ui-text);
  font-size: 0.9rem;
  cursor: pointer;
}

.share-link-input:focus {
  outline: 2px solid var(--ui-text);
  outline-offset: 2px;
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
  .share-view h2 {
    font-size: 1.5rem;
  }

  .share-link-container {
    flex-direction: column;
  }

  .share-link-input {
    width: 100%;
  }

  .action-buttons {
    flex-direction: column;
  }
}
</style>
