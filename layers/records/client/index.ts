// Entry for the `#records/client` alias — the client-side record types,
// formatters and badge colors other layers' components build on. Lives
// outside app/utils so Nuxt's auto-import scan doesn't see these re-exports
// twice.

export * from '../app/utils/field-kinds'
export * from './filters'
export type { RecordsTypeSummary, RecordsTypeFields } from '../app/composables/useRecordsTypes'
export type { RecordDetail, RecordCapabilities } from '../app/composables/useRecordsRecord'
