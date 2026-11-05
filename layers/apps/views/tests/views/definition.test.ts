// Definition validation on create: a board's grouping XOR, key existence
// against the type's real fields, groupable-kind gating, tables refusing
// grouping, own columns only in hand-picked views, and filter trees checked
// rule by rule.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupViewsTestData,
  createViewsOrgWith,
  withOrgHeader
} from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupViewsTestData(sql) })

type Opts = ReturnType<typeof withOrgHeader>

interface Created {
  id: string
  definition: Record<string, unknown>
  tabs: Array<{ name: string, layout: string, definition: Record<string, unknown> }>
}

async function attempt(
  opts: Opts,
  tab: Record<string, unknown>,
  definition?: Record<string, unknown>
): Promise<Created> {
  return $fetch<Created>('/api/views', {
    method: 'POST',
    body: {
      name: 'test-views def',
      recordTypeKey: 'contacts',
      definition,
      tab: { layout: 'kanban', ...tab }
    },
    ...opts
  })
}

describe('definition validation', () => {
  it('a board needs exactly one of groupField / columns', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    await expect(attempt(opts, { definition: {} })).rejects.toMatchObject({ statusCode: 400 })
    await expect(attempt(opts, {
      definition: { groupField: 'status', columns: [{ key: 'a', label: 'A' }] }
    }, { picked: true })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects unknown and non-groupable grouping fields', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    await expect(attempt(opts, { definition: { groupField: 'nope' } }))
      .rejects.toMatchObject({ statusCode: 400 })
    // nickname is a text field — no stable column set.
    await expect(attempt(opts, { definition: { groupField: 'nickname' } }))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects grouping on tables, own columns outside hand-picked views, and unknown card/sort keys', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    await expect(attempt(opts, { layout: 'table', definition: { groupField: 'status' } }))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect(attempt(opts, { definition: { columns: [{ key: 'a', label: 'A' }] } }))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect(attempt(opts, { layout: 'list', definition: { columns: [{ key: 'a', label: 'A' }] } }, { picked: true }))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect(attempt(opts, { definition: { groupField: 'status', cardFields: ['nope'] } }))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect(attempt(opts, { definition: { groupField: 'status', sort: { field: 'nope', dir: 'asc' } } }))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('checks every filter rule against the type: field, operator for its kind, value shape, depth', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const withFilter = (filter: unknown) => attempt(opts, { definition: { groupField: 'status', filter } })

    await expect(withFilter({ match: 'all', rules: [{ field: 'nope', op: 'is', value: 'x' }] }))
      .rejects.toMatchObject({ statusCode: 400 })
    // A text field has no "is before".
    await expect(withFilter({ match: 'all', rules: [{ field: 'nickname', op: 'before', value: '2026-01-01' }] }))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect(withFilter({ match: 'all', rules: [{ field: 'nickname', op: 'empty', value: 'x' }] }))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect(withFilter({ match: 'all', rules: [{ field: 'status', op: 'any_of', value: [] }] }))
      .rejects.toMatchObject({ statusCode: 400 })
    // Groups nest one level deep.
    await expect(withFilter({
      match: 'all',
      rules: [{ match: 'any', rules: [{ match: 'all', rules: [{ field: 'nickname', op: 'empty' }] }] }]
    })).rejects.toMatchObject({ statusCode: 400 })
    // The view's base filter is checked the same way.
    await expect(attempt(opts, { definition: { groupField: 'status' } }, {
      filter: { match: 'all', rules: [{ field: 'nope', op: 'empty' }] }
    })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('round-trips a full valid definition', async () => {
    const { org, auth } = await createViewsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    const filter = {
      match: 'all',
      rules: [
        { field: 'status', op: 'is', value: 'active' },
        { match: 'any', rules: [{ field: 'nickname', op: 'contains', value: 'jo' }, { field: 'nickname', op: 'empty' }] }
      ]
    }
    const view = await attempt(opts, {
      name: 'Languages',
      definition: {
        groupField: 'languages',
        cardFields: ['status', 'updated_at'],
        filter,
        sort: { field: 'name', dir: 'asc' }
      }
    }, { filter: { match: 'all', rules: [{ field: 'created_at', op: 'after', value: '2020-01-01' }] } })

    expect(view.tabs).toHaveLength(1)
    expect(view.tabs[0]).toMatchObject({
      name: 'Languages',
      layout: 'kanban',
      definition: { groupField: 'languages', cardFields: ['status', 'updated_at'], filter, sort: { field: 'name', dir: 'asc' } }
    })
    expect(view.definition).toEqual({ filter: { match: 'all', rules: [{ field: 'created_at', op: 'after', value: '2020-01-01' }] } })

    // Own columns round-trip in a hand-picked view, with duplicate keys refused.
    const custom = await attempt(opts, {
      definition: { columns: [{ key: 'todo', label: 'To do' }, { key: 'done', label: 'Done' }] }
    }, { picked: true })
    expect(custom.definition).toEqual({ picked: true })
    expect((custom.tabs[0]!.definition.columns as Array<{ key: string }>).map(c => c.key)).toEqual(['todo', 'done'])

    await expect(attempt(opts, {
      definition: { columns: [{ key: 'a', label: 'A' }, { key: 'a', label: 'A again' }] }
    }, { picked: true })).rejects.toMatchObject({ statusCode: 400 })
  })
})
