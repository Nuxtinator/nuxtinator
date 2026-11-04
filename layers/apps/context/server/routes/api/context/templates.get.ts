// GET /api/context/templates — registered portfolio templates and their sections.
import { withOrgPermission } from '#tenant/server'
import { DEFAULT_PORTFOLIO_TEMPLATE_ID, getRegisteredPortfolioTemplates } from '../../../utils/portfolio-template-registry'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.read', async () => {
    const templates = getRegisteredPortfolioTemplates()
      .sort((a, b) => Number(b.id === DEFAULT_PORTFOLIO_TEMPLATE_ID) - Number(a.id === DEFAULT_PORTFOLIO_TEMPLATE_ID))
    return {
      templates: templates.map(t => ({
        id: t.id,
        label: t.label,
        description: t.description ?? null,
        sections: [...t.sections]
          .sort((a, b) => a.order - b.order)
          .map(s => ({ key: s.key, title: s.title, description: s.description }))
      }))
    }
  })
})
