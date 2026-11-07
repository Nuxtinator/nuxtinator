<script setup lang="ts">
// Merged activity + comment timeline for one record: composer pinned on top
// (only when the caller can edit the record — commenting is a write), newest
// entries first, one "Load older" control that pages both streams. Field
// settings resolve activity field labels and value formatting; the user
// directory resolves user_select ids inside old/new snapshots.
import type { RecordsFieldSetting } from '../../utils/field-kinds'

const props = defineProps<{
  typeKey: string
  recordId: string
  /** False hides the composer. */
  canComment: boolean
}>()

const toast = useToast()
const { user } = useAuth()
const { getFields } = useRecordsTypes()
const { ensureUsers } = useRecordsUsers()

const { entries, hasMore, pending, error, loadOlder, post, editComment, removeComment, refresh } = useRecordsTimeline(
  () => props.typeKey,
  () => props.recordId
)

// The detail page re-pulls the timeline after actions that append activity
// rows (field patches, channel/consent changes, shares).
defineExpose({ refresh })

onMounted(() => {
  ensureUsers().catch(() => {
    // Formatters fall back to raw user ids.
  })
})

const fields = ref<RecordsFieldSetting[]>([])
watch(() => props.typeKey, async (key) => {
  fields.value = []
  if (!key) return
  try {
    const res = await getFields(key)
    if (key === props.typeKey) fields.value = res.fields
  } catch {
    // Activity entries fall back to raw field keys.
  }
}, { immediate: true })

const currentUserId = computed(() => (user.value as { id?: string } | null)?.id ?? null)

async function submitComment(body: string) {
  await post(body)
}

async function onEditComment(id: string, body: string) {
  try {
    await editComment(id, body)
  } catch (err) {
    toast.add({
      title: 'Edit failed',
      description: recordsErrorMessage(err, 'Failed to edit comment'),
      color: 'error'
    })
  }
}

async function onRemoveComment(id: string) {
  try {
    await removeComment(id)
  } catch (err) {
    toast.add({
      title: 'Delete failed',
      description: recordsErrorMessage(err, 'Failed to delete comment'),
      color: 'error'
    })
  }
}
</script>

<template>
  <section class="space-y-2">
    <h2 class="text-xs font-semibold uppercase tracking-wide text-(--ui-text-muted) px-1">
      Activity
    </h2>

    <RecordsCommentComposer
      v-if="canComment"
      :submit="submitComment"
    />

    <UAlert
      v-if="error"
      color="error"
      :title="error"
    />

    <div
      v-if="pending && entries.length === 0"
      class="grid place-items-center py-8 text-(--ui-text-muted)"
    >
      <UIcon
        name="i-lucide-loader-circle"
        class="size-5 animate-spin"
      />
    </div>

    <p
      v-else-if="entries.length === 0 && !error"
      class="text-sm text-(--ui-text-muted) px-1 py-2"
    >
      No activity yet.
    </p>

    <div
      v-if="entries.length > 0"
      class="border border-(--ui-border) rounded-lg divide-y divide-(--ui-border) bg-(--ui-bg)"
    >
      <template
        v-for="entry in entries"
        :key="entry.id"
      >
        <RecordsCommentBubble
          v-if="entry.kind === 'comment'"
          :comment="entry.comment"
          :own="entry.comment.authorId !== null && entry.comment.authorId === currentUserId"
          @save="onEditComment(entry.comment.id, $event)"
          @remove="onRemoveComment(entry.comment.id)"
        />
        <RecordsActivityEntry
          v-else
          :activity="entry.activity"
          :fields="fields"
        />
      </template>
    </div>

    <div
      v-if="hasMore"
      class="flex justify-center"
    >
      <UButton
        color="neutral"
        variant="ghost"
        size="xs"
        icon="i-lucide-history"
        :loading="pending"
        @click="loadOlder"
      >
        Load older
      </UButton>
    </div>
  </section>
</template>
