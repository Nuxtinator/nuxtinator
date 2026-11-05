import { describe, it, expect } from 'vitest'
import { classifyMigration } from '../../server/utils/migration-names'

describe('classifyMigration', () => {
  it('maps each filename class to its phase and key', () => {
    expect(classifyMigration('crm_001_create_records.ts')).toMatchObject({
      phase: 'regular', key: 'crm_001_create_records', tenancyOnly: false
    })
    expect(classifyMigration('crm_T001_enable_tenancy.ts')).toMatchObject({
      phase: 'tenancy', key: 'zzz_crm_T001_enable_tenancy', tenancyOnly: true
    })
    expect(classifyMigration('records_L001_rename_tables.ts')).toMatchObject({
      phase: 'late', key: 'zzzz_records_L001_rename_tables', tenancyOnly: false
    })
    expect(classifyMigration('records_TL001_enable_tenancy.ts')).toMatchObject({
      phase: 'late-tenancy', key: 'zzzz_records_TL001_enable_tenancy', tenancyOnly: true
    })
  })

  it('orders regular < tenancy < late < late tenancy', () => {
    const keys = [
      'records_TL001_enable_tenancy.ts',
      'records_L001_rename_tables.ts',
      'crm_T003_rescope.ts',
      'tenancy_020_last.ts',
      'crm_012_activity.ts'
    ].map(f => classifyMigration(f).key).sort()
    expect(keys).toEqual([
      'crm_012_activity',
      'tenancy_020_last',
      'zzz_crm_T003_rescope',
      'zzzz_records_L001_rename_tables',
      'zzzz_records_TL001_enable_tenancy'
    ])
  })

  it('does not mistake names that merely contain T or L', () => {
    expect(classifyMigration('tools_001_create_anonymizer_replacements.ts').phase).toBe('regular')
    expect(classifyMigration('list-of-100_003_add_labels.ts').phase).toBe('regular')
  })
})
