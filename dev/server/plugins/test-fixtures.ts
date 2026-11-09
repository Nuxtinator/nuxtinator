// Test-only fixtures for layer test suites, registered when the suite's
// server sets NUXTINATOR_TEST_FIXTURES=1: a `test-items` ref source over item
// records (visible to whoever can see the item), a `test_item` ref field on
// tasks, and a built-in view of the tasks pointing at one item — what a
// producer layer such as meetings does, without loading one.
import { registerRecordFieldExtension, registerRecordsRefSource, visibleRecordIds } from '#records/server'
import { registerBuiltInView } from '#views/server'

export default defineNitroPlugin(() => {
  if (process.env.NUXTINATOR_TEST_FIXTURES !== '1') return

  registerRecordsRefSource({
    source: 'test-items',
    label: 'Item',
    resolve: async (tx, ctx, ids) => {
      const rows = await tx
        .selectFrom('records_entries')
        .select(['id', 'name'])
        .where('id', 'in', ids)
        .where('record_type', '=', 'item')
        .execute()
      const visible = await visibleRecordIds(tx, ctx, rows.map(r => r.id))
      return new Map(rows.map(r => [r.id, visible.has(r.id) ? { label: r.name, url: `/records/item/${r.id}` } : 'hidden' as const]))
    },
    search: async (tx, ctx, q, limit) => {
      let query = tx
        .selectFrom('records_entries')
        .select(['id', 'name'])
        .where('record_type', '=', 'item')
      if (q) query = query.where('name', 'ilike', `%${q}%`)
      const rows = await query.orderBy('name').limit(200).execute()
      const visible = await visibleRecordIds(tx, ctx, rows.map(r => r.id))
      return rows.filter(r => visible.has(r.id)).slice(0, limit).map(r => ({ id: r.id, label: r.name }))
    }
  })

  registerRecordFieldExtension('task', 'test-fixtures', {
    test_item: { kind: 'ref', source: 'test-items', label: 'Test item' }
  })

  registerBuiltInView({
    key: 'test-item-tasks',
    name: 'Item tasks',
    recordTypeKey: 'task',
    filter: param => ({ match: 'all', rules: [{ field: 'test_item', op: 'is', value: param! }] }),
    param: {
      resolve: async (tx, ctx, param) => {
        if (!/^[0-9a-f-]{36}$/i.test(param)) return null
        const row = await tx.selectFrom('records_entries').select(['id', 'name']).where('id', '=', param).where('record_type', '=', 'item').executeTakeFirst()
        if (!row || !(await visibleRecordIds(tx, ctx, [row.id])).has(row.id)) return null
        return { name: `Tasks · ${row.name}` }
      }
    },
    tabs: [{ key: 'list', name: 'List', layout: 'list', definition: {} }]
  })
})
