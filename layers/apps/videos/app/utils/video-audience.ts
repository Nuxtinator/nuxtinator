// Who a video is for: its uploader (`private`), one team (`team` with
// `teamId`) or the org. `linkEnabled` turns its public link on.
export interface VideoAudience {
  visibility: 'private' | 'team' | 'org'
  teamId?: string | null
  linkEnabled?: boolean
}
