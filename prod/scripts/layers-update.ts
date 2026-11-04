// Check each layer's source for newer versions and (re)write layers.lock.json.
//
//   bun run layers:check    dry run — report what would change
//   bun run layers:update   apply — write the lock (this is `layers:check --write`)
//
// The scheduled GitHub Action runs `layers:update` and opens a PR with the
// resulting lockfile change. In-range minor/patch updates move the lock with the
// range untouched — those are the auto-mergeable PRs. A newer MAJOR outside the
// range is reported but NOT applied: adopting it is a deliberate range bump in
// layers.ts (a change held for a human).
//
// Versions also respect each layer's `nuxtinator.requires`: a layer whose newest
// version needs something the others can't provide is held at an older version
// that works, and reported. If no compatible set exists, the conflicts are
// printed, nothing is written, and the script exits non-zero.

import { LAYERS } from '../layers'
import { readLock, resolveAll, writeLock } from './lib/lock'

const write = process.argv.includes('--write')
const token = process.env.LAYER_SOURCE_TOKEN

const before = readLock() ?? {}
const { lock, beyond, held, conflicts } = await resolveAll(LAYERS, token)

if (conflicts.length) {
  console.error(`Layer requirements can't be met:\n${conflicts.map(c => `  ${c}`).join('\n')}`)
  console.error('\nNo lock written. Adjust the versions in layers.ts, or release the layers these need.')
  process.exit(1)
}

const changed = Object.keys(lock)
  .filter(id => before[id]?.ref !== lock[id].ref)
  .map(id => `  ${id}: ${before[id]?.ref ?? '(none)'} -> ${lock[id].ref}`)

console.log(changed.length ? `Updates in range:\n${changed.join('\n')}` : 'All layers up to date within their declared ranges.')

const majors = Object.entries(beyond)
if (majors.length) {
  console.log('\nMajor updates available (held — widen the range in layers.ts to adopt):')
  majors.forEach(([id, v]) => console.log(`  ${id}: ${v} is newer than the pinned range`))
}

const heldBack = Object.entries(held)
if (heldBack.length) {
  console.log('\nHeld back by layer requirements:')
  heldBack.forEach(([id, why]) => console.log(`  ${id}: ${why}`))
}

if (write) {
  writeLock(lock)
  console.log(`\nWrote layers.lock.json (${changed.length} change(s)).`)
} else if (changed.length) {
  console.log('\n(dry run — run `bun run layers:update` to write the lock)')
}
