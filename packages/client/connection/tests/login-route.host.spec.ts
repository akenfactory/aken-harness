/** `/login` route handler: throttling, wire-boundary caps, and both outcomes. */

import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { handleLoginRequest } from '../src/login-route.ts'
import { LoginThrottle } from '../src/login-throttle.ts'

function fakeRequest(options: {
  method?: string
  body?: string
  headers?: Record<string, string>
  remoteAddress?: string
}): IncomingMessage {
  const request = Readable.from(options.body === undefined ? [] : [Buffer.from(options.body)]) as unknown as IncomingMessage
  Object.assign(request, {
    method: options.method ?? 'POST',
    headers: options.headers ?? {},
    socket: { remoteAddress: options.remoteAddress ?? '203.0.113.1' },
  })
  return request
}

interface ResponseState {
  status?: number
  headers?: Record<string, string>
  body?: string
}

function fakeResponse(): { response: ServerResponse; state: ResponseState } {
  const state: ResponseState = {}
  const response = {
    writeHead(status: number, headers?: Record<string, string>) {
      state.status = status
      if (headers !== undefined) state.headers = headers
      return response
    },
    end(body?: string) {
      if (body !== undefined) state.body = body
    },
  } as unknown as ServerResponse
  return { response, state }
}

describe('handleLoginRequest', () => {
  it('rejects a non-POST method with 405', async () => {
    const { response, state } = fakeResponse()
    await handleLoginRequest(fakeRequest({ method: 'GET' }), response, () => 'cookie', new LoginThrottle())
    expect(state.status).toBe(405)
  })

  it('answers 429 without invoking the verifier while the source is throttled', async () => {
    const throttle = new LoginThrottle()
    throttle.recordFailure('203.0.113.1', Date.now())
    let called = false
    const { response, state } = fakeResponse()
    await handleLoginRequest(
      fakeRequest({ body: 'email=a@b.com&password=x' }),
      response,
      () => { called = true; return 'cookie' },
      throttle,
    )
    expect(state.status).toBe(429)
    expect(called).toBe(false)
  })

  it('rejects an over-cap declared content-length with 413 before reading the body', async () => {
    const { response, state } = fakeResponse()
    await handleLoginRequest(
      fakeRequest({ body: 'x', headers: { 'content-length': '999999' } }),
      response,
      () => 'cookie',
      new LoginThrottle(),
    )
    expect(state.status).toBe(413)
  })

  it('rejects an over-cap actual body with 413', async () => {
    const { response, state } = fakeResponse()
    await handleLoginRequest(
      fakeRequest({ body: `email=a&password=${'x'.repeat(5000)}` }),
      response,
      () => 'cookie',
      new LoginThrottle(),
    )
    expect(state.status).toBe(413)
  })

  it('answers 401 with the invalid-credentials page and records a failure', async () => {
    const throttle = new LoginThrottle()
    const { response, state } = fakeResponse()
    await handleLoginRequest(
      fakeRequest({ body: 'email=a@b.com&password=wrong' }),
      response,
      () => undefined,
      throttle,
    )
    expect(state.status).toBe(401)
    expect(state.body).toContain('Invalid email or password.')
    expect(throttle.check('203.0.113.1', Date.now())).toBeDefined()
  })

  it('answers 401 when the submission is not a valid form body', async () => {
    const { response, state } = fakeResponse()
    await handleLoginRequest(
      fakeRequest({ body: 'not-a-form-body' }),
      response,
      () => 'cookie',
      new LoginThrottle(),
    )
    expect(state.status).toBe(401)
  })

  it('mints a cookie and redirects on success', async () => {
    const throttle = new LoginThrottle()
    const { response, state } = fakeResponse()
    await handleLoginRequest(
      fakeRequest({ body: 'email=admin@example.com&password=correct' }),
      response,
      (email, password) => (email === 'admin@example.com' && password === 'correct' ? 'dsh-auth-x=v1.a.b' : undefined),
      throttle,
    )
    expect(state.status).toBe(303)
    expect(state.headers).toMatchObject({ location: '/', 'set-cookie': 'dsh-auth-x=v1.a.b' })
  })

  it('clears an existing throttle entry once the backoff window has passed and login succeeds', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const throttle = new LoginThrottle()
      throttle.recordFailure('203.0.113.1', Date.now())
      vi.setSystemTime(1_001)
      const { response, state } = fakeResponse()
      await handleLoginRequest(
        fakeRequest({ body: 'email=admin@example.com&password=correct' }),
        response,
        () => 'dsh-auth-x=v1.a.b',
        throttle,
      )
      expect(state.status).toBe(303)
      expect(throttle.check('203.0.113.1', Date.now())).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
