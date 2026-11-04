// Grounding sync. Snapshots each configured page URL into grounding_documents so
// the AI drafter grounds on stable copies (drafting survives a source being
// down). Per-org: reads the org's grounding_source_urls setting, fetches each
// URL's HTML → text, upserts, prunes URLs no longer configured, resets the
// per-org static-pack cache. Fetches happen OUTSIDE any transaction; reads/writes
// run in scoped transactions (the send-sweep pattern). URLs come from org
// admins, so fetches go through core's safeFetch, which refuses private,
// loopback and cloud-metadata addresses on every redirect hop.
import { safeFetch } from '#core/server/utils/safe-fetch'
import { getInboxSettings } from './inbox-settings'
import {
  inboxUpsertGroundingDocument,
  inboxDeleteGroundingKeysNotIn,
  INBOX_GROUNDING_SOURCE_PAGE
} from './inbox-grounding'
import { resetInboxGroundingCache } from './inbox-ai-grounding'
import { inboxListOrgScopes, inboxWithScopeTx } from './inbox-org-routing'

export interface InboxGroundingSyncResult {
  synced: string[]
  failed: { url: string, error: string }[]
  pruned: number
}

// Light HTML → text: block-closers become newlines, tags stripped, a few
// entities decoded, whitespace collapsed. Good enough to feed a model prose.
function htmlToPlainText(html: string): string {
  return html
    .replace(/<\s*(?:br\s*\/?|\/(?:p|h[1-6]|li|div|tr))\s*>/gi, '\n')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

const MAX_PAGE_BYTES = 5 * 1024 * 1024

async function fetchPageText(url: string): Promise<string> {
  // VITEST short-circuit — no network in tests; the grounding-refresh endpoint
  // still exercises the upsert/prune path against these stubs.
  if (process.env.VITEST) return `Stubbed reference content for ${url}.`
  const res = await safeFetch(url, {
    headers: { accept: 'text/html,application/xhtml+xml,text/plain' },
    timeoutMs: 10_000,
    maxBytes: MAX_PAGE_BYTES,
    wantBody: status => status >= 200 && status < 300
  })
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`)
  if (res.tooLarge || res.body === null) throw new Error('page too large')
  return htmlToPlainText(res.body)
}

// Sync one org's grounding. orgId null = single-tenant deployment-global scope.
export async function syncInboxGroundingForOrg(orgId: string | null): Promise<InboxGroundingSyncResult> {
  const urls = await inboxWithScopeTx(orgId, async tx => (await getInboxSettings(tx)).groundingSourceUrls)

  const synced: string[] = []
  const failed: { url: string, error: string }[] = []

  for (const url of urls) {
    try {
      const text = await fetchPageText(url)
      // Empty body = failure, not a blank overwrite (keep the prior snapshot).
      if (!text) {
        failed.push({ url, error: 'empty body' })
        continue
      }
      await inboxWithScopeTx(orgId, tx =>
        inboxUpsertGroundingDocument(tx, {
          source: INBOX_GROUNDING_SOURCE_PAGE,
          docKey: url,
          title: url,
          bodyText: text
        })
      )
      synced.push(url)
    } catch (err) {
      // A failed fetch keeps its url in the prune keep-list below, so its old
      // snapshot survives the outage.
      failed.push({ url, error: err instanceof Error ? err.message : String(err) })
    }
  }

  // Prune snapshots whose url is no longer configured (guarded against wiping
  // everything on an empty list).
  const pruned = await inboxWithScopeTx(orgId, tx =>
    inboxDeleteGroundingKeysNotIn(tx, INBOX_GROUNDING_SOURCE_PAGE, urls)
  )

  resetInboxGroundingCache(orgId)
  return { synced, failed, pruned }
}

// Sweep every active org scope (the scheduler body; suspended orgs are skipped,
// sparing their fetches and embeddings). One org's failure never aborts the
// others.
export async function syncAllInboxGrounding(): Promise<void> {
  for (const orgId of await inboxListOrgScopes({ activeOnly: true })) {
    try {
      const r = await syncInboxGroundingForOrg(orgId)
      if (r.synced.length || r.failed.length || r.pruned) {
        console.log(
          `[inbox] grounding sync (org ${orgId ?? 'single'}): ${r.synced.length} synced, ${r.failed.length} failed, ${r.pruned} pruned`
        )
      }
    } catch (err) {
      console.error(`[inbox] grounding sync error (org ${orgId ?? 'single'}):`, err)
    }
  }
}
