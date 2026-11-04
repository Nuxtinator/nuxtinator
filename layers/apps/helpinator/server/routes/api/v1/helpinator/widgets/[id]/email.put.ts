// PUT /api/v1/helpinator/widgets/:id/email — retired. The widget's optional
// "Add your email" option was removed (handoff asks for the address itself);
// this answers widget bundles still cached on visitors' browsers so they get a
// clear error rather than a 404. Remove after one release.
export default defineEventHandler(() => {
  throw createError({ statusCode: 410, statusMessage: 'Saving an email is no longer supported. Use "Still need help?" instead.' })
})
