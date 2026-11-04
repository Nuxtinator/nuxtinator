// Shared entry for the public widget endpoints: resolve the widget's org from
// its id (BYPASSRLS lookup via the tenant kernel), open a transaction scoped to
// that org, load the widget under RLS, and check the embedding origin. A
// suspended org, or one with helpinator disabled, gets no answers at all.
import type { H3Event } from 'h3'
import { getRouterParam } from 'h3'
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import { withRecordOrgContext } from '#tenant/server'
import { HELPINATOR_UUID_RE, helpinatorGetWidget, type HelpinatorWidgetRow } from './helpinator-widgets'
import { helpinatorAssertOrigin } from './helpinator-guards'

type Tx = Transaction<Database>

export async function helpinatorWithWidget<T>(
  event: H3Event,
  fn: (tx: Tx, widget: HelpinatorWidgetRow, origin: string) => Promise<T>
): Promise<T> {
  const id = getRouterParam(event, 'id') ?? ''
  if (!HELPINATOR_UUID_RE.test(id)) throw createError({ statusCode: 404, statusMessage: 'Widget not found' })
  return await withRecordOrgContext(event, { table: 'helpinator_widgets', id, notFoundMessage: 'Widget not found', appId: 'helpinator' }, async (tx) => {
    const widget = await helpinatorGetWidget(tx, id)
    if (!widget) throw createError({ statusCode: 404, statusMessage: 'Widget not found' })
    const origin = helpinatorAssertOrigin(event, widget)
    return await fn(tx, widget, origin)
  })
}
