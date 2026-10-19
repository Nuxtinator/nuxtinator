import { describe, it, expect } from 'vitest'
import { validateSlug } from '../../app/utils/slug'

describe('validateSlug', () => {
  it('accepts a well-formed slug', () => {
    expect(validateSlug('acme-prayer')).toBeNull()
  })

  it('refuses reserved mail role names', () => {
    for (const slug of ['postmaster', 'contact', 'bounce', 'no-reply']) {
      expect(validateSlug(slug)).toMatch(/reserved/)
    }
  })
})
