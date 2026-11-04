<script setup lang="ts">
import type { FilesItemDetail, FilesVersion } from '../../composables/useFiles'

definePageMeta({
  middleware: 'auth'
})

const route = useRoute()
const toast = useToast()
const id = computed(() => route.params.id as string)

// Pull a human message out of an $fetch/h3 error (body statusMessage first).
function errMsg(e: unknown): string {
  const err = e as { statusMessage?: string, data?: { statusMessage?: string, message?: string }, message?: string }
  return err?.data?.statusMessage || err?.statusMessage || err?.data?.message || err?.message || 'Something went wrong.'
}

const {
  get, update, remove, replaceFile, listVersions, restoreVersion, issueLink, revokeLink, shareUrl, siteUrl, rawUrl
} = useFiles()

const item = ref<FilesItemDetail | null>(null)
const loading = ref(true)
const notFound = ref(false)

// Working copy for editable kinds (docs and sites). They open in edit mode by
// default; `editing` toggles between the split editor and a full-width
// rendered display.
const editing = ref(false)
const editTitle = ref('')
const editBody = ref('')
const saving = ref(false)

// Docs and sites are editable in-app; uploaded files are not.
const isEditable = computed(() => item.value != null && item.value.kind !== 'file')
const editorOpen = computed(() => isEditable.value && editing.value)

async function load() {
  loading.value = true
  notFound.value = false
  try {
    item.value = await get(id.value)
    if (item.value.kind !== 'file') {
      editTitle.value = item.value.title
      editBody.value = item.value.body_md ?? ''
    }
  } catch {
    notFound.value = true
  } finally {
    loading.value = false
  }
}

async function saveEdit() {
  if (!editTitle.value.trim()) {
    toast.add({ title: 'Title is required', color: 'error' })
    return
  }
  saving.value = true
  try {
    await update(id.value, { title: editTitle.value.trim(), body_md: editBody.value })
    await load()
    toast.add({ title: 'Saved', color: 'success' })
  } catch (e) {
    toast.add({ title: errMsg(e), color: 'error' })
  } finally {
    saving.value = false
  }
}

// ── Replace (uploaded files) ───────────────────────────────────────────────
const replaceInput = ref<HTMLInputElement | null>(null)
const replacing = ref(false)

async function onReplaceChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  replacing.value = true
  try {
    await replaceFile(id.value, file)
    await load()
    toast.add({ title: 'File replaced', color: 'success' })
  } catch (e) {
    toast.add({ title: errMsg(e), color: 'error' })
  } finally {
    replacing.value = false
    input.value = ''
  }
}

// ── Versions ─────────────────────────────────────────────────────────────
const versionsOpen = ref(false)
const versions = ref<FilesVersion[]>([])
const restoring = ref(false)

async function openVersions() {
  versions.value = await listVersions(id.value)
  versionsOpen.value = true
}

async function onRestore(versionId: string) {
  restoring.value = true
  try {
    await restoreVersion(id.value, versionId)
    versions.value = await listVersions(id.value)
    await load()
    toast.add({ title: 'Version restored', color: 'success' })
  } catch (e) {
    toast.add({ title: errMsg(e), color: 'error' })
  } finally {
    restoring.value = false
  }
}

// ── Details (title + tags) ───────────────────────────────────────────────
const detailsOpen = ref(false)
const detailsTitle = ref('')
const detailsTags = ref<string[]>([])
const savingDetails = ref(false)

function openDetails() {
  if (!item.value) return
  detailsTitle.value = item.value.title
  detailsTags.value = [...item.value.tags]
  detailsOpen.value = true
}

async function saveDetails() {
  savingDetails.value = true
  try {
    await update(id.value, { title: detailsTitle.value.trim(), tags: detailsTags.value })
    detailsOpen.value = false
    await load()
  } catch (e) {
    toast.add({ title: errMsg(e), color: 'error' })
  } finally {
    savingDetails.value = false
  }
}

// ── Share ────────────────────────────────────────────────────────────────
const sharing = ref(false)

// Robust copy: the async Clipboard API silently no-ops in some browsers when
// the document isn't focused (e.g. a toast overlay is up), so guard on
// document.hasFocus() and otherwise fall back to the synchronous, focus-
// independent execCommand path.
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext && document.hasFocus()) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to legacy
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

async function onShare() {
  sharing.value = true
  try {
    // Create + copy in one action (copy before the reload/toast, while the
    // click gesture is fresh and no toast overlay is up yet).
    const token = await issueLink(id.value)
    const copied = await copyToClipboard(shareUrl(item.value!, token))
    await load()
    toast.add({
      title: copied ? 'Share link created and copied' : 'Share link created',
      color: 'success'
    })
  } catch (e) {
    toast.add({ title: errMsg(e), color: 'error' })
  } finally {
    sharing.value = false
  }
}

async function onRevoke() {
  sharing.value = true
  try {
    await revokeLink(id.value)
    await load()
    toast.add({ title: 'Share link revoked', color: 'neutral' })
  } catch (e) {
    toast.add({ title: errMsg(e), color: 'error' })
  } finally {
    sharing.value = false
  }
}

async function copyLink(url?: string) {
  if (!item.value?.share_token) return
  url ??= shareUrl(item.value, item.value.share_token)
  const copied = await copyToClipboard(url)
  toast.add(copied
    ? { title: 'Link copied', color: 'success' }
    : { title: url, color: 'neutral' })
}

// ── Delete ───────────────────────────────────────────────────────────────
const deleteOpen = ref(false)
const deleting = ref(false)

async function onDelete() {
  deleting.value = true
  try {
    await remove(id.value)
    await navigateTo('/files')
  } catch (e) {
    toast.add({ title: errMsg(e), color: 'error' })
  } finally {
    deleting.value = false
    deleteOpen.value = false
  }
}

onMounted(async () => {
  await load()
  // Docs and sites open straight into edit mode.
  if (isEditable.value) editing.value = true
})
</script>

<template>
  <div
    class="flex flex-col w-full"
    :class="editorOpen ? '' : (item?.kind === 'file' ? 'max-w-7xl mx-auto' : 'max-w-5xl mx-auto')"
  >
    <div v-if="loading" class="text-center py-16 text-(--ui-text-muted)">
      <UIcon name="i-lucide-loader-circle" class="size-6 animate-spin" />
    </div>

    <UEmpty
      v-else-if="notFound || !item"
      icon="i-lucide-file-x"
      title="Not found"
      description="This file may have been deleted."
      :actions="[{ label: 'Back to files', to: '/files', icon: 'i-lucide-arrow-left' }]"
    />

    <template v-else>
      <!-- Header -->
      <div class="flex items-center gap-2 mb-4">
        <UButton
          to="/files"
          icon="i-lucide-arrow-left"
          variant="ghost"
          color="neutral"
          aria-label="Back to files"
        />
        <UInput
          v-if="editorOpen"
          v-model="editTitle"
          :placeholder="item.kind === 'site' ? 'Untitled site' : 'Untitled document'"
          size="lg"
          class="flex-1"
          :ui="{ base: 'font-semibold' }"
        />
        <h1 v-else class="text-xl font-semibold flex-1 truncate">
          {{ isEditable ? editTitle : item.title }}
        </h1>

        <!-- Editable (doc/site) mode controls -->
        <template v-if="isEditable">
          <UButton v-if="editing" icon="i-lucide-check" :loading="saving" @click="saveEdit">
            Save
          </UButton>
          <UButton
            v-if="editing"
            icon="i-lucide-eye"
            variant="outline"
            color="neutral"
            @click="editing = false"
          >
            Display
          </UButton>
          <UButton
            v-else
            icon="i-lucide-pencil"
            @click="editing = true"
          >
            Edit
          </UButton>
          <UButton
            icon="i-lucide-history"
            variant="outline"
            color="neutral"
            @click="openVersions"
          >
            Versions
          </UButton>
        </template>

        <!-- File mode controls -->
        <UButton
          v-if="item.kind === 'file'"
          icon="i-lucide-replace"
          variant="outline"
          color="neutral"
          :loading="replacing"
          @click="replaceInput?.click()"
        >
          Replace
        </UButton>

        <!-- Always available -->
        <UButton
          icon="i-lucide-settings-2"
          variant="ghost"
          color="neutral"
          aria-label="Edit details"
          @click="openDetails"
        />
        <UButton
          icon="i-lucide-trash-2"
          variant="ghost"
          color="error"
          aria-label="Delete"
          @click="deleteOpen = true"
        />
      </div>

      <!-- Tags + share bar (visible in both view and edit modes) -->
      <div class="flex flex-wrap items-center gap-2 mb-4">
        <UBadge
          v-for="t in item.tags"
          :key="t"
          :label="t"
          icon="i-lucide-tag"
          color="neutral"
          variant="soft"
        />
        <div class="flex-1" />
        <UButton
          v-if="item.kind === 'file' && item.url"
          size="sm"
          variant="soft"
          icon="i-lucide-download"
          :href="item.url"
          target="_blank"
          external
        >
          Download
        </UButton>
        <template v-if="item.share_token">
          <!-- Plain external anchor (not a router link): the raw site route is
               served by Nitro, outside the SPA. -->
          <UButton
            v-if="item.kind === 'site'"
            size="sm"
            variant="soft"
            icon="i-lucide-external-link"
            :href="siteUrl(item.share_token)"
            target="_blank"
            external
          >
            Open site
          </UButton>
          <UButton size="sm" variant="soft" icon="i-lucide-link" @click="copyLink()">
            Copy link
          </UButton>
          <template v-if="item.kind === 'file'">
            <UButton size="sm" variant="soft" icon="i-lucide-code" @click="copyLink(rawUrl(item.share_token))">
              Copy embed link
            </UButton>
            <UButton size="sm" variant="soft" icon="i-lucide-download" @click="copyLink(rawUrl(item.share_token, true))">
              Copy download link
            </UButton>
          </template>
          <UButton
            size="sm"
            variant="ghost"
            color="neutral"
            icon="i-lucide-link-2-off"
            :loading="sharing"
            @click="onRevoke"
          >
            Revoke
          </UButton>
        </template>
        <UButton
          v-else
          size="sm"
          variant="outline"
          color="neutral"
          icon="i-lucide-share-2"
          :loading="sharing"
          @click="onShare"
        >
          Share
        </UButton>
      </div>

      <!-- Body -->
      <div>
        <FilesDocEditor
          v-if="editorOpen && item.kind === 'doc'"
          v-model:body-md="editBody"
        />
        <FilesSiteEditor
          v-else-if="editorOpen && item.kind === 'site'"
          v-model:html="editBody"
        />
        <div
          v-else-if="item.kind === 'doc'"
          class="rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-6"
        >
          <FilesRenderer :body-md="editBody" />
        </div>
        <!-- Site display: sandboxed (opaque-origin) preview — the pasted
             HTML's scripts can't reach the app's DOM, storage, or APIs. -->
        <iframe
          v-else-if="item.kind === 'site'"
          :srcdoc="editBody"
          sandbox="allow-scripts allow-forms allow-popups allow-modals"
          :title="item.title"
          class="w-full h-[80vh] rounded-lg border border-(--ui-border) bg-white"
        />
        <FilesFilePreview v-else :item="item" />
      </div>

      <!-- Hidden picker for "Replace" on uploaded files -->
      <input
        ref="replaceInput"
        type="file"
        class="hidden"
        @change="onReplaceChange"
      >
    </template>

    <!-- Versions slideover -->
    <USlideover v-model:open="versionsOpen" title="Version history">
      <template #body>
        <FilesVersionHistory
          :versions="versions"
          :current-body="editBody"
          :restoring="restoring"
          @restore="onRestore"
        />
      </template>
    </USlideover>

    <!-- Details modal -->
    <UModal v-model:open="detailsOpen" title="Edit details">
      <template #body>
        <div class="flex flex-col gap-4">
          <UFormField label="Title">
            <UInput v-model="detailsTitle" class="w-full" />
          </UFormField>
          <UFormField label="Tags" description="Press enter to add a tag.">
            <UInputTags v-model="detailsTags" class="w-full" />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton variant="ghost" color="neutral" @click="detailsOpen = false">Cancel</UButton>
          <UButton :loading="savingDetails" @click="saveDetails">Save</UButton>
        </div>
      </template>
    </UModal>

    <!-- Delete confirm -->
    <UModal v-model:open="deleteOpen" title="Delete this item?">
      <template #body>
        <p class="text-sm text-(--ui-text-muted)">
          This can't be undone{{ item?.kind === 'file' ? ' — the file will be removed from storage' : '' }}.
        </p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton variant="ghost" color="neutral" @click="deleteOpen = false">Cancel</UButton>
          <UButton color="error" :loading="deleting" @click="onDelete">Delete</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
