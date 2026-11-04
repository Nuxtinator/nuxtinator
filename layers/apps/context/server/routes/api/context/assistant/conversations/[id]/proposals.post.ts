// POST /api/context/assistant/conversations/:id/proposals
// Decide one proposed section update: `{ message_id, index, action }` where
// action is 'apply' or 'reject'. Apply writes the section through the shared
// section writer (same validation, versioning, and limits as the PUT
// endpoint) and records the decision on the message.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { logUpdate } from '#core/server/utils/activity-logger'
import {
  getOwnedConversationOr404,
  getMessageInConversation,
  setProposalStatus
} from '../../../../../../utils/assistant-conversations'
import { getPortfolioBySlugOr404 } from '../../../../../../utils/portfolio-helpers'
import { saveSectionContent } from '../../../../../../utils/section-helpers'

const Body = z.object({
  message_id: z.string().uuid(),
  index: z.number().int().min(0),
  action: z.enum(['apply', 'reject'])
})

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.assistant.chat', async (tx, ctx) => {
    const id = getRouterParam(event, 'id') ?? ''
    const conversation = await getOwnedConversationOr404(tx, id, ctx.userId)

    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const { message_id: messageId, index, action } = parsed.data

    const message = await getMessageInConversation(tx, conversation.id, messageId)
    const proposal = message?.proposals[index]
    if (!message || !proposal) {
      throw createError({ statusCode: 404, statusMessage: 'Proposal not found.' })
    }
    if (proposal.status !== 'pending') {
      throw createError({ statusCode: 409, statusMessage: `Proposal already ${proposal.status}.` })
    }

    if (action === 'reject') {
      const proposals = await setProposalStatus(tx, message, index, 'rejected')
      return { proposal: proposals[index] }
    }

    if (!ctx.perms.has('context.write') || !ctx.perms.has('context.assistant.apply')) {
      throw createError({ statusCode: 403, statusMessage: 'Permission required: context.assistant.apply' })
    }
    const portfolio = await getPortfolioBySlugOr404(tx, proposal.portfolio_slug)
    const { section, versionId } = await saveSectionContent(
      tx, portfolio.id, proposal.section_key, proposal.proposed_content, ctx.userId, { source: 'assistant' }
    )
    logUpdate('context_sections', section.id, ctx.userId, {
      source: 'assistant',
      portfolio_id: portfolio.id,
      key: proposal.section_key,
      version_id: versionId
    })
    const proposals = await setProposalStatus(tx, message, index, 'applied')
    return { proposal: proposals[index], version_id: versionId }
  })
})
