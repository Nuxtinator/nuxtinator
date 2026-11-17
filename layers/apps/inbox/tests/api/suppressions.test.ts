// Suppression admin: the org-wide active list (CRM's own rows and the mail
// kernel's bounces and complaints), the complaint outranking a bounce, and the
// admin un-suppress (recovery) path, which clears CRM's rows only.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import { getHostAdminDb, cleanupInboxTestData, createInboxOrgWith, postInbound, postMailEvents } from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupInboxTestData(sql) })

function uniqueSender(tag: string): string {
  return `test-inbox-${tag}-${randomUUID().slice(0, 8)}@sender.example`
}

interface Item { channelId: string, value: string, reason: string, detail: string | null, clearable: boolean }

async function triggerBounce(org: { id: string }, domain: string, sender: string): Promise<void> {
  await postInbound({ recipient: `hello@${domain}`, from: `X <${sender}>` })
  await postMailEvents([{ type: 'bounced', recipient: sender, detail: '550 mailbox gone', orgId: org.id }])
}

describe('suppression admin', () => {
  it('lists the kernel\'s bounces with the address, not clearable here', async () => {
    const { org, domain, opts } = await createInboxOrgWith(sql)
    const sender = uniqueSender('bounce')
    await triggerBounce(org, domain, sender)

    const list = await $fetch<{ items: Item[] }>('/api/inbox/suppressions', opts)
    const row = list.items.find(i => i.value === sender)
    expect(row).toMatchObject({ reason: 'hard_bounce', detail: '550 mailbox gone', clearable: false })
  })

  it('shows a complaint over an earlier bounce', async () => {
    const { org, domain, opts } = await createInboxOrgWith(sql)
    const sender = uniqueSender('upgrade')
    await triggerBounce(org, domain, sender)
    await postMailEvents([{ type: 'complained', recipient: sender, orgId: org.id }])

    const list = await $fetch<{ items: Item[] }>('/api/inbox/suppressions', opts)
    expect(list.items.find(i => i.value === sender)!.reason).toBe('complaint')
  })

  it('lets an admin clear a CRM suppression', async () => {
    const { org, domain, opts } = await createInboxOrgWith(sql)
    const sender = uniqueSender('clear')
    await postInbound({ recipient: `hello@${domain}`, from: `X <${sender}>` })
    const [channel] = await sql<{ id: string }[]>`SELECT id FROM crm_channels WHERE org_id = ${org.id} AND value = ${sender}`
    await sql`INSERT INTO crm_channel_suppressions (org_id, channel_id, reason) VALUES (${org.id}, ${channel!.id}, 'manual')`

    const list = await $fetch<{ items: Item[] }>('/api/inbox/suppressions', opts)
    const row = list.items.find(i => i.value === sender)!
    expect(row.clearable).toBe(true)
    await $fetch(`/api/inbox/suppressions/${row.channelId}/clear`, { method: 'POST', ...opts })

    const after = await $fetch<{ items: Item[] }>('/api/inbox/suppressions', opts)
    expect(after.items.find(i => i.value === sender)).toBeUndefined()
  })
})
