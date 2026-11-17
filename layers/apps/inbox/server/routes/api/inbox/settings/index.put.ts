// PUT /api/inbox/settings — write per-org inbox configuration overrides.
// Org-admin only. Partial body: only the keys present are written. Every
// write goes through core's setSetting, so values are coerced by each
// setting's registered parse and stored as org-scoped overrides — the
// code-owned defaults stay the fallback for anything never set. A value equal
// to the effective one is not written, and one equal to the code default
// clears the override instead.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { clearSetting, setSetting } from '#core/server/utils/settings-store'
import { getRegisteredSetting } from '#core/server/utils/settings-registry'
import {
  INBOX_SETTINGS_NAMESPACE,
  INBOX_SETTING_CONTACT_LOCAL,
  INBOX_SETTING_BRAND_FROM_NAME,
  INBOX_SETTING_AUTO_ACK,
  INBOX_SETTING_CONTACT_FORM_API_KEY,
  INBOX_SETTING_GROUNDING_SOURCE_URLS,
  INBOX_SETTING_NOTIFY_USER_IDS,
  INBOX_SETTING_AUTO_CLOSE_DAYS,
  INBOX_AUTO_CLOSE_DAYS_MAX,
  inboxContactLocalError
} from '../../../../utils/inbox-settings'

const Body = z.object({
  contactLocal: z.string().trim().toLowerCase().max(64)
    .superRefine((v, c) => {
      const error = inboxContactLocalError(v)
      if (error) c.addIssue({ code: 'custom', message: error })
    })
    .optional(),
  brandFromName: z.string().trim().max(200).optional(),
  autoAckEnabled: z.boolean().optional(),
  contactFormApiKey: z.string().trim().max(255).optional(),
  groundingSourceUrls: z.array(z.string().max(2000)).max(20).optional(),
  notifyUserIds: z.array(z.string().uuid()).max(50).optional(),
  // 0 = never auto-close.
  autoCloseDays: z.number().int().min(0).max(INBOX_AUTO_CLOSE_DAYS_MAX).optional()
}).strict()

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'inbox' }, 'inbox.settings.manage', async (tx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid settings', data: parsed.error.flatten() })
    }
    const b = parsed.data

    const current = await getInboxSettings(tx)
    const writes: [keyof typeof b, string][] = [
      ['contactLocal', INBOX_SETTING_CONTACT_LOCAL],
      ['brandFromName', INBOX_SETTING_BRAND_FROM_NAME],
      ['autoAckEnabled', INBOX_SETTING_AUTO_ACK],
      ['contactFormApiKey', INBOX_SETTING_CONTACT_FORM_API_KEY],
      ['groundingSourceUrls', INBOX_SETTING_GROUNDING_SOURCE_URLS],
      ['notifyUserIds', INBOX_SETTING_NOTIFY_USER_IDS],
      ['autoCloseDays', INBOX_SETTING_AUTO_CLOSE_DAYS]
    ]
    for (const [field, key] of writes) {
      const value = b[field]
      if (value === undefined) continue
      const def = getRegisteredSetting(INBOX_SETTINGS_NAMESPACE, key)!
      const parse = def.parse ?? ((v: unknown) => v)
      const next = parse(value)
      if (same(next, current[field])) continue
      if (same(next, parse(def.default))) {
        await clearSetting(tx, INBOX_SETTINGS_NAMESPACE, key)
      } else {
        await setSetting(tx, INBOX_SETTINGS_NAMESPACE, key, value)
      }
    }

    return inboxSettingsView(await getInboxSettings(tx))
  })
})

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
