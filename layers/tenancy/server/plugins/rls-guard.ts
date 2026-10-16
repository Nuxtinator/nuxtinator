// Reports a misconfigured app database role at boot. Requests are refused by
// `assertDbEnforcesRls` in the tenancy-context middleware.
import { rlsBypassReason, rlsBypassMessage } from '../utils/rls-guard'

export default defineNitroPlugin(() => {
  rlsBypassReason()
    .then((reason) => {
      if (reason) console.error(`[tenancy] ${rlsBypassMessage(reason)} Every request will be refused until this is fixed.`)
    })
    .catch((err) => {
      console.warn('[tenancy] Could not verify the app database role at boot; will retry on the first request.', err)
    })
})
