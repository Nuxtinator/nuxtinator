import { registerPermissions } from '#core/server/utils/permissions-registry'
import { registerDefaultGrants } from '#core/server/utils/default-grants-registry'
import { registerStaticRole } from '#core/server/utils/roles-registry'
import { registerApp } from '#core/server/utils/app-registry'
import { registerNavItem } from '#core/server/utils/nav-registry'
import { registerSetting } from '#core/server/utils/settings-registry'
import { registerAiFeature } from '#ai/server'
import { INBOX_PERMISSIONS, INBOX_PERMISSION_META, INBOX_DEFAULT_GRANTS } from '../../app/utils/permissions'
import {
  INBOX_SETTINGS_NAMESPACE,
  INBOX_SETTING_INBOUND_DOMAIN,
  INBOX_SETTING_CONTACT_ADDRESS,
  INBOX_SETTING_BRAND_FROM_NAME,
  INBOX_SETTING_AUTO_ACK,
  INBOX_SETTING_CONTACT_FORM_API_KEY,
  INBOX_SETTING_GROUNDING_SOURCE_URLS,
  INBOX_SETTING_NOTIFY_USER_IDS,
  INBOX_SETTING_AUTO_CLOSE_DAYS,
  INBOX_AUTO_CLOSE_DAYS_DEFAULT,
  sanitizeGroundingUrls,
  sanitizeInboxNotifyUserIds,
  sanitizeAutoCloseDays,
  inboxSlugAddressesEnabled
} from '../utils/inbox-settings'
import { INBOX_SETTING_TAGS, sanitizeTagPalette, type InboxTag } from '../utils/inbox-tags'
import { INBOX_AI_DRAFT_FEATURE } from '../utils/inbox-ai-draft'
import { INBOX_AI_KNOWLEDGE_FEATURE } from '../utils/inbox-ai-knowledge-extract'

// Single owner of all inbox boot registrations. Deliberately reads nothing
// from the CRM registries at boot (Nitro plugin order is alphabetical, not
// layer order) — every CRM lookup (channel types, record definitions) happens
// request-time through the merged-definition readers.
export default defineNitroPlugin(() => {
  registerPermissions(INBOX_PERMISSIONS, INBOX_PERMISSION_META)
  registerDefaultGrants('inbox', INBOX_DEFAULT_GRANTS)

  // A ready-made role so an org can hand a non-admin the whole inbox in one
  // assignment instead of assembling a custom role or per-user grants.
  registerStaticRole({
    key: 'inbox_agent',
    name: 'Inbox Agent',
    description: 'Handles the shared email inbox — read, triage, compose, and reply.',
    permissions: [...INBOX_PERMISSIONS],
    source: 'inbox'
  })

  // Per-org settings (core_settings overrides; these are the code defaults).
  const config = useRuntimeConfig()
  registerSetting<string>({
    namespace: INBOX_SETTINGS_NAMESPACE,
    key: INBOX_SETTING_INBOUND_DOMAIN,
    default: String(config.inboxDomain || '').toLowerCase(),
    parse: v => String(v ?? '').trim().toLowerCase(),
    label: 'Inbound mail domain'
  })
  registerSetting<string>({
    namespace: INBOX_SETTINGS_NAMESPACE,
    key: INBOX_SETTING_CONTACT_ADDRESS,
    // Empty under slug addresses: getInboxSettings derives the org's address.
    default: inboxSlugAddressesEnabled() ? '' : String(config.inboxContactAddress || '').toLowerCase(),
    parse: v => String(v ?? '').trim().toLowerCase(),
    label: 'Shared contact address'
  })
  registerSetting<string>({
    namespace: INBOX_SETTINGS_NAMESPACE,
    key: INBOX_SETTING_BRAND_FROM_NAME,
    default: String(config.appName || 'Support'),
    parse: v => String(v ?? '').trim(),
    label: 'Brand From name'
  })
  registerSetting<boolean>({
    namespace: INBOX_SETTINGS_NAMESPACE,
    key: INBOX_SETTING_AUTO_ACK,
    default: true,
    parse: v => v !== false && v !== 'false',
    label: 'Auto-acknowledge new conversations'
  })
  registerSetting<string>({
    namespace: INBOX_SETTINGS_NAMESPACE,
    key: INBOX_SETTING_CONTACT_FORM_API_KEY,
    default: '',
    parse: v => String(v ?? '').trim(),
    label: 'Contact-form API key'
  })
  registerSetting<InboxTag[]>({
    namespace: INBOX_SETTINGS_NAMESPACE,
    key: INBOX_SETTING_TAGS,
    default: [],
    parse: v => sanitizeTagPalette(v),
    label: 'Conversation tags'
  })
  registerSetting<string[]>({
    namespace: INBOX_SETTINGS_NAMESPACE,
    key: INBOX_SETTING_GROUNDING_SOURCE_URLS,
    default: [],
    parse: v => sanitizeGroundingUrls(v),
    label: 'AI grounding source URLs'
  })
  registerSetting<string[]>({
    namespace: INBOX_SETTINGS_NAMESPACE,
    key: INBOX_SETTING_NOTIFY_USER_IDS,
    default: [],
    parse: v => sanitizeInboxNotifyUserIds(v),
    label: 'Unassigned-mail email recipients'
  })
  registerSetting<number>({
    namespace: INBOX_SETTINGS_NAMESPACE,
    key: INBOX_SETTING_AUTO_CLOSE_DAYS,
    default: INBOX_AUTO_CLOSE_DAYS_DEFAULT,
    parse: v => sanitizeAutoCloseDays(v),
    label: 'Auto-close pending conversations after (days)'
  })

  // AI features — the admin AI page (@nuxtinator/ai) shows a model picker for
  // each. registerAiFeature is a no-op if the AI layer isn't loaded (core ships
  // a fallback), so this is always safe.
  registerAiFeature({
    key: INBOX_AI_DRAFT_FEATURE,
    label: 'Inbox — draft replies',
    description: 'Generates a grounded draft reply for a conversation.'
  })
  registerAiFeature({
    key: INBOX_AI_KNOWLEDGE_FEATURE,
    label: 'Inbox — knowledge extraction',
    description: 'Turns a resolved thread into an anonymised knowledge-base entry.'
  })

  registerApp({
    id: 'inbox',
    title: 'Inbox',
    path: '/inbox',
    icon: 'i-lucide-inbox',
    requiredPermission: 'inbox.access',
    order: 35
  })
  registerNavItem({
    appId: 'inbox',
    title: 'Conversations',
    path: '/inbox',
    icon: 'i-lucide-mails',
    requiredPermission: 'inbox.access',
    order: 10
  })
  // Nav filtering is permission-based only; the settings endpoints add the
  // org-admin role gate on top, and the page shows an admin-required notice
  // to senders who aren't admins.
  registerNavItem({
    appId: 'inbox',
    title: 'Settings',
    path: '/inbox/settings',
    icon: 'i-lucide-settings',
    requiredPermission: 'inbox.send',
    order: 90
  })
})
