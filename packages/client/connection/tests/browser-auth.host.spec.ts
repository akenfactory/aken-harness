/** Admin-login submission and persistent-cookie behavior. */

import { createHmac } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { requireAdminCredentials } from '../src/admin-login.ts'
import { BrowserAuth } from '../src/browser-auth.ts'
import type { ConnectionIndexRequest, ConnectionIndexResponse } from '../src/rpc.ts'
import { RecordCredentials } from './browser-credentials.ts'

const ADMIN_EMAIL = 'admin@example.com'
const ADMIN_PASSWORD = 'correct horse battery'

function adminCredentials(
  email: string = ADMIN_EMAIL, password: string = ADMIN_PASSWORD,
): NonNullable<ReturnType<typeof requireAdminCredentials>> {
  const ctx = new Context()
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{
    source: 'process',
    values: { ADMIN_EMAIL: email, ADMIN_PASSWORD: password },
  }]))
  return requireAdminCredentials(ctx)
}

function signedCookie(store: RecordCredentials, name: string, payload: unknown): string {
  const body = typeof payload === 'string'
    ? Buffer.from(payload, 'utf8').toString('base64url')
    : Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return signedBodyCookie(store, name, body)
}

function signedBodyCookie(store: RecordCredentials, name: string, body: string): string {
  const record = store.record
  if (record?.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) {
    throw new Error('test credential store has no signing secret')
  }
  const secret: unknown = Reflect.get(record.payload, 'secret')
  if (typeof secret !== 'string') throw new Error('test credential record has no string secret')
  const signature = createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest('base64url')
  return `${name}=v1.${body}.${signature}`
}

interface ResponseState {
  status?: number
  headers?: Readonly<Record<string, string>>
  body?: string
}

function response(): { value: ConnectionIndexResponse; state: ResponseState } {
  const state: ResponseState = {}
  return {
    value: {
      writeHead(status, headers) {
        state.status = status
        if (headers !== undefined) state.headers = headers
      },
      end(body) {
        if (body !== undefined) state.body = body
      },
    },
    state,
  }
}

function credentials(store: RecordCredentials): CredentialProvider {
  return store as unknown as CredentialProvider
}

function createAuth(
  store: RecordCredentials, maxAgeDays = 30, admin = adminCredentials(),
): Promise<BrowserAuth> {
  return BrowserAuth.create(credentials(store), maxAgeDays, admin)
}

function request(url: string, authority = '127.0.0.1:3080', init?: {
  cookie?: string
  method?: string
}): ConnectionIndexRequest {
  return {
    method: init?.method ?? 'GET',
    url,
    headers: {
      host: authority,
      ...init?.cookie === undefined ? {} : { cookie: init.cookie },
    },
  }
}

/** Sign in and return the resulting session cookie's `name=value` pair. */
function login(
  auth: BrowserAuth, authority = '127.0.0.1:3080', email = ADMIN_EMAIL, password = ADMIN_PASSWORD,
): string {
  const setCookie = auth.attemptLogin({ headers: { host: authority } }, email, password)
  if (setCookie === undefined) throw new Error('login did not set a cookie')
  return setCookie.split(';', 1)[0]!
}

afterEach(() => {
  vi.useRealTimers()
})

describe('BrowserAuth', () => {
  it('has no credential in its printed URL; the operator signs in instead', async () => {
    const auth = await createAuth(new RecordCredentials())
    expect(auth.authenticatedUrl('http://127.0.0.1:3080/some/path?x=1#y')).toBe('http://127.0.0.1:3080/')
  })

  it('serves a script-free sign-in form for an unauthenticated GET /', async () => {
    const auth = await createAuth(new RecordCredentials())
    const page = response()
    expect(auth.authorizeIndex(request('/'), page.value)).toBe(false)
    expect(page.state.status).toBe(200)
    expect(page.state.headers).toEqual({ 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' })
    expect(page.state.body).toContain('action="/login"')
    expect(page.state.body).not.toContain('<script')
  })

  it('401s every other unauthenticated request with one minimal response', async () => {
    const auth = await createAuth(new RecordCredentials())
    for (const candidate of [
      request('/index.html'),
      request('/', '127.0.0.1:3080', { method: 'POST' }),
      request('/', '127.0.0.1:3080', { method: 'HEAD' }),
    ]) {
      const denied = response()
      expect(auth.authorizeIndex(candidate, denied.value)).toBe(false)
      expect(denied.state.status).toBe(401)
      expect(denied.state.headers).toEqual({
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
      })
      expect(denied.state.body).toBe(candidate.method === 'HEAD'
        ? undefined
        : 'dsh web authentication required; sign in at /.\n')
    }
  })

  it('mints a persistent authority-bound cookie on a correct login and serves index with it', async () => {
    const auth = await createAuth(new RecordCredentials())
    const cookie = login(auth)

    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(true)
    expect(auth.isAuthenticated({
      headers: new Headers({ host: '127.0.0.1:3080', cookie }),
    })).toBe(true)
    expect(auth.isAuthenticated({ headers: new Headers() })).toBe(false)
    expect(auth.isAuthenticated(request('/', 'localhost:3080', { cookie }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3081', { cookie }))).toBe(false)

    const page = response()
    expect(auth.authorizeIndex(request('/', '127.0.0.1:3080', { cookie }), page.value)).toBe(true)
    expect(page.state).toEqual({})
  })

  it('checks the cookie attributes minted on a successful login', async () => {
    const auth = await createAuth(new RecordCredentials())
    const setCookie = auth.attemptLogin({ headers: { host: '127.0.0.1:3080' } }, ADMIN_EMAIL, ADMIN_PASSWORD)!
    expect(setCookie).toMatch(/; Max-Age=2592000; Path=\/; Expires=.*; HttpOnly; SameSite=Strict$/u)
    expect(setCookie).not.toContain('Secure')
  })

  it('rejects a wrong password, a wrong email, both wrong, and a request with no determinable authority', async () => {
    const auth = await createAuth(new RecordCredentials())
    expect(auth.attemptLogin({ headers: { host: '127.0.0.1:3080' } }, ADMIN_EMAIL, 'wrong')).toBeUndefined()
    expect(auth.attemptLogin({ headers: { host: '127.0.0.1:3080' } }, 'wrong@example.com', ADMIN_PASSWORD))
      .toBeUndefined()
    expect(auth.attemptLogin({ headers: { host: '127.0.0.1:3080' } }, 'wrong@example.com', 'wrong')).toBeUndefined()
    expect(auth.attemptLogin({ headers: {} }, ADMIN_EMAIL, ADMIN_PASSWORD)).toBeUndefined()
  })

  it('rejects tampering, expiry, future issuance, and a longer lifetime than configured', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'))
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const cookie = login(auth)
    const [name, value] = cookie.split('=') as [string, string]

    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: `${name}=broken` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: `${name}=${value.slice(0, -1)}x` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: `${name}=%` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', {
      cookie: signedBodyCookie(store, name, 'a'),
    }))).toBe(false)
    expect(auth.isAuthenticated({ headers: {} })).toBe(false)
    expect(auth.isAuthenticated({ headers: { host: 'bad host', cookie } })).toBe(false)
    expect(auth.isAuthenticated({ headers: { host: '127.0.0.1:3080' } })).toBe(false)

    const invalidPayloads: unknown[] = [
      'not json',
      null,
      { version: 999, authority: '127.0.0.1:3080', issuedAt: Date.now(), expiresAt: Date.now() + 1000 },
      { version: 2, authority: 42, issuedAt: Date.now(), expiresAt: Date.now() + 1000 },
      { version: 2, authority: '127.0.0.1:3080', issuedAt: 'now', expiresAt: Date.now() + 1000 },
      { version: 2, authority: '127.0.0.1:3080', issuedAt: Date.now(), expiresAt: 'later' },
    ]
    for (const payload of invalidPayloads) {
      expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', {
        cookie: signedCookie(store, name, payload),
      }))).toBe(false)
    }

    const shorter = await createAuth(store, 1)
    expect(shorter.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
    vi.setSystemTime(new Date('2026-09-24T00:00:00.000Z'))
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
    vi.setSystemTime(new Date('2026-08-23T00:00:00.000Z'))
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
  })

  it('loads one secret per activation and replaces it after deletion on the next activation', async () => {
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const first = login(auth)
    expect(store).toMatchObject({ reads: 0, modifies: 1 })

    await store.deleteRecord()
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: first }))).toBe(true)
    const sameActivation = login(auth)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: sameActivation }))).toBe(true)
    expect(store).toMatchObject({ reads: 0, modifies: 1 })

    const reactivated = await createAuth(store)
    const second = login(reactivated)
    expect(second).not.toBe(first)
    expect(reactivated.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: first }))).toBe(false)
    expect(reactivated.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: second }))).toBe(true)
    expect(store).toMatchObject({ reads: 0, modifies: 2 })
  })

  it('fails loud on an invalid owner record instead of replacing it', async () => {
    const unsupported = new RecordCredentials()
    unsupported.record = { kind: 'api-key', key: 'not-a-cookie-secret' }
    await expect(createAuth(unsupported)).rejects.toThrow(/unsupported format/u)

    const malformed = new RecordCredentials()
    malformed.record = { kind: 'grant', payload: { version: 1, secret: 'short' } }
    await expect(createAuth(malformed)).rejects.toThrow(/invalid secret/u)

    const nonString = new RecordCredentials()
    nonString.record = { kind: 'grant', payload: { version: 1, secret: 42 } }
    await expect(createAuth(nonString)).rejects.toThrow(/invalid secret/u)

    const discarded = new RecordCredentials()
    discarded.discardWrites = true
    await expect(createAuth(discarded)).rejects.toThrow(/was not created/u)

    await expect(createAuth(new RecordCredentials(), Number.MAX_SAFE_INTEGER))
      .rejects.toThrow(/safe timestamp range/u)
  })
})
