// The records kernel's `channels` storage driver: communication_channel
// fields keep their values as links (crm_contact_channels) to shared address
// identities (crm_channels), through the channel service. Registered by
// register-crm.ts; the kernel routes every read, filter, search and write of
// a channel field here.

import type { RecordsStorageDriver } from '#records/server'
import type { CrmChannelEntry } from '#crm'
import { getChannelType } from './channel-settings'
import { claimChannel, findChannel, linkChannel, unlinkChannel } from './channels'

function badValue(key: string, message: string): never {
  throw createError({ statusCode: 400, statusMessage: `${key}: ${message}` })
}

export const channelStorageDriver: RecordsStorageDriver = {
  storage: 'channels',
  kinds: ['communication_channel'],

  async hydrate(tx, defs, recordIds) {
    const out = new Map<string, Map<string, unknown[]>>()
    if (recordIds.length === 0 || defs.length === 0) return out
    const rows = await tx
      .selectFrom('crm_contact_channels as cc')
      .innerJoin('crm_channels as ch', 'ch.id', 'cc.channel_id')
      .select([
        'cc.id as link_id',
        'cc.record_id as record_id',
        'cc.field_key as field_key',
        'cc.channel_id as channel_id',
        'cc.label as label',
        'cc.is_primary as is_primary',
        'ch.channel_type as channel_type',
        'ch.value as value',
        'ch.verified as verified'
      ])
      .where('cc.record_id', 'in', recordIds)
      .where('cc.field_key', 'in', defs.map(d => d.key))
      .orderBy('cc.sort_order', 'asc')
      .execute()
    for (const row of rows) {
      let byField = out.get(row.record_id)
      if (!byField) {
        byField = new Map()
        out.set(row.record_id, byField)
      }
      const list = byField.get(row.field_key) ?? []
      const entry: CrmChannelEntry = {
        linkId: row.link_id,
        channelId: row.channel_id,
        channelType: row.channel_type,
        value: row.value,
        label: row.label,
        isPrimary: row.is_primary,
        verified: row.verified
      }
      list.push(entry)
      byField.set(row.field_key, list)
    }
    return out
  },

  // Matches both the raw and the normalized address form, so "eq" works with
  // whichever the caller has without a per-type normalization round-trip.
  filter(eb, def, cond, { likePattern, badFilter }) {
    const base = eb.selectFrom('crm_contact_channels as fc')
      .innerJoin('crm_channels as fch', 'fch.id', 'fc.channel_id')
      .select('fc.id')
      .whereRef('fc.record_id', '=', 'records_entries.id')
      .where('fc.field_key', '=', def.key)
    switch (cond.op) {
      case 'eq': {
        if (cond.value === null) return eb.not(eb.exists(base))
        const value = String(cond.value)
        return eb.exists(base.where(ieb => ieb.or([
          ieb('fch.normalized_value', '=', value),
          ieb('fch.value', '=', value)
        ])))
      }
      case 'contains':
        return eb.exists(base.where(ieb => ieb.or([
          ieb('fch.normalized_value', 'ilike', likePattern(cond.value)),
          ieb('fch.value', 'ilike', likePattern(cond.value))
        ])))
      default:
        return badFilter(def.key, `'${cond.op}' is not supported for channel fields`)
    }
  },

  search(eb, pattern) {
    return eb.exists(
      eb.selectFrom('crm_contact_channels as qc')
        .innerJoin('crm_channels as qch', 'qch.id', 'qc.channel_id')
        .select('qc.id')
        .whereRef('qc.record_id', '=', 'records_entries.id')
        .where(ieb => ieb.or([
          ieb('qch.value', 'ilike', pattern),
          ieb('qch.normalized_value', 'ilike', pattern)
        ]))
    )
  },

  validateItem(def, item) {
    // A delete addressed by link id carries no value to validate.
    if (item.delete && item.linkId) return
    if (typeof item.value !== 'string' || item.value.trim() === '') {
      badValue(def.key, 'expected a non-empty string')
    }
    item.value = item.value.trim()
  },

  async apply(tx, ctx, recordId, def, list) {
    const channelType = def.channelType
    if (!channelType) badValue(def.key, 'no channel type configured')
    if (list.force) {
      const links = await tx
        .selectFrom('crm_contact_channels')
        .select('id')
        .where('record_id', '=', recordId)
        .where('field_key', '=', def.key)
        .execute()
      for (const link of links) {
        await unlinkChannel(tx, ctx, recordId, link.id)
      }
    }
    for (const item of list.items) {
      if (item.delete) {
        if (list.force) continue
        let linkId = item.linkId ?? null
        if (!linkId && typeof item.value === 'string') {
          const channel = await findChannel(tx, { channelType, value: item.value })
          if (channel) {
            const link = await tx
              .selectFrom('crm_contact_channels')
              .select('id')
              .where('record_id', '=', recordId)
              .where('field_key', '=', def.key)
              .where('channel_id', '=', channel.id)
              .executeTakeFirst()
            linkId = link?.id ?? null
          }
        }
        // Absent links are treated as already gone (idempotent deletes).
        if (linkId) await unlinkChannel(tx, ctx, recordId, linkId)
      } else {
        const channel = await claimChannel(tx, { channelType, value: String(item.value) })
        await linkChannel(tx, ctx, recordId, def.key, channel.id, {
          label: item.label ?? undefined,
          primary: item.primary
        })
      }
    }
  },

  // A channel field is unusable without its channel type — the widget and
  // the channel routes resolve normalization and dedupe through it.
  async validateFieldDefinition(tx, input) {
    if (!input.channelType) {
      throw createError({ statusCode: 400, statusMessage: 'communication_channel fields require a channelType' })
    }
    const channelType = await getChannelType(tx, input.channelType)
    if (!channelType) {
      throw createError({ statusCode: 400, statusMessage: `Unknown channel type: ${input.channelType}` })
    }
  }
}
