import {
  getRequestURL,
  getHeader,
  isPreflightRequest,
  appendCorsHeaders,
  appendCorsPreflightHeaders,
  setResponseStatus
} from 'h3'
import type { H3CorsOptions } from 'h3'

// CORS for the public widget API. The caller's origin is reflected (never `*`
// with credentials): the widget authenticates with a bearer session token,
// never cookies. The real gate is each widget's `allowed_origins`, checked in
// the handlers (helpinatorAssertOrigin) — CORS only stops browsers.
const PREFIX = '/api/v1/helpinator'

export default defineEventHandler((event) => {
  const path = getRequestURL(event).pathname
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return

  const origin = getHeader(event, 'origin')
  if (!origin) return

  const corsOptions: H3CorsOptions = {
    origin: [origin],
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'Accept'],
    maxAge: '600'
  }

  if (isPreflightRequest(event)) {
    appendCorsPreflightHeaders(event, corsOptions)
    setResponseStatus(event, 204)
    return ''
  }

  appendCorsHeaders(event, corsOptions)
})
