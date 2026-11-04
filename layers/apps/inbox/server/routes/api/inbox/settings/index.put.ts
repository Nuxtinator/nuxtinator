// PUT /api/inbox/settings — write per-org inbox configuration overrides.
// Org-admin only. Partial body: only the keys present are written. Every
// write goes through core's setSetting, so values are coerced by each
// setting's registered parse and stored as org-scoped overrides — the
// code-owned defaults stay the fallback for anything never set. A value equal
// to the effective one is not written, and one equal to the fallback (the code
// default, or the derived slug address) clears the override instead. Changing
// the inbound domain or contact address needs inboxMailIdentityEditable; the
// domain must be unclaimed by any other org, and the contact address must
// live on it (contact+<token> replies route by that domain). On the shared
// slug-address domain the contact address is always the derived one.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { clearSetting, setSetting } from '#core/server/utils/settings-store'
import { getRegisteredSetting } from '#core/server/utils/settings-registry'
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
  INBOX_AUTO_CLOSE_DAYS_MAX
} from '../../../../utils/inbox-settings'

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i

const Body = z.object({
  // Empty string = clear back to the code default's behavior at read time
  // (the parse lowercases; routing treats '' as unconfigured).
  inboundDomain: z.string().trim().max(255)
    .refine(v => v === '' || DOMAIN_RE.test(v), 'Must be a bare domain, e.g. mail.example.com')
    .optional(),
  contactAddress: z.string().trim().max(320)
    .refine(v => v === '' || z.string().email().safeParse(v).success, 'Must be an email address')
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
  return await withOrgPermission(event, { appId: 'inbox' }, 'inbox.settings.manage', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid settings', data: parsed.error.flatten() })
    }
    const b = parsed.data

    const current = await getInboxSettings(tx)
    const domain = b.inboundDomain !== undefined ? b.inboundDomain.toLowerCase() : current.inboundDomain
    const contact = b.contactAddress !== undefined ? b.contactAddress.toLowerCase() : current.contactAddress
    const slugAddress = await inboxSlugAddressFor(tx, domain)
    if (domain !== current.inboundDomain || contact !== current.contactAddress) {
      if (!(await inboxMailIdentityEditable(tx, ctx))) {
        throw createError({ statusCode: 403, statusMessage: 'Only an operator admin can change the inbound domain or contact address' })
      }
      if (contact && contact.split('@')[1] !== domain) {
        throw createError({ statusCode: 400, statusMessage: 'The contact address must be on the inbound domain' })
      }
      if (slugAddress && contact && contact !== slugAddress) {
        throw createError({ statusCode: 400, statusMessage: `On the shared inbound domain the contact address is ${slugAddress}` })
      }
      if (domain && domain !== current.inboundDomain && await inboxDomainClaimedElsewhere(domain, ctx.orgId)) {
        throw createError({ statusCode: 409, statusMessage: 'Another organization already uses that inbound domain' })
      }
    }

    const writes: [keyof typeof b, string][] = [
      ['inboundDomain', INBOX_SETTING_INBOUND_DOMAIN],
      ['contactAddress', INBOX_SETTING_CONTACT_ADDRESS],
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
      if (same(next, parse(def.default)) || (field === 'contactAddress' && slugAddress && next === slugAddress)) {
        await clearSetting(tx, INBOX_SETTINGS_NAMESPACE, key)
      } else {
        await setSetting(tx, INBOX_SETTINGS_NAMESPACE, key, value)
      }
    }

    const s = await getInboxSettings(tx)
    return {
      inboundDomain: s.inboundDomain,
      contactAddress: s.contactAddress,
      brandFromName: s.brandFromName,
      autoAckEnabled: s.autoAckEnabled,
      contactFormApiKey: s.contactFormApiKey,
      groundingSourceUrls: s.groundingSourceUrls,
      notifyUserIds: s.notifyUserIds,
      autoCloseDays: s.autoCloseDays,
      mailIdentityEditable: await inboxMailIdentityEditable(tx, ctx)
    }
  })
})

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
