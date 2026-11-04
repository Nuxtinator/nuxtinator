/**
 * GET /api/v1/feedback/me — current widget user identity.
 *
 * Bearer-aware (via getWidgetAuthUser) so it works both first-party (host
 * `auth-token` cookie) and cross-origin (the bearer token issued by
 * /api/v1/feedback/token). The widget uses this in place of /api/auth/me,
 * which is cookie-only and so can't authenticate a cross-origin embed. With
 * `?project_id=`, a bearer token issued for another project is a 401, which
 * tells the widget to sign in again for its own project.
 */
import { getQuery } from 'h3'
import { requireWidgetAuthUser } from '../../../../utils/widget-auth'

export default defineEventHandler((event) => {
  const query = getQuery(event)
  const projectId = typeof query.project_id === 'string' && query.project_id ? query.project_id : null
  const u = requireWidgetAuthUser(event, projectId)
  return { user: { id: u.userId, email: u.email, display_name: u.display_name } }
})
