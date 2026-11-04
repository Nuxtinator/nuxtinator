// Nitro plugin added to the test build by global-setup.ts; imports through
// `#context/server` the way a consumer layer does.
import { defineNitroPlugin } from 'nitropack/runtime'
import { registerPortfolioTemplate } from '#context/server'

export default defineNitroPlugin(() => {
  registerPortfolioTemplate({
    id: 'test-context-template',
    label: 'Test template',
    description: 'Portfolio template used by the context test suite.',
    sections: [
      { key: 'source-texts', title: 'Source Texts', description: 'Which source texts the project translates from', order: 1, staleness_days: 90 },
      { key: 'team', title: 'Translation Team', description: 'Who translates, checks, and reviews', order: 2, staleness_days: 30 },
      { key: 'checking', title: 'Checking Process', description: 'How drafts are checked before publication', order: 3, staleness_days: 60 }
    ]
  })
})
