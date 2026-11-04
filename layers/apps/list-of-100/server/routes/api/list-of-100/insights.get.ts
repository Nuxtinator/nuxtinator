// GET /api/list-of-100/insights?window=30d|all
// Returns daily counts of MARK_CONTACTED + MARK_PRAYED events for the caller.
// Used by the Insights tab to render the per-day rhythm chart.

import { sql } from 'kysely'
import { withUserPermission } from '#core/server/utils/personal-apps'

interface DailyRow {
  day: string
  event_type: 'MARK_CONTACTED' | 'MARK_PRAYED'
  count: string
}

export default defineEventHandler(async (event) => {
  return await withUserPermission(event, { appId: 'list-of-100' }, 'list-of-100.read', async (tx, ctx) => {
    const q = getQuery(event)
    const window = q.window === 'all' ? 'all' : '30d'

    let query = tx
      .selectFrom('activity_logs')
      .select([
        sql<string>`to_char(date_trunc('day', timestamp), 'YYYY-MM-DD')`.as('day'),
        'event_type',
        sql<string>`count(*)`.as('count')
      ])
      .where('user_id', '=', ctx.userId)
      .where('table_name', '=', 'list_of_100_contacts')
      .where('event_type', 'in', ['MARK_CONTACTED', 'MARK_PRAYED'])
      .groupBy(['day', 'event_type'])
      .orderBy('day', 'asc')

    if (window === '30d') {
      const cutoff = new Date()
      cutoff.setUTCDate(cutoff.getUTCDate() - 29)
      cutoff.setUTCHours(0, 0, 0, 0)
      query = query.where('timestamp', '>=', cutoff)
    }

    const rows = (await query.execute()) as DailyRow[]

    // Pivot into { day, contacted, prayed }. Pad missing days for 30d window
    // so the chart has a continuous x-axis.
    const map = new Map<string, { contacted: number, prayed: number }>()
    for (const r of rows) {
      const cur = map.get(r.day) ?? { contacted: 0, prayed: 0 }
      if (r.event_type === 'MARK_CONTACTED') cur.contacted = Number(r.count)
      else cur.prayed = Number(r.count)
      map.set(r.day, cur)
    }

    let days: string[] = []
    if (window === '30d') {
      const today = new Date()
      today.setUTCHours(0, 0, 0, 0)
      for (let i = 29; i >= 0; i--) {
        const d = new Date(today)
        d.setUTCDate(today.getUTCDate() - i)
        days.push(d.toISOString().slice(0, 10))
      }
    } else {
      days = [...map.keys()].sort()
    }

    const series = days.map(d => ({
      day: d,
      contacted: map.get(d)?.contacted ?? 0,
      prayed: map.get(d)?.prayed ?? 0
    }))

    return { window, series }
  })
})
