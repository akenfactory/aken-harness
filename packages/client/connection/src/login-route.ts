/** node:http handler for dsh web's `POST /login` route, its only sign-in path. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseLoginBody, renderLoginPage } from './login-form.ts'
import type { LoginThrottle } from './login-throttle.ts'

/** Wire-boundary cap for a login submission: two short fields, nothing more. */
const MAX_LOGIN_BODY_BYTES = 4096

/** Verify one login submission; returns the Set-Cookie value on success. */
export type LoginAttempt = (email: string, password: string) => string | undefined

/**
 * Handle one `/login` submission: throttled per source, size-capped, and
 * form-encoded only (the page that posts here carries no script). A wrong
 * email and a wrong password answer identically, so the response body alone
 * never tells an attacker which field was wrong.
 * @param req - incoming node:http request.
 * @param res - node:http response this handler owns.
 * @param attemptLogin - verifies credentials and mints a session cookie.
 * @param throttle - per-source exponential backoff for failed attempts.
 */
export async function handleLoginRequest(
  req: IncomingMessage,
  res: ServerResponse,
  attemptLogin: LoginAttempt,
  throttle: LoginThrottle,
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405)
    res.end()
    return
  }
  const key = req.socket.remoteAddress ?? 'unknown'
  const now = Date.now()
  const blockedMs = throttle.check(key, now)
  if (blockedMs !== undefined) {
    res.writeHead(429, { 'cache-control': 'no-store', 'retry-after': String(Math.ceil(blockedMs / 1000)) })
    res.end()
    return
  }
  const declaredLength = req.headers['content-length']
  if (declaredLength !== undefined && Number(declaredLength) > MAX_LOGIN_BODY_BYTES) {
    res.writeHead(413)
    res.end()
    req.destroy()
    return
  }
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    received += buffer.byteLength
    if (received > MAX_LOGIN_BODY_BYTES) {
      res.writeHead(413)
      res.end()
      req.destroy()
      return
    }
    chunks.push(buffer)
  }
  const submission = parseLoginBody(Buffer.concat(chunks).toString('utf8'))
  const setCookie = submission === undefined ? undefined : attemptLogin(submission.email, submission.password)
  if (setCookie === undefined) {
    throttle.recordFailure(key, now)
    res.writeHead(401, { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' })
    res.end(renderLoginPage({ invalid: true }))
    return
  }
  throttle.recordSuccess(key)
  res.writeHead(303, {
    'cache-control': 'no-store',
    'location': '/',
    'referrer-policy': 'no-referrer',
    'set-cookie': setCookie,
  })
  res.end()
}
