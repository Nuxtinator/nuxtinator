import { downloadTemplate } from 'giget'
import { LAYERS } from '../layers'
import { sourceOf } from './lib/resolve'
import { readLock, resolveAll, writeLock } from './lib/lock'

// Fetch each selected layer into _layers/<id>/.
//
// Resolution (a range / 'latest' -> a concrete tag) is NOT done here — that's
// layers:update's job, and it records the result in layers.lock.json. This step
// just reads the lock and fetches the exact ref it pins, like `npm ci`, so a
// build is reproducible. On a first run with no lock (e.g. a fresh `bun run
// setup`), resolve once and write it so setup still works unattended — with no
// tags in the source yet, every layer resolves to `master`, i.e. today's behaviour.
//
// `--only <id>` fetches just that layer at its pinned ref, e.g. a worker
// image's build fetching `mail` alone (`_layers/` is usually outside the
// Docker build context).

const onlyIdx = process.argv.indexOf('--only')
const only = onlyIdx === -1 ? null : process.argv[onlyIdx + 1]
if (onlyIdx !== -1 && (!only || !LAYERS.some(l => l.id === only))) {
  console.error(`--only needs a layer id from layers.ts (${LAYERS.map(l => l.id).join(', ')})`)
  process.exit(1)
}
const selected = only ? LAYERS.filter(l => l.id === only) : LAYERS

let lock = readLock()
// A single-layer fetch never resolves: it takes exactly the pinned ref or stops.
if (only && !lock?.[only]) {
  console.error(`layers.lock.json has no entry for ${only}. Run 'bun run layers:update' and commit the lock, then fetch again.`)
  process.exit(1)
}
if (!lock) {
  console.log('No layers.lock.json — resolving once from layers.ts…')
  const resolved = await resolveAll(LAYERS, process.env.LAYER_SOURCE_TOKEN)
  if (resolved.conflicts.length) {
    console.error(`Layer requirements can't be met:\n${resolved.conflicts.map(c => `  ${c}`).join('\n')}`)
    process.exit(1)
  }
  lock = resolved.lock
  writeLock(lock)
}

for (const l of selected) {
  const ref = lock[l.id]?.ref ?? 'master'
  const url = `${sourceOf(l)}#${ref}`
  console.log(`Fetching ${l.id} @ ${ref}`)
  await downloadTemplate(url, { dir: `_layers/${l.id}`, forceClean: true })
}

console.log(`\nFetched ${selected.length} layer${selected.length === 1 ? '' : 's'}. Run 'bun install' to hoist their deps via workspaces.`)
