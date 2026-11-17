// Core's wrapper around the @nuxtinator/mail kernel. Layers contribute
// providers, streams, inbound handlers, event handlers and send guards from
// their Nitro plugins; core builds the one kernel instance after every plugin
// has run and migrations have finished (plugins/mail.ts). Anything that asks
// for the instance sooner awaits that build. Registering after the build
// throws, so a late registration is a loud bug rather than a silent miss.
//
// Mail settings are read from the runtime environment, never runtimeConfig:
// values read from process.env inside nuxt.config are fixed at build time.
import type { Transaction } from 'kysely'
import {
  createMail, type InboundHandler, type Mail, type MailEventHandler, type MailProvider, type MailStream,
  type OutgoingMail, type SendGuard, type SendResult
} from '@nuxtinator/mail/kernel'
import { afterCommit } from './after-commit'
import { db } from './database'

export type { Mail, MailStream, MailProvider, InboundHandler, MailEventHandler, SendGuard, OutgoingMail, SendResult }

export interface MailBuildOptions extends Omit<Parameters<typeof createMail>[0], 'providers' | 'streams' | 'guards' | 'inboundHandlers' | 'eventHandlers'> {}

interface MailState {
  providers: MailProvider[]
  streams: MailStream[]
  inbound: InboundHandler[]
  events: MailEventHandler[]
  guards: SendGuard[]
  sealed: boolean
  instance: Mail | null
  ready: Promise<Mail | null>
  settle: (mail: Mail | null, error?: unknown) => void
}

const KEY = Symbol.for('nuxtinator.mail.state')

function state(): MailState {
  const g = globalThis as Record<symbol, unknown>
  if (!g[KEY]) {
    let resolve!: (m: Mail | null) => void
    let reject!: (e: unknown) => void
    const ready = new Promise<Mail | null>((res, rej) => {
      resolve = res
      reject = rej
    })
    ready.catch(() => {})
    g[KEY] = {
      providers: [],
      streams: [],
      inbound: [],
      events: [],
      guards: [],
      sealed: false,
      instance: null,
      ready,
      settle: (mail: Mail | null, error?: unknown) => error ? reject(error) : resolve(mail)
    } satisfies MailState
  }
  return g[KEY] as MailState
}

function open(what: string): MailState {
  const s = state()
  if (s.sealed) throw new Error(`${what} was called after the mail kernel was built; register from a Nitro plugin`)
  return s
}

export function registerMailProvider(provider: MailProvider): void {
  open('registerMailProvider').providers.push(provider)
}

export function registerMailStream(stream: MailStream): void {
  open('registerMailStream').streams.push(stream)
}

export function registerInboundHandler(handler: InboundHandler): void {
  open('registerInboundHandler').inbound.push(handler)
}

export function registerMailEventHandler(handler: MailEventHandler): void {
  open('registerMailEventHandler').events.push(handler)
}

export function registerSendGuard(guard: SendGuard): void {
  open('registerSendGuard').guards.push(guard)
}

export function getRegisteredMailStreams(): MailStream[] {
  return [...state().streams]
}

// Builds the kernel from everything registered. Called once by core's plugin,
// which hands the instance to callers through settleMail once it's ready.
export function buildMail(opts: MailBuildOptions): Mail {
  const s = state()
  s.sealed = true
  return createMail({
    ...opts,
    providers: s.providers,
    streams: s.streams,
    guards: s.guards,
    inboundHandlers: s.inbound,
    eventHandlers: s.events
  })
}

export function settleMail(mail: Mail | null, error?: unknown): void {
  const s = state()
  s.sealed = true
  s.instance = mail
  s.settle(mail, error)
}

// The kernel, once built. Throws when mail is unavailable (no database, no
// key, or the build failed).
export async function useMail(): Promise<Mail> {
  const mail = state().instance ?? await state().ready
  if (!mail) throw new Error('Mail is unavailable: the mail kernel was not built (no database?)')
  return mail
}

export function mailIfBuilt(): Mail | null {
  return state().instance
}

// Sends now. Never call inside a transaction: use enqueueMail. A process that
// can only enqueue (no secret key) queues mail on a queued stream for a
// sending process to deliver.
export async function sendMail(m: OutgoingMail): Promise<SendResult> {
  const mail = await useMail()
  if (!mail.canSend && mail.streams.find(s => s.id === m.stream)?.queued) {
    return await db.transaction().execute(tx => mail.enqueue(m, { tx }))
  }
  return await mail.send(m)
}

// Writes the mail to the outbox in `tx` and makes its first attempt right
// after the transaction commits. Nothing is sent when it rolls back.
export async function enqueueMail(tx: Transaction<any>, m: OutgoingMail): Promise<{ status: 'queued', outboxId: string }> {
  const mail = await useMail()
  const queued = await mail.enqueue(m, { tx })
  await afterCommit(tx, async () => {
    if (mail.canSend) await mail.flush([queued.outboxId])
  })
  return queued
}

export async function isAddressSuppressed(address: string, opts: { orgId?: string | null } = {}) {
  return await (await useMail()).isSuppressed(address, opts)
}

export async function suppressedAmong(addresses: string[], opts: { orgId?: string | null } = {}) {
  return await (await useMail()).suppressedAmong(addresses, opts)
}

export async function resolveMailSender(stream: string, orgId?: string | null) {
  return await (await useMail()).resolveSender(stream, orgId)
}

// The wording for an address the kernel won't mail, naming who can fix it.
export function suppressionMessage(reason: 'hard_bounce' | 'complaint', what: string): string {
  const fix = 'A host admin can clear this under Admin → Email → Suppressions.'
  return reason === 'complaint'
    ? `This person marked our mail as spam, so the ${what} wasn't sent. ${fix}`
    : `Mail to this address has bounced before, so the ${what} wasn't sent. ${fix}`
}

// Refuses (422) to mail an address the kernel suppresses, with a message that
// says who can fix it. For mail the person didn't ask for, such as invites.
export async function assertMailable(address: string, what: string): Promise<void> {
  const hit = await isAddressSuppressed(address)
  if (hit) {
    throw createError({ statusCode: 422, statusMessage: suppressionMessage(hit.reason, what), data: { reason: hit.reason } })
  }
}
