// layers.lock.json — the resolved state of each layer.
//
// layers.ts declares *policy* (a range / 'latest' / a pin). This lock records
// the concrete tag each policy resolved to at the last `layers:update`. The
// build (sync-layers) reads the lock and fetches exactly those refs — it never
// re-resolves ranges — so deploys are reproducible (like `npm ci`). The lock is
// committed; a change to it is what makes Railpack bust its build cache and
// re-fetch on the next deploy.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import semver from 'semver'
import {
  type LayerPackage,
  type LayerSpec,
  availableBeyondRange,
  candidateRefs,
  fetchLayerPackage,
  listTags,
  repoOf,
  sourceOf,
  tagPrefixOf,
  versionOf
} from './resolve'

export const LOCK_FILE = 'layers.lock.json'

export type LockEntry = {
  pkg: string // package name (also what the in-app notifier displays)
  version: string // the declared policy (range / pin / 'latest' / ref) at resolve time
  ref: string // the concrete git ref the policy resolved to
  source: string // github:<repo>/<subdir> (ref-less) for readability
  tagPrefix: string // the tag namespace, so the notifier can list this layer's versions
}
export type Lock = Record<string, LockEntry>

export function readLock(): Lock | null {
  return existsSync(LOCK_FILE) ? JSON.parse(readFileSync(LOCK_FILE, 'utf8')) : null
}

export function writeLock(lock: Lock): void {
  writeFileSync(LOCK_FILE, JSON.stringify(lock, null, 2) + '\n')
}

// Resolve every layer's declared policy against its source tags and build a
// fresh lock. Tags are listed once per unique repo. A global NUXTINATOR_REF env
// var (back-compat) overrides resolution for every layer at once.
//
// Each layer starts at the newest version its policy allows. A layer whose
// package.json `nuxtinator.requires` isn't met by the versions picked for the
// others steps down to its newest older version that is, repeating until the set
// settles. Layers only ever move down, so this terminates. A layer with no
// satisfying version left, or one requiring a layer layers.ts doesn't include,
// is a conflict: the caller reports it and must not write the lock.
export async function resolveAll(layers: readonly LayerSpec[], token?: string): Promise<{
  lock: Lock
  beyond: Record<string, string> // id -> newest version held outside its range
  held: Record<string, string> // id -> why it sits below the newest version its range allows
  conflicts: string[]
}> {
  const globalRef = process.env.NUXTINATOR_REF
  const tagsByRepo = new Map<string, string[]>()
  const tagsFor = (repo: string) => {
    if (!tagsByRepo.has(repo)) tagsByRepo.set(repo, listTags(repo, token))
    return tagsByRepo.get(repo)!
  }

  const candidates = new Map(layers.map(l => [l.id, globalRef ? [globalRef] : candidateRefs(l, tagsFor(repoOf(l)))]))
  const pick = new Map(layers.map(l => [l.id, 0]))
  const packages = new Map<string, Promise<LayerPackage>>()
  const packageAt = (l: LayerSpec, i: number) => {
    const ref = candidates.get(l.id)![i]
    const key = `${l.id}#${ref}`
    if (!packages.has(key)) packages.set(key, fetchLayerPackage(l, ref, token))
    return packages.get(key)!
  }
  const current = (l: LayerSpec) => packageAt(l, pick.get(l.id)!)

  // Requirements of `l` at its current pick that the other current picks don't meet.
  const unmetOf = async (l: LayerSpec) => {
    const chosen = new Map<string, string>()
    for (const other of layers) chosen.set(other.pkg, (await current(other)).version)
    return Object.entries((await current(l)).requires)
      .filter(([pkg, range]) => !chosen.has(pkg) || !semver.satisfies(chosen.get(pkg)!, range, { includePrerelease: true }))
      .map(([pkg, range]) => ({ pkg, range, chosen: chosen.get(pkg) ?? null }))
  }
  const describe = (u: { pkg: string, range: string, chosen: string | null }) =>
    `needs ${u.pkg} ${u.range} (${u.chosen === null ? 'not in layers.ts' : `resolves to ${u.chosen}`})`

  await Promise.all(layers.map(current))

  const newestReason = new Map<string, string>()
  for (let changed = true; changed;) {
    changed = false
    for (const l of layers) {
      const unmet = await unmetOf(l)
      const i = pick.get(l.id)!
      if (!unmet.length || unmet.some(u => u.chosen === null) || i + 1 >= candidates.get(l.id)!.length) continue
      if (i === 0) newestReason.set(l.id, `${(await current(l)).version} ${unmet.map(describe).join(', ')}`)
      pick.set(l.id, i + 1)
      changed = true
    }
  }

  const lock: Lock = {}
  const beyond: Record<string, string> = {}
  const held: Record<string, string> = {}
  const conflicts: string[] = []
  for (const l of layers) {
    const { version } = await current(l)
    const unmet = await unmetOf(l)
    if (unmet.length) conflicts.push(`${l.id} ${version} ${unmet.map(describe).join(', ')}`)
    else if (newestReason.has(l.id)) held[l.id] = `held at ${version}: ${newestReason.get(l.id)}`

    const ref = candidates.get(l.id)![pick.get(l.id)!]
    lock[l.id] = { pkg: l.pkg, version: globalRef ?? versionOf(l), ref, source: sourceOf(l), tagPrefix: tagPrefixOf(l) }
    if (!globalRef) {
      const newer = availableBeyondRange(l, tagsFor(repoOf(l)))
      if (newer) beyond[l.id] = newer
    }
  }
  return { lock, beyond, held, conflicts }
}
