// GET /api/crm/schema/types/:type/fields
// Merged field definitions for one record type — everything the client needs
// to render list columns and detail sections. Returns
// { sections: Record<key, { label, order? }>, statusField, closedReasonField
// (null unless the type can be closed with a reason), fields: [{ key,
//   kind, label, icon, section, required, hidden, order, options, custom,
//   orphan, channelType, target, multiple, column }] } sorted by order. `column` and
// `statusField` carry the promoted-column flags so clients never infer them
// from key conventions. Hidden and stale (orphan) fields only appear for
// schema managers. Permission: crm.access.

import { withOrgPermission } from '#tenant/server'
import { closingRulesOf, getRecordTypeFields, requireRecordType } from '#crm/server'

export default defineEventHandler(async (event) => {
  const typeKey = getRouterParam(event, 'type')!
  return await withOrgPermission(event, { appId: 'crm' }, 'crm.access', async (tx, ctx) => {
    const type = await requireRecordType(tx, typeKey)
    const canManage = ctx.perms.has('crm.schema.manage')
    const all = await getRecordTypeFields(tx, typeKey)
    const fields = all
      .filter(f => canManage || (!f.hidden && !f.orphan))
      .map(f => ({
        key: f.key,
        kind: f.kind,
        label: f.label,
        icon: f.icon ?? null,
        section: f.section ?? null,
        required: f.required,
        hidden: f.hidden,
        order: f.order,
        options: f.options ?? null,
        custom: f.custom,
        orphan: f.orphan,
        channelType: f.channelType ?? null,
        target: f.target ?? null,
        multiple: f.multiple ?? false,
        column: f.column ?? null
      }))
    return {
      sections: type.sections,
      statusField: type.statusField ?? null,
      closedReasonField: closingRulesOf(type, all).reasonKey,
      fields
    }
  })
})
