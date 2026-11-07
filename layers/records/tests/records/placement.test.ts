// The records app has no launcher tile or rail entry; record types are managed
// from the org settings shell.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupRecordsTestData,
  createRecordsOrgWith,
  addRecordsMember,
  withOrgHeader
} from '../helpers'

const sql = getHostAdminDb()

afterEach(async () => {
  await cleanupRecordsTestData(sql)
})

describe('records app placement', () => {
  it('is left out of the launcher feed but stays open to the page guard', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    const { apps } = await $fetch<{ apps: { id: string }[] }>(`/api/o/${org.slug}/_apps`, opts)
    expect(apps.some(a => a.id === 'records')).toBe(false)

    const access = await $fetch<{ apps: { id: string, enabled: boolean, permitted: boolean }[] }>(`/api/o/${org.slug}/_app-access`, opts)
    expect(access.apps.find(a => a.id === 'records')).toMatchObject({ enabled: true, permitted: true })
  })

  it('lists a Records org settings section only for schema managers', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const member = await addRecordsMember(sql, org.id, ['member'])

    const sectionsFor = async (a: typeof auth) =>
      (await $fetch<{ sections: { appId: string, to: string }[] }>(`/api/o/${org.slug}/_settings-sections`, withOrgHeader(a, org.slug))).sections

    expect((await sectionsFor(auth)).find(s => s.appId === 'records')?.to).toBe(`/@${org.slug}/settings/records`)
    expect((await sectionsFor(member.auth)).some(s => s.appId === 'records')).toBe(false)
  })
})
