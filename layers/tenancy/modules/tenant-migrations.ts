import { defineNuxtModule } from '@nuxt/kit'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

// Discovers per-app tenancy migrations from every layer.
//
// Convention: app layers ship plain (non-tenancy) migrations in their
// `migrations/` folder, plus *optional* per-app tenancy migrations under the
// same folder named `<appId>_T<NNN>_<description>.ts` (the `T` is the
// "tenancy-only" marker). When the tenancy layer is loaded, this module
// surfaces those files to the migrator alongside the layer's own migrations.
// In single mode (no tenancy layer) they're left on disk and unused.
//
// The host's `modules/migrations.ts` collects regular `<NNN>_*.ts` files from
// every layer. This module appends tenancy `*_T<NNN>_*.ts` files on top.
export default defineNuxtModule({
  meta: { name: 'tenancy/migrations' },
  setup(_, nuxt) {
    const tenancyMigrationPaths: string[] = []

    for (const layer of nuxt.options._layers) {
      const dir = path.join(layer.cwd, 'migrations')
      if (!existsSync(dir)) continue
      // Tenancy migrations from app layers (e.g. mail_T010_enable_tenancy.ts).
      const tFiles = readdirSync(dir).filter(f => /_T\d+_/.test(f))
      if (tFiles.length > 0) tenancyMigrationPaths.push(dir)
    }

    // The migrations Nitro plugin reads `tenancyMigrationPaths` and includes
    // those `*_T<NNN>_*.ts` files. The same `_T_` filter ensures only
    // tenancy-only migrations from each layer's folder are picked up.
    nuxt.options.runtimeConfig.tenancyMigrationPaths = tenancyMigrationPaths
  }
})
