import { defineNuxtModule, useLogger } from '@nuxt/kit'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import semver from 'semver'

// Surface what this build was assembled from to the runtime, so the in-app
// "Updates" page (server/utils/layer-updates.ts) can report — in one place, no
// build-log digging:
//   - which installed layers have newer releases available (from layers.lock.json)
//   - which loaded layers declare a requirement (`nuxtinator.requires` in their
//     package.json) that the loaded set doesn't meet
//
// Everything is read once at build time (reliable filesystem access); the
// runtime only does the network tag lookup. In the maintainer dev host there's
// no lock, so the updates list is empty and this is effectively inert.
//
// An unmet requirement between layers fetched into the host's _layers/ stops the
// build, since that combination fails later on a missing import anyway. Layers
// loaded from anywhere else (monorepo workspace, NUXTINATOR_<ID>_PATH checkout,
// the host's apps/) only warn: their package.json version lags unreleased code.

export interface LoadedLayer {
  name: string
  version: string
  requires: Record<string, string> // package name -> semver range
}

export interface UnmetRequirement {
  pkg: string
  range: string
  loaded: string | null // null when the required layer isn't loaded at all
}

export function unmetRequirements(layers: LoadedLayer[]): Map<string, UnmetRequirement[]> {
  const loaded = new Map(layers.map(l => [l.name, l.version]))
  const out = new Map<string, UnmetRequirement[]>()
  for (const l of layers) {
    const unmet: UnmetRequirement[] = []
    for (const [pkg, range] of Object.entries(l.requires)) {
      const version = loaded.get(pkg)
      if (version === undefined) unmet.push({ pkg, range, loaded: null })
      else if (!semver.satisfies(version, range, { includePrerelease: true })) unmet.push({ pkg, range, loaded: version })
    }
    if (unmet.length) out.set(l.name, unmet)
  }
  return out
}

export function describeUnmet(layer: LoadedLayer, u: UnmetRequirement): string {
  return `${layer.name} ${layer.version || '(no version)'} needs ${u.pkg} ${u.range} `
    + (u.loaded === null ? '(not loaded)' : `(loaded: ${u.loaded || 'no version'})`)
}

export default defineNuxtModule({
  meta: { name: 'layer-versions' },
  setup(_, nuxt) {
    // What this build is running (resolved versions + sources), from the host lock.
    const lockPath = path.join(nuxt.options.rootDir, 'layers.lock.json')
    let lock: Record<string, unknown> = {}
    if (existsSync(lockPath)) {
      try {
        lock = JSON.parse(readFileSync(lockPath, 'utf8'))
      } catch {
        lock = {} // a malformed lock shouldn't break the build; the page degrades to empty
      }
    }
    nuxt.options.runtimeConfig.layerLock = lock
    // Optional read-only token for listing tags of a PRIVATE layer source.
    nuxt.options.runtimeConfig.layerSourceToken = process.env.LAYER_SOURCE_TOKEN || ''

    const fetchedDir = path.join(nuxt.options.rootDir, '_layers')
    const fetchedRoot = existsSync(fetchedDir) ? realpathSync(fetchedDir) + path.sep : null

    const layers: LoadedLayer[] = []
    const fetched = new Set<string>() // package names loaded from the host's _layers/
    for (const l of nuxt.options._layers) {
      const pkgPath = path.join(l.cwd, 'package.json')
      if (!existsSync(pkgPath)) continue
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        if (!pkg.name) continue
        layers.push({ name: pkg.name, version: pkg.version ?? '', requires: pkg.nuxtinator?.requires ?? {} })
        if (fetchedRoot && realpathSync(l.cwd).startsWith(fetchedRoot)) fetched.add(pkg.name)
      } catch {
        // skip an unreadable package.json
      }
    }

    const unmet = unmetRequirements(layers)
    const fatal: string[] = []
    const logger = useLogger('layer-versions')
    for (const layer of layers) {
      for (const u of unmet.get(layer.name) ?? []) {
        const line = describeUnmet(layer, u)
        if (fetched.has(layer.name) && (u.loaded === null || fetched.has(u.pkg))) fatal.push(line)
        else logger.warn(line)
      }
    }
    if (fatal.length) {
      throw new Error(
        `Incompatible layer versions:\n  ${fatal.join('\n  ')}\n`
        + 'Run `bun run layers:update` to resolve a compatible set, or adjust the versions in layers.ts.'
      )
    }

    // The generated runtimeConfig type snapshots this value with one literal
    // key per loaded layer, so a plain Record doesn't satisfy it; widen
    // through the generated type.
    nuxt.options.runtimeConfig.layerUnmet = Object.fromEntries(unmet) as unknown as typeof nuxt.options.runtimeConfig.layerUnmet
  }
})
