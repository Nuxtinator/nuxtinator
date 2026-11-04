// Email rendering for global notifications. Both senders build entirely from
// the notification snapshot (title / body / link) — they never re-query the
// producing app, which is what lets one mailer serve every app.
//
// Links are stored naive (`/messages/<id>`); for email we prepend the site
// origin. Immediate emails rely on the in-browser route guard to add the
// `/@<slug>` org prefix; the digest spans orgs, so it prefixes each link with
// its org's slug itself.
//
// All senders are best-effort: failures are logged and swallowed so a mailer
// outage never blocks the sweep that calls them.

import { db } from '#core/server/utils/database'
import { sendTemplateEmail } from '#email'
import { getRegisteredApp } from '#core/server/utils/app-registry'

export interface NotificationEmailRow {
  id: string
  user_id: string
  app_id: string
  title: string
  body: string | null
  link: string
}

// One org's pending digest rows for a user. `org` is null in single mode.
export interface DigestOrgGroup {
  org: { name: string, slug: string } | null
  rows: NotificationEmailRow[]
}

interface UserLookup {
  email: string
  display_name: string
}

async function loadUser(userId: string): Promise<UserLookup | null> {
  const row = await db
    .selectFrom('users')
    .select(['email', 'display_name'])
    .where('id', '=', userId)
    .executeTakeFirst()
  if (!row?.email) return null
  return { email: row.email, display_name: row.display_name || 'there' }
}

function getSiteUrl(): string {
  try {
    const cfg = useRuntimeConfig()
    const pub = (cfg.public ?? {}) as { siteUrl?: string }
    return (pub.siteUrl || '').replace(/\/$/, '')
  } catch {
    return ''
  }
}

function absoluteLink(link: string): string {
  return `${getSiteUrl()}${link.startsWith('/') ? link : `/${link}`}`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// One email per `immediate` notification.
export async function sendImmediateNotificationEmail(row: NotificationEmailRow): Promise<void> {
  try {
    const recipient = await loadUser(row.user_id)
    if (!recipient) return

    const bodyHtml = row.body
      ? `<strong>${escapeHtml(row.title)}</strong><br><br>${escapeHtml(row.body)}`
      : `<strong>${escapeHtml(row.title)}</strong>`

    await sendTemplateEmail({
      to: recipient.email,
      template: 'notification',
      subject: row.title,
      data: {
        userName: recipient.display_name,
        userEmail: recipient.email,
        message: bodyHtml,
        actionUrl: absoluteLink(row.link),
        actionText: 'Open'
      }
    })
  } catch (err) {
    console.error('[notifications] immediate email failed:', err)
  }
}

// Rows bucketed by app, apps in launcher order (registry `order`, then title).
function renderAppSections(rows: NotificationEmailRow[], orgSlug: string | null): string {
  const byApp = new Map<string, NotificationEmailRow[]>()
  for (const r of rows) {
    const list = byApp.get(r.app_id) ?? []
    list.push(r)
    byApp.set(r.app_id, list)
  }

  const apps = [...byApp.keys()].map((id) => {
    const entry = getRegisteredApp(id)
    return { id, title: entry?.title ?? id, order: entry?.order ?? 100 }
  }).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))

  return apps.map((app) => {
    const appRows = byApp.get(app.id)!
    const items = appRows
      .map((r) => {
        const text = r.body ? `${r.title} — ${r.body}` : r.title
        const link = orgSlug ? `/@${orgSlug}${r.link.startsWith('/') ? r.link : `/${r.link}`}` : r.link
        return `<li><a href="${absoluteLink(link)}" style="color:#000000">${escapeHtml(text)}</a></li>`
      })
      .join('')
    return `<div style="margin:12px 0 0;font-weight:600;color:#333">${escapeHtml(app.title)} (${appRows.length})</div>`
      + `<ul style="color:#666;line-height:1.6;margin:4px 0 12px;padding-left:20px">${items}</ul>`
  }).join('')
}

// One digest email summarizing a user's pending `digest` notifications,
// grouped by org (multi mode) and then by app.
export async function sendNotificationDigestEmail(
  userId: string,
  groups: DigestOrgGroup[]
): Promise<void> {
  try {
    const total = groups.reduce((n, g) => n + g.rows.length, 0)
    if (total === 0) return
    const recipient = await loadUser(userId)
    if (!recipient) return

    const sections = [...groups]
      .filter(g => g.rows.length > 0)
      .sort((a, b) => (a.org?.name ?? '').localeCompare(b.org?.name ?? ''))
      .map((g) => {
        const apps = renderAppSections(g.rows, g.org?.slug ?? null)
        if (!g.org) return apps
        return `<div style="margin:20px 0 4px;font-size:16px;font-weight:700;color:#000;border-bottom:1px solid #ddd;padding-bottom:4px">${escapeHtml(g.org.name)}</div>${apps}`
      })
      .join('')

    await sendTemplateEmail({
      to: recipient.email,
      template: 'notification',
      subject: `You have ${total} new notification${total === 1 ? '' : 's'}`,
      data: {
        userName: recipient.display_name,
        userEmail: recipient.email,
        message: `Here's what you missed:${sections}`,
        actionUrl: getSiteUrl() || undefined,
        actionText: getSiteUrl() ? 'Open app' : undefined
      }
    })
  } catch (err) {
    console.error('[notifications] digest email failed:', err)
  }
}
