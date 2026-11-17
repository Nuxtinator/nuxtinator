// Pure unit tests over which field values count as empty — no DB, no server.
import { describe, it, expect } from 'vitest'
import { recordsFieldIsEmpty } from '../../app/utils/field-kinds'

describe('recordsFieldIsEmpty', () => {
  it('treats no value, blank text and an empty list as empty', () => {
    for (const value of [null, undefined, '', '   ', []]) {
      expect(recordsFieldIsEmpty(value)).toBe(true)
    }
  })

  it('treats false, zero and filled values as values', () => {
    for (const value of [false, true, 0, 'a', ['a'], { id: 'x' }]) {
      expect(recordsFieldIsEmpty(value)).toBe(false)
    }
  })
})
