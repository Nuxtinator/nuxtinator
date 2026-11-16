import { describe, it, expect } from 'vitest'
import { registerInboxThreadAction, getInboxThreadActions, type InboxThreadActionContext } from '../../app/utils/inbox-thread-actions'

function ctx(status: string): InboxThreadActionContext {
  return {
    conversation: {
      id: 'c1',
      subject: 'Hello',
      status,
      assignedUserId: null,
      needsReview: false,
      source: 'email',
      counterpartyName: null,
      tags: [],
      lastMessageAt: null,
      createdAt: '2026-01-01T00:00:00Z'
    },
    me: null,
    refresh: async () => {}
  }
}

describe('inbox thread action registry', () => {
  it('orders by `order`, replaces a re-registered id, and applies `visible`', () => {
    const noop = () => {}
    registerInboxThreadAction({ id: 'test-b', label: 'B', order: 200, onSelect: noop })
    registerInboxThreadAction({ id: 'test-a', label: 'A', onSelect: noop })
    registerInboxThreadAction({ id: 'test-hidden', label: 'Hidden', visible: c => c.conversation.status !== 'closed', onSelect: noop })
    registerInboxThreadAction({ id: 'test-a', label: 'A2', order: 50, onSelect: noop })

    expect(getInboxThreadActions(ctx('open')).map(a => a.label)).toEqual(['A2', 'Hidden', 'B'])
    expect(getInboxThreadActions(ctx('closed')).map(a => a.label)).toEqual(['A2', 'B'])
  })
})
