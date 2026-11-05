// GET /api/context/portfolios/:slug/export — full-portfolio zip download.
import archiver from 'archiver'
import { withOrgPermission } from '#tenant/server'
import { getContextTeamScope, getPortfolioBySlugOr404 } from '../../../../../utils/portfolio-helpers'
import { buildPortfolioExport } from '../../../../../utils/export'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.read', async (tx, ctx) => {
    const slug = getRouterParam(event, 'slug') ?? ''
    const p = await getPortfolioBySlugOr404(tx, slug, await getContextTeamScope(event, tx, ctx))
    const { files, readme, safeFilename } = await buildPortfolioExport(tx, p)

    setHeader(event, 'Content-Type', 'application/zip')
    setHeader(event, 'Content-Disposition', `attachment; filename="${safeFilename}.zip"`)

    const archive = archiver('zip', { zlib: { level: 9 } })
    const buffers: Buffer[] = []
    archive.on('data', (chunk: Buffer) => buffers.push(chunk))
    const done = new Promise<Buffer>((resolve, reject) => {
      archive.on('end', () => resolve(Buffer.concat(buffers)))
      archive.on('error', reject)
    })
    for (const f of files) {
      archive.append(f.content, { name: f.filename })
    }
    archive.append(readme, { name: 'README.md' })
    await archive.finalize()
    const buf = await done
    return buf
  })
})
