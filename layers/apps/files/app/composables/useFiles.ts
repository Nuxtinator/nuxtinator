// Shared types + thin fetch helpers for the files layer. State lives in the
// consuming pages (plain refs + reload-after-write) to dodge useAsyncData's
// cross-component stale cache. Always uses `$fetch` so the tenancy interceptor
// (X-Active-Org header) is picked up at call time.

import { getActiveSlug } from '#tenant'

export type FilesItemKind = 'doc' | 'file' | 'site'

export interface FilesItemSummary {
  id: string
  kind: FilesItemKind
  title: string
  filename: string | null
  mime: string | null
  size_bytes: string | null
  tags: string[]
  created_at: string
  last_edited_at: string | null
  created_by: string | null
  created_by_name: string | null
  has_link: boolean
}

export interface FilesItemDetail extends FilesItemSummary {
  body_md: string | null
  url: string | null
  share_token: string | null
}

export interface FilesVersion {
  id: string
  title: string
  content: string
  edited_at: string
  edited_by: string | null
  edited_by_name: string | null
}

export function useFiles() {
  async function list(tag?: string): Promise<FilesItemSummary[]> {
    const res = await $fetch<{ items: FilesItemSummary[] }>('/api/files/items', {
      query: tag ? { tag } : undefined
    })
    return res.items
  }

  async function get(id: string): Promise<FilesItemDetail> {
    const res = await $fetch<{ item: FilesItemDetail }>(`/api/files/items/${id}`)
    return res.item
  }

  async function createDoc(input: { title: string, body_md?: string, tags?: string[] }) {
    return await $fetch<{ item: { id: string } }>('/api/files/items', {
      method: 'POST',
      body: input
    })
  }

  // A site is a self-contained HTML page; its markup travels in body_md.
  async function createSite(input: { title: string, html?: string, tags?: string[] }) {
    return await $fetch<{ item: { id: string } }>('/api/files/items', {
      method: 'POST',
      body: { kind: 'site', title: input.title, body_md: input.html, tags: input.tags }
    })
  }

  async function update(id: string, input: { title?: string, body_md?: string, tags?: string[] }) {
    return await $fetch<{ item: FilesItemDetail }>(`/api/files/items/${id}`, {
      method: 'PATCH',
      body: input
    })
  }

  async function remove(id: string) {
    return await $fetch(`/api/files/items/${id}`, { method: 'DELETE' })
  }

  // Uploads a binary as a kind='file' item. Uses XHR rather than $fetch because
  // only XHR reports upload progress; `onProgress` gets 0–1 as bytes are sent.
  function uploadFile(file: File, onProgress?: (fraction: number) => void) {
    return new Promise<{ item: FilesItemSummary }>((resolve, reject) => {
      const fd = new FormData()
      fd.append('file', file)
      const xhr = new XMLHttpRequest()
      xhr.open('POST', '/api/files/uploads')
      xhr.responseType = 'json'
      const slug = getActiveSlug()
      if (slug) xhr.setRequestHeader('X-Active-Org', slug)
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) onProgress?.(e.loaded / e.total)
      })
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response)
        else reject({ statusCode: xhr.status, data: xhr.response, statusMessage: xhr.response?.statusMessage || `Upload failed (${xhr.status})` })
      })
      xhr.addEventListener('error', () => reject(new Error('Network error during upload.')))
      xhr.send(fd)
    })
  }

  // Swap the binary on an uploaded (kind='file') item, keeping its id + share link.
  async function replaceFile(id: string, file: File) {
    const fd = new FormData()
    fd.append('file', file)
    return await $fetch<{ item: FilesItemSummary }>(`/api/files/items/${id}/replace`, {
      method: 'POST',
      body: fd
    })
  }

  async function listVersions(id: string): Promise<FilesVersion[]> {
    const res = await $fetch<{ versions: FilesVersion[] }>(`/api/files/items/${id}/versions`)
    return res.versions
  }

  async function restoreVersion(id: string, versionId: string) {
    return await $fetch(`/api/files/items/${id}/versions/${versionId}/restore`, { method: 'POST' })
  }

  async function issueLink(id: string): Promise<string> {
    const res = await $fetch<{ share_token: string }>(`/api/files/items/${id}/share`, { method: 'POST' })
    return res.share_token
  }

  async function revokeLink(id: string) {
    return await $fetch(`/api/files/items/${id}/share`, { method: 'DELETE' })
  }

  async function search(q: string): Promise<Array<FilesItemSummary & { headline: string }>> {
    const res = await $fetch<{ items: Array<FilesItemSummary & { headline: string }> }>('/api/files/search', {
      query: { q }
    })
    return res.items
  }

  function publicUrl(token: string): string {
    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    return `${origin}/files/public/${token}`
  }

  // Raw serve URL for a shared site — opens the HTML itself, full tab.
  function siteUrl(token: string): string {
    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    return `${origin}/files/site/${token}`
  }

  // Embeddable URL for a shared file (redirects to the stored bytes);
  // `download` serves it as an attachment.
  function rawUrl(token: string, download = false): string {
    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    return `${origin}/files/raw/${token}${download ? '?download=1' : ''}`
  }

  // The link to hand out for an item's share token, by kind.
  function shareUrl(item: { kind: FilesItemKind }, token: string): string {
    return item.kind === 'site' ? siteUrl(token) : publicUrl(token)
  }

  return {
    list, get, createDoc, createSite, update, remove, uploadFile, replaceFile,
    listVersions, restoreVersion, issueLink, revokeLink, search,
    publicUrl, siteUrl, shareUrl, rawUrl
  }
}

// Human-readable byte size for file rows.
export function formatBytes(bytes: string | number | null): string {
  if (bytes == null) return ''
  const n = typeof bytes === 'string' ? Number(bytes) : bytes
  if (!Number.isFinite(n) || n <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

// Pick an icon for a file row based on mime / kind.
export function iconForItem(item: { kind: FilesItemKind, mime: string | null }): string {
  if (item.kind === 'doc') return 'i-lucide-file-text'
  if (item.kind === 'site') return 'i-lucide-globe'
  const mime = item.mime ?? ''
  if (mime.startsWith('image/')) return 'i-lucide-image'
  if (mime.startsWith('video/')) return 'i-lucide-video'
  if (mime.startsWith('audio/')) return 'i-lucide-music'
  if (mime === 'application/pdf') return 'i-lucide-file-type'
  if (mime.includes('zip') || mime.includes('compressed') || mime.includes('tar')) return 'i-lucide-file-archive'
  return 'i-lucide-file'
}
