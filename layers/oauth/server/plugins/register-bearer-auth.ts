// Lets the standard handlers (`#tenant/server`, the personal-app handlers)
// accept this layer's access tokens alongside the browser session.
import { registerBearerAuth } from '#core/server/utils/bearer-auth'
import { rejectInsufficientScope, requireValidBearer } from '../utils/oauth-bearer'

export default defineNitroPlugin(() => {
  registerBearerAuth({
    authenticate: async (event) => {
      const auth = await requireValidBearer(event)
      return { userId: auth.userId, clientId: auth.clientId, scopes: auth.scopes }
    },
    rejectScope: rejectInsufficientScope
  })
})
