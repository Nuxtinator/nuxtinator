// permFor: a code-declared type that names a permissionPrefix gets its own
// slugs; every other type key — admin-created customs included — shares the
// generic records.entries set.
import { describe, it, expect, afterEach } from 'vitest'
import { permFor } from '../../server/utils/records-perms'
import { __resetRecordsRegistriesForTests, registerRecordType } from '../../server/utils/records-registry'

afterEach(() => { __resetRecordsRegistriesForTests() })

describe('permFor', () => {
  it('resolves a type with a permission prefix to its own slugs', () => {
    registerRecordType({
      key: 'contacts',
      label: 'Contacts',
      labelSingular: 'Contact',
      permissionPrefix: 'crm.contacts',
      fields: { name: { kind: 'text', label: 'Name', column: 'name' } }
    })
    expect(permFor('contacts', 'read')).toBe('crm.contacts.read')
    expect(permFor('contacts', 'create')).toBe('crm.contacts.create')
    expect(permFor('contacts', 'update')).toBe('crm.contacts.update')
    expect(permFor('contacts', 'delete')).toBe('crm.contacts.delete')
    expect(permFor('contacts', 'share')).toBe('crm.contacts.share')
    expect(permFor('contacts', 'view_all')).toBe('crm.contacts.view_all')
  })

  it('resolves every other type key to the generic records.entries slugs', () => {
    expect(permFor('projects', 'read')).toBe('records.entries.read')
    expect(permFor('leads', 'view_all')).toBe('records.entries.view_all')
    expect(permFor('task', 'delete')).toBe('records.entries.delete')
  })
})
