// Account emails match case-insensitively, so every lookup by an email column
// goes through `lower(...)` (see server/utils/email-address.ts).
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const LAYERS_DIR = resolve(__dirname, '../../..')
const SKIP_DIRS = new Set(['node_modules', '.nuxt', '.output', 'tests'])
const EXACT_EMAIL_MATCH = /\.where\(\s*'(?:\w+\.)?(?:email|pending_email)'\s*,\s*'(?:=|!=|<>|in|not in)'/

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : sourceFiles(join(dir, entry.name))
    return /\.(ts|vue)$/.test(entry.name) ? [join(dir, entry.name)] : []
  })
}

describe('email lookups', () => {
  it('no layer compares an email column exactly', () => {
    const offenders = sourceFiles(LAYERS_DIR).flatMap(file =>
      readFileSync(file, 'utf8').split('\n')
        .map((line, i) => EXACT_EMAIL_MATCH.test(line) ? `${relative(LAYERS_DIR, file)}:${i + 1}` : null)
        .filter((hit): hit is string => hit !== null)
    )
    expect(offenders).toEqual([])
  })
})
