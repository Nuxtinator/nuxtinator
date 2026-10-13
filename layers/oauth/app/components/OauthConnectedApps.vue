<script setup lang="ts">
// "Connected apps" UCard. Drops into any consumer page (typically
// the user's profile). Self-contained: fetches, lists, confirms,
// revokes, refetches. Consumer integration is one tag: <OauthConnectedApps />.
//
// English-only by design — matches the consumer's existing email
// templates and profile page. Localising is a separate later pass.

import { h } from 'vue'
import type { TableColumn } from '@nuxt/ui'

interface ConnectedApp {
  client_id: string
  client_name: string
  dynamic: boolean
  scope: string
  // Each scope with the title people read it by.
  scopes: { scope: string, title: string, description: string }[]
  granted_at: string
  last_used_at: string | null
  has_active_tokens: boolean
}

interface ConnectedAppsResponse {
  apps: ConnectedApp[]
}

const UBadge = resolveComponent('UBadge')
const UIcon = resolveComponent('UIcon')
const UTooltip = resolveComponent('UTooltip')

const toast = useToast()

const { data, pending, error, refresh } = await useFetch<ConnectedAppsResponse>(
  '/api/oauth/connected-apps',
  {
    // Re-fetch when the page is re-entered; the user expects fresh
    // data after granting/revoking elsewhere (e.g. an MCP client
    // just authorized in another tab).
    server: false,
    lazy: true,
    default: () => ({ apps: [] })
  }
)

const apps = computed<ConnectedApp[]>(() => data.value?.apps ?? [])

// ── Revoke modal state ──────────────────────────────────────────────
const revokeTarget = ref<ConnectedApp | null>(null)
const revoking = ref(false)
const revokeOpen = computed({
  get: () => revokeTarget.value !== null,
  set: (val: boolean) => {
    if (!val && !revoking.value) revokeTarget.value = null
  }
})

const requestRevoke = (app: ConnectedApp) => {
  revokeTarget.value = app
}

const handleRevoke = async () => {
  if (!revokeTarget.value) return
  revoking.value = true
  const target = revokeTarget.value
  try {
    await $fetch(`/api/oauth/connected-apps/${encodeURIComponent(target.client_id)}`, {
      method: 'DELETE'
    })
    toast.add({
      title: 'Access revoked',
      description: `${target.client_name} can no longer access your account.`,
      color: 'success'
    })
    await refresh()
    revokeTarget.value = null
  } catch (err: unknown) {
    const message = (err as { data?: { statusMessage?: string }; statusMessage?: string })?.data?.statusMessage
      || (err as { statusMessage?: string })?.statusMessage
      || 'Failed to revoke access'
    toast.add({ title: 'Error', description: message, color: 'error' })
  } finally {
    revoking.value = false
  }
}

// ── Formatting helpers ──────────────────────────────────────────────
const formatRelative = (iso: string | null): string => {
  if (!iso) return 'Never'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'Just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  if (ms < 7 * 86_400_000) return `${Math.floor(ms / 86_400_000)}d ago`
  return new Date(iso).toLocaleDateString()
}

const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

// ── Connection guide (collapsible + tabs) ──────────────────────────
//
// One tab per major MCP client. Each tab carries a ready-to-paste
// config snippet pointing at this site's MCP endpoint. Pulled from
// runtimeConfig.public.siteUrl so the snippet is always live for the
// deployment the user is looking at — no copy-paste-and-replace.

const config = useRuntimeConfig()
const mcpUrl = computed(() => {
  const base = (config.public.siteUrl as string) || ''
  if (!base) return '/mcp'
  return `${base.replace(/\/$/, '')}/mcp`
})

// Local identifier each client registers this server under. Slugified
// from the host's app title so the snippets name the deployment they
// point at; `mcp` when no title is configured.
const mcpServerName = computed(() => {
  const title = (config.public.appName as string) || ''
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || 'mcp'
})

interface ClientGuide {
  key: string
  label: string
  icon: string
  description: string
  // Natural-language prompt the user can paste into the client (or
  // any AI assistant with filesystem/CLI access) to wire up the MCP.
  // The "AI does it" path — meant as the primary instruction.
  aiPrompt: string
  // Where the manual config snippet should be pasted/run.
  manualLocation: string
  // The literal config snippet for the manual path.
  manualSnippet: string
  manualLanguage: 'bash' | 'json' | 'toml'
}

const clientGuides = computed<ClientGuide[]>(() => {
  const url = mcpUrl.value
  const name = mcpServerName.value
  return [
    {
      key: 'claude-code',
      label: 'Claude Code',
      icon: 'i-lucide-terminal',
      description: 'Native HTTP + OAuth.',
      aiPrompt: `Add the ${name} MCP server at ${url} using HTTP transport at user scope so it is available in every project, then restart to authenticate.`,
      manualLocation: 'Run from any folder; user scope makes it available in every project:',
      manualLanguage: 'bash',
      manualSnippet: `claude mcp add --scope user ${name} --transport http ${url}`
    },
    {
      key: 'claude-desktop',
      label: 'Claude Desktop',
      icon: 'i-lucide-monitor',
      description: 'Stdio-only. Bridges OAuth + HTTP via mcp-remote.',
      aiPrompt: `Edit my Claude Desktop config (~/Library/Application Support/Claude/claude_desktop_config.json on macOS, %APPDATA%\\Claude\\claude_desktop_config.json on Windows) to add an MCP server named "${name}" that runs \`npx -y mcp-remote ${url}\`.`,
      manualLocation: 'Edit ~/Library/Application Support/Claude/claude_desktop_config.json (macOS) or %APPDATA%\\Claude\\claude_desktop_config.json (Windows):',
      manualLanguage: 'json',
      manualSnippet: JSON.stringify({
        mcpServers: {
          [name]: {
            command: 'npx',
            args: ['-y', 'mcp-remote', url]
          }
        }
      }, null, 2)
    },
    {
      key: 'codex',
      label: 'Codex',
      icon: 'i-lucide-square-terminal',
      description: 'Stdio-only. Bridges OAuth + HTTP via mcp-remote.',
      aiPrompt: `Add an MCP server named "${name}" to my ~/.codex/config.toml that runs \`npx -y mcp-remote ${url}\`.`,
      manualLocation: 'Edit ~/.codex/config.toml:',
      manualLanguage: 'toml',
      manualSnippet: `[mcp_servers.${name}]\ncommand = "npx"\nargs = ["-y", "mcp-remote", "${url}"]`
    },
    {
      key: 'cursor',
      label: 'Cursor',
      icon: 'i-lucide-mouse-pointer-2',
      description: 'Native HTTP + OAuth.',
      aiPrompt: `Add an MCP server named "${name}" pointing at ${url} to my Cursor MCP config (~/.cursor/mcp.json).`,
      manualLocation: 'Settings → MCP → Add new MCP server, or edit ~/.cursor/mcp.json:',
      manualLanguage: 'json',
      manualSnippet: JSON.stringify({
        mcpServers: {
          [name]: {
            url
          }
        }
      }, null, 2)
    },
    {
      key: 'vscode',
      label: 'VS Code',
      icon: 'i-lucide-code-2',
      description: 'Native HTTP + OAuth via Copilot Chat (1.102+).',
      aiPrompt: `Add an MCP server named "${name}" of type http pointing at ${url} to my user-level VS Code MCP config (Command Palette → "MCP: Open User Configuration") so it is available in every workspace.`,
      manualLocation: 'Command Palette → "MCP: Open User Configuration", then add to the user-level mcp.json:',
      manualLanguage: 'json',
      manualSnippet: JSON.stringify({
        servers: {
          [name]: {
            type: 'http',
            url
          }
        }
      }, null, 2)
    },
    {
      key: 'gemini',
      label: 'Gemini CLI',
      icon: 'i-lucide-sparkles',
      description: 'Bridges OAuth + HTTP via mcp-remote.',
      aiPrompt: `Add an MCP server named "${name}" to my ~/.gemini/settings.json that runs \`npx -y mcp-remote ${url}\`.`,
      manualLocation: 'Add to ~/.gemini/settings.json:',
      manualLanguage: 'json',
      manualSnippet: JSON.stringify({
        mcpServers: {
          [name]: {
            command: 'npx',
            args: ['-y', 'mcp-remote', url]
          }
        }
      }, null, 2)
    }
  ]
})

interface TabItem {
  label: string
  value: string
  icon: string
  description: string
  aiPrompt: string
  manualLocation: string
  manualSnippet: string
  manualLanguage: string
}

const tabItems = computed<TabItem[]>(() =>
  clientGuides.value.map(g => ({
    label: g.label,
    value: g.key,
    icon: g.icon,
    description: g.description,
    aiPrompt: g.aiPrompt,
    manualLocation: g.manualLocation,
    manualSnippet: g.manualSnippet,
    manualLanguage: g.manualLanguage
  }))
)

const activeTab = ref<string>('claude-code')
const guideOpen = ref<boolean>(false)
const manualOpen = ref<Record<string, boolean>>({})
const copiedKey = ref<string | null>(null)

async function copyText(text: string, key: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    copiedKey.value = key
    toast.add({
      title: 'Copied',
      color: 'success'
    })
    setTimeout(() => {
      if (copiedKey.value === key) copiedKey.value = null
    }, 2000)
  }
  catch {
    toast.add({ title: 'Copy failed', color: 'error' })
  }
}

// ── Table columns ───────────────────────────────────────────────────
const columns: TableColumn<ConnectedApp>[] = [
  {
    accessorKey: 'client_name',
    header: 'App',
    cell: ({ row }) => h('div', { class: 'flex flex-col gap-1' }, [
      h('div', { class: 'flex items-center gap-2' }, [
        h('span', { class: 'font-medium' }, row.original.client_name),
        row.original.dynamic
          ? h(UBadge, { color: 'neutral', variant: 'subtle', size: 'sm' }, () => 'DCR')
          : null
      ]),
      !row.original.has_active_tokens
        ? h('span', { class: 'text-xs text-(--ui-text-muted)' }, 'No active session')
        : null
    ])
  },
  {
    accessorKey: 'scope',
    header: 'Permissions',
    // Show only the count — listing every permission inline blows the
    // row height out for clients that hold many scopes. The full list
    // is one hover away via the tooltip's `text` prop. Newlines render
    // because we override `content.class` with `whitespace-pre-line`.
    cell: ({ row }) => {
      const scopes = row.original.scopes
      const count = scopes.length
      const label = `${count} permission${count === 1 ? '' : 's'}`
      const tooltipText = scopes.map(s => `• ${s.title}`).join('\n')
      return h(UTooltip, {
        text: tooltipText,
        delayDuration: 100,
        ui: { text: 'whitespace-pre-line text-left block' }
      }, () => h(UBadge, {
        color: 'neutral',
        variant: 'subtle',
        size: 'sm',
        class: 'cursor-help'
      }, () => label))
    }
  },
  {
    accessorKey: 'last_used_at',
    header: 'Last used',
    cell: ({ row }) => h('span', { class: 'text-sm text-(--ui-text-muted)' },
      formatRelative(row.original.last_used_at))
  },
  {
    accessorKey: 'granted_at',
    header: 'Granted',
    cell: ({ row }) => h('span', { class: 'text-sm text-(--ui-text-muted)' },
      formatDate(row.original.granted_at))
  },
  {
    id: 'actions',
    header: '',
    cell: ({ row }) => h('div', { class: 'flex justify-end' }, [
      h(resolveComponent('UButton'), {
        color: 'error',
        variant: 'soft',
        size: 'sm',
        icon: 'i-lucide-shield-off',
        'aria-label': `Revoke access for ${row.original.client_name}`,
        onClick: () => requestRevoke(row.original)
      }, () => 'Revoke')
    ])
  }
]
</script>

<template>
  <UCard>
    <template #header>
      <div>
        <h2 class="text-xl font-semibold">Connected apps</h2>
        <p class="text-sm text-(--ui-text-muted) mt-1">
          Apps and AI agents that have access to your account via OAuth.
          Revoking access immediately ends any active sessions.
        </p>
      </div>
    </template>

    <UAlert
      v-if="error"
      color="error"
      :title="(error as { statusMessage?: string }).statusMessage || 'Failed to load connected apps'"
      class="mb-4"
    />

    <div
      v-if="!pending && apps.length === 0"
      class="flex flex-col items-center justify-center py-8 text-center"
    >
      <UIcon name="i-lucide-link-2-off" class="size-8 text-(--ui-text-muted) mb-2" />
      <p class="text-sm text-(--ui-text-muted)">No apps have been connected to your account.</p>
    </div>

    <div
      v-else
      class="border border-(--ui-border) rounded-lg overflow-hidden bg-(--ui-bg-elevated)"
    >
      <UTable
        :data="apps"
        :columns="columns"
        :loading="pending"
        :empty-state="{ icon: 'i-lucide-link-2-off', label: 'No apps connected' }"
      />
    </div>

    <!-- Connection guide ─────────────────────────────────────────── -->
    <UCollapsible
      v-model:open="guideOpen"
      class="mt-6 border-t border-(--ui-border) pt-4"
    >
      <UButton
        :icon="guideOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
        variant="ghost"
        color="neutral"
        block
        class="justify-start gap-2"
      >
        Connect a new client
      </UButton>
      <template #content>
        <div class="mt-4 space-y-4">
          <p class="text-sm text-(--ui-text-muted)">
            Pick your client below. Each option points at this site's MCP endpoint:
            <code class="text-xs font-mono px-1.5 py-0.5 rounded bg-(--ui-bg-elevated) border border-(--ui-border)">{{ mcpUrl }}</code>
            On first connect, you'll be redirected here to approve the grant.
          </p>

          <USelect
            v-model="activeTab"
            :items="tabItems"
            class="w-full sm:w-64"
            placeholder="Select a client"
          />

          <div
            v-for="item in tabItems"
            :key="item.value"
            v-show="item.value === activeTab"
            class="space-y-4"
          >
            <p class="text-sm text-(--ui-text-muted)">{{ item.description }}</p>

            <!-- AI-driven path: copy the prompt and paste into the client. -->
            <div>
              <div class="flex items-center gap-2 mb-2">
                <UIcon name="i-lucide-sparkles" class="size-4 text-(--ui-primary)" />
                <h4 class="text-sm font-semibold">Ask your AI to set it up</h4>
              </div>
              <div class="relative">
                <div class="text-sm p-4 pr-14 rounded-lg bg-(--ui-primary)/5 border border-(--ui-primary)/20 italic">
                  {{ item.aiPrompt }}
                </div>
                <UButton
                  :icon="copiedKey === `${item.value}-prompt` ? 'i-lucide-check' : 'i-lucide-copy'"
                  :color="copiedKey === `${item.value}-prompt` ? 'success' : 'neutral'"
                  variant="soft"
                  size="xs"
                  class="absolute top-2 right-2"
                  :aria-label="`Copy ${item.label} prompt`"
                  @click="copyText(item.aiPrompt, `${item.value}-prompt`)"
                >
                  {{ copiedKey === `${item.value}-prompt` ? 'Copied' : 'Copy' }}
                </UButton>
              </div>
            </div>

            <!-- Manual path: collapsed by default. -->
            <UCollapsible v-model:open="manualOpen[item.value]">
              <UButton
                :icon="manualOpen[item.value] ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                variant="ghost"
                color="neutral"
                size="sm"
                class="gap-2"
              >
                Manual setup
              </UButton>
              <template #content>
                <div class="mt-3 space-y-2">
                  <p class="text-xs text-(--ui-text-muted)">{{ item.manualLocation }}</p>
                  <div class="relative">
                    <pre class="text-xs font-mono p-4 pr-14 rounded-lg bg-(--ui-bg-elevated) border border-(--ui-border) overflow-x-auto whitespace-pre"><code>{{ item.manualSnippet }}</code></pre>
                    <UButton
                      :icon="copiedKey === `${item.value}-manual` ? 'i-lucide-check' : 'i-lucide-copy'"
                      :color="copiedKey === `${item.value}-manual` ? 'success' : 'neutral'"
                      variant="soft"
                      size="xs"
                      class="absolute top-2 right-2"
                      :aria-label="`Copy ${item.label} config`"
                      @click="copyText(item.manualSnippet, `${item.value}-manual`)"
                    >
                      {{ copiedKey === `${item.value}-manual` ? 'Copied' : 'Copy' }}
                    </UButton>
                  </div>
                </div>
              </template>
            </UCollapsible>
          </div>
        </div>
      </template>
    </UCollapsible>

    <UModal v-model:open="revokeOpen" :dismissible="!revoking">
      <template #content>
        <div class="p-6 space-y-5">
          <div class="flex items-start gap-3">
            <div class="shrink-0 size-10 rounded-full bg-(--ui-error)/10 flex items-center justify-center">
              <UIcon name="i-lucide-triangle-alert" class="size-5 text-(--ui-error)" />
            </div>
            <div class="flex-1 min-w-0">
              <h3 class="text-lg font-semibold">Revoke access?</h3>
              <p class="text-sm text-(--ui-text-muted) mt-1">
                <span class="font-medium text-(--ui-text)">{{ revokeTarget?.client_name }}</span>
                will be locked out immediately. Any active sessions or tokens it holds will stop working.
                It can request access again, but you will be asked to consent.
              </p>
            </div>
          </div>
          <div class="flex items-center justify-end gap-3 pt-2">
            <UButton
              variant="ghost"
              color="neutral"
              :disabled="revoking"
              @click="revokeTarget = null"
            >
              Cancel
            </UButton>
            <UButton
              color="error"
              icon="i-lucide-shield-off"
              :loading="revoking"
              @click="handleRevoke"
            >
              Revoke access
            </UButton>
          </div>
        </div>
      </template>
    </UModal>
  </UCard>
</template>
