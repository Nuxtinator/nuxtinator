import type { HelpinatorAppearanceForm } from '../utils/helpinator-types'

export interface HelpinatorStatus {
  aiConfigured: boolean
  inboxAvailable: boolean
  canManage: boolean
  appearanceDefaults: HelpinatorAppearanceForm
}

export function useHelpinatorStatus() {
  return useFetch<HelpinatorStatus>('/api/helpinator/status', { key: 'helpinator-status' })
}
