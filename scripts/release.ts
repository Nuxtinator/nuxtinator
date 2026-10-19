// Cut a release for one layer: bump its package.json version, commit, and tag.
//
//   bun run release <layer-id> <version>            e.g. bun run release feedback 1.4.0
//   bun run release <layer-id> <patch|minor|major>  bump from the current version
//   bun run release <layer-id> <...> --push         also push the commit + tag
//
// The `version` field in the layer's package.json is the source of truth for the
// number; the tag (@nuxtinator/<id>@<version>) is derived here in the same step
// so the two can't drift. Releasing is deliberate and per-layer — `master` can run
// ahead of the last released tag, and a release only reaches consumers once pushed.

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import semver from 'semver'

const [, , id, bumpArg] = process.argv
if (!id || !bumpArg) {
  console.error('Usage: bun run release <layer-id> <version | patch|minor|major> [--push]')
  process.exit(1)
}

// layer id -> package.json path, derived from the root workspaces list (layers/* only).
const root = JSON.parse(readFileSync('package.json', 'utf8'))
const paths: string[] = (root.workspaces ?? []).filter((w: string) => w.startsWith('layers/'))
const path = paths.find(p => p.split('/').pop() === id)
if (!path) {
  console.error(`Unknown layer "${id}". Known: ${paths.map(p => p.split('/').pop()).join(', ')}`)
  process.exit(1)
}

const pkgPath = `${path}/package.json`
const pkgText = readFileSync(pkgPath, 'utf8')
const pkg = JSON.parse(pkgText)
const current: string = pkg.version ?? '0.0.0'

const next = (['patch', 'minor', 'major'] as const).includes(bumpArg as never)
  ? semver.inc(current, bumpArg as semver.ReleaseType)
  : semver.valid(bumpArg)
if (!next) {
  console.error(`"${bumpArg}" is not a valid version or bump type.`)
  process.exit(1)
}
if (!semver.gt(next, current)) {
  console.error(`${next} is not greater than the current ${current} (${id}).`)
  process.exit(1)
}

const tag = `${pkg.name}@${next}`

// Every monorepo layer named in `nuxtinator.requires` must already have a pushed
// release satisfying its range, or consumers resolving this tag can't pair it
// with anything that builds.
const requires: Record<string, string> = pkg.nuxtinator?.requires ?? {}
const monorepoNames = new Set(paths.map(p => JSON.parse(readFileSync(`${p}/package.json`, 'utf8')).name))
const remoteTags = Object.keys(requires).length
  ? execSync('git ls-remote --tags --refs origin', { encoding: 'utf8' }).split('\n').map(l => l.split('refs/tags/')[1]).filter(Boolean)
  : []
const unreleased: string[] = []
for (const [dep, range] of Object.entries(requires)) {
  if (!semver.validRange(range)) {
    console.error(`${id} requires ${dep} "${range}", which is not a valid semver range.`)
    process.exit(1)
  }
  if (!monorepoNames.has(dep)) continue
  const released = remoteTags.filter(t => t.startsWith(`${dep}@`)).map(t => t.slice(dep.length + 1))
  if (!released.some(v => semver.valid(v) && semver.satisfies(v, range, { includePrerelease: true }))) {
    unreleased.push(`${dep} ${range}`)
  }
}
if (unreleased.length) {
  console.error(`${id} requires layers with no pushed release in range — release them first:\n  ${unreleased.join('\n  ')}`)
  process.exit(1)
}

// Targeted version-field edit so the file's formatting/key-order is preserved.
const updated = /"version":\s*"[^"]*"/.test(pkgText)
  ? pkgText.replace(/"version":\s*"[^"]*"/, `"version": "${next}"`)
  : pkgText.replace(/("name":\s*"[^"]*",)/, `$1\n  "version": "${next}",`)
writeFileSync(pkgPath, updated)

// Commit ONLY the version bump (path-scoped commit ignores anything else staged).
execSync(`git commit ${JSON.stringify(pkgPath)} -m ${JSON.stringify(`${id} ${next}`)}`, { stdio: 'inherit' })
// Annotated, not lightweight — `git push --follow-tags` only pushes annotated tags.
execSync(`git tag -a ${JSON.stringify(tag)} -m ${JSON.stringify(tag)}`, { stdio: 'inherit' })

if (process.argv.includes('--push')) {
  execSync('git push --follow-tags', { stdio: 'inherit' })
  console.log(`\nReleased ${tag}.`)
} else {
  console.log(`\nTagged ${tag} locally. Push it with:\n  git push --follow-tags`)
}
