// Definition validation on create/patch: the kanban grouping XOR, key
// existence against the type's real fields, groupable-kind gating, and
// table views refusing grouping.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupWorkflowsTestData,
  createWorkflowsOrgWith,
  withOrgHeader
} from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupWorkflowsTestData(sql) })

type Opts = ReturnType<typeof withOrgHeader>

async function attempt(opts: Opts, body: Record<string, unknown>): Promise<unknown> {
  return $fetch('/api/workflows/views', {
    method: 'POST',
    body: {
      name: 'test-workflows def',
      recordTypeKey: 'contacts',
      viewType: 'kanban',
      ...body
    },
    ...opts
  })
}

describe('definition validation', () => {
  it('kanban needs exactly one of groupField / columns', async () => {
    const { org, auth } = await createWorkflowsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    await expect(attempt(opts, { definition: {} })).rejects.toMatchObject({ statusCode: 400 })
    await expect(attempt(opts, {
      definition: { groupField: 'status', columns: [{ key: 'a', label: 'A' }] }
    })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects unknown and non-groupable grouping fields', async () => {
    const { org, auth } = await createWorkflowsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    await expect(attempt(opts, { definition: { groupField: 'nope' } }))
      .rejects.toMatchObject({ statusCode: 400 })
    // nickname is a text field — no stable column set.
    await expect(attempt(opts, { definition: { groupField: 'nickname' } }))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects grouping on table views and unknown card/filter/sort keys', async () => {
    const { org, auth } = await createWorkflowsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    await expect(attempt(opts, { viewType: 'table', definition: { groupField: 'status' } }))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect(attempt(opts, { definition: { groupField: 'status', cardFields: ['nope'] } }))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect(attempt(opts, { definition: { groupField: 'status', filters: { nope: 'x' } } }))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect(attempt(opts, { definition: { groupField: 'status', sort: { field: 'nope', dir: 'asc' } } }))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('round-trips a full valid definition', async () => {
    const { org, auth } = await createWorkflowsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    const view = await attempt(opts, {
      definition: {
        groupField: 'languages',
        cardFields: ['status', 'updated_at'],
        filters: { status: 'active' },
        sort: { field: 'name', dir: 'asc' }
      }
    }) as { id: string, definition: Record<string, unknown> }

    expect(view.definition).toMatchObject({
      groupField: 'languages',
      cardFields: ['status', 'updated_at'],
      filters: { status: 'active' },
      sort: { field: 'name', dir: 'asc' }
    })

    // Custom columns round-trip too, with duplicate keys refused.
    const custom = await attempt(opts, {
      definition: { columns: [{ key: 'todo', label: 'To do' }, { key: 'done', label: 'Done' }] }
    }) as { definition: { columns: Array<{ key: string }> } }
    expect(custom.definition.columns.map(c => c.key)).toEqual(['todo', 'done'])

    await expect(attempt(opts, {
      definition: { columns: [{ key: 'a', label: 'A' }, { key: 'a', label: 'A again' }] }
    })).rejects.toMatchObject({ statusCode: 400 })
  })
})
