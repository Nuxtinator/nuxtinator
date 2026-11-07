// In-process crm registries — the code-owned side of the channel-type and
// consent-purpose catalogs. Same idiom as core's permissions registry:
// module-level maps fed by each layer's Nitro plugin at boot; registering the
// same key again overwrites, so repeated plugin runs stay idempotent. Record
// types themselves register with the records kernel (`registerRecordType`
// from #records/server).

import type { ChannelValueFormat } from '../database/schema.d'

// --- Channel types ---------------------------------------------------------

export interface CrmChannelTypeEntry {
  typeKey: string
  label: string
  icon?: string
  valueFormat: ChannelValueFormat
}

const _channelTypes = new Map<string, CrmChannelTypeEntry>()

export function registerCrmChannelType(entry: CrmChannelTypeEntry): void {
  _channelTypes.set(entry.typeKey, entry)
}

export function getRegisteredChannelTypes(): CrmChannelTypeEntry[] {
  return [..._channelTypes.values()]
}

// --- Consent purposes ------------------------------------------------------

export interface CrmConsentPurposeMeta {
  title: string
  description?: string
}

const _consentPurposes = new Map<string, CrmConsentPurposeMeta>()

export function registerCrmConsentPurpose(key: string, meta: CrmConsentPurposeMeta): void {
  _consentPurposes.set(key, meta)
}

export function getRegisteredConsentPurposes(): Array<{ key: string } & CrmConsentPurposeMeta> {
  return [..._consentPurposes.entries()].map(([key, meta]) => ({ key, ...meta }))
}

export function __resetCrmRegistriesForTests(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__resetCrmRegistriesForTests is not callable in production')
  }
  _channelTypes.clear()
  _consentPurposes.clear()
}
