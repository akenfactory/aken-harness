/** Real `dsh web` authentication against a temporary Harness home. */

import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const DSH_SOURCE_BIN = join(REPO_ROOT, 'apps/cli/src/bin.ts')
const TSX_LOADER = pathToFileURL(createRequire(join(REPO_ROOT, 'package.json')).resolve('tsx')).href

/**
 * `dsh web` has exactly one way in; every spawned process needs this unless a
 * test deliberately overrides it. The password keeps a non-ASCII character to
 * exercise percent-encoding through the login form and `/login` submission.
 */
const DEFAULT_ADMIN_EMAIL = 'admin@example.com'
const DEFAULT_ADMIN_PASSWORD = 'Test¡Fixture1!'

interface RunningWeb {
  readonly child: ChildProcess
  readonly launchUrl: string
  readonly output: () => string
}

interface HttpResult {
  readonly status: number
  readonly body: string
}

/** Reserve one concrete loopback port, then release it for the CLI process. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
  return port
}

/** `extra` may set `undefined` to omit a variable entirely (not merely empty), simulating it never being exported. */
function cleanEnvironment(
  root: string, dshHome: string, extra: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name)))
  const merged: Record<string, string | undefined> = {
    ...env,
    DSH_AGENTS_HOME: join(root, '.agents'),
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    NODE_NO_WARNINGS: '1',
    SSH_CONNECTION: '',
    SSH_TTY: '',
    TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json'),
    // Defaults land after the filtered parent snapshot, so ADMIN_EMAIL/
    // ADMIN_PASSWORD survive the PASSWORD/TOKEN filter above (which only
    // guards against leaking the *outer* shell's secrets into the spawned
    // CLI); `extra` lands last and may override or omit them.
    ADMIN_EMAIL: DEFAULT_ADMIN_EMAIL,
    ADMIN_PASSWORD: DEFAULT_ADMIN_PASSWORD,
    ...extra,
  }
  return Object.fromEntries(
    Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

/**
 * Start the public source CLI and wait for its readiness URL. `extraEnv`
 * overrides or omits (via `undefined`) the default admin credential.
 */
async function startWeb(
  root: string, dshHome: string, port: number, extraEnv: Record<string, string | undefined> = {},
): Promise<RunningWeb> {
  const child = spawn(process.execPath, [
    '--import', TSX_LOADER,
    DSH_SOURCE_BIN,
    'web',
    '--no-open',
    '--port', String(port),
  ], {
    cwd: root,
    env: cleanEnvironment(root, dshHome, extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const launchUrl = await new Promise<string>((resolve, reject) => {
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }
    const timer = setTimeout(() => {
      fail(new Error(`dsh web did not become ready:\n${output}`))
    }, 90_000)
    const append = (chunk: Buffer | string): void => {
      output = `${output}${String(chunk)}`.slice(-100_000)
      const match = /dsh web: (http:\/\/[^\s]+)/u.exec(output)
      if (settled || match?.[1] === undefined) return
      settled = true
      clearTimeout(timer)
      resolve(match[1])
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.once('error', (error) => {
      fail(error)
    })
    child.once('exit', (code) => {
      fail(new Error(`dsh web exited before readiness (${String(code)}):\n${output}`))
    })
  })
  return { child, launchUrl, output: () => output }
}

async function stopWeb(running: RunningWeb): Promise<void> {
  if (running.child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => { running.child.once('exit', () => { resolve() }) })
  running.child.kill('SIGTERM')
  const forced = setTimeout(() => { running.child.kill('SIGKILL') }, 10_000)
  forced.unref()
  await exited
  clearTimeout(forced)
}

/** POST one real Remote envelope while controlling the wire Host header. */
function describeSettings(port: number, host: string, cookie?: string): Promise<HttpResult> {
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: 'web-auth-real-cli',
    method: 'settings/describe',
    payload: { args: {} },
  })
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/settings/describe',
      method: 'POST',
      headers: {
        host,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...cookie === undefined ? {} : { cookie },
      },
    }, (res) => {
      const chunks: Uint8Array[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.once('error', reject)
    req.end(body)
  })
}

/** POST one x-www-form-urlencoded admin-login submission. */
function postLogin(
  port: number, host: string, body: string,
): Promise<{ status: number; setCookie?: string; location?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/login',
      method: 'POST',
      headers: {
        host,
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks: Uint8Array[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => {
        const setCookie = res.headers['set-cookie']?.[0]
        const location = res.headers.location
        resolve({
          status: res.statusCode ?? 0,
          ...setCookie === undefined ? {} : { setCookie },
          ...location === undefined ? {} : { location },
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    req.once('error', reject)
    req.end(body)
  })
}

describe('dsh web admin login', () => {
  it('has no other way in: it refuses to boot unless ADMIN_EMAIL and ADMIN_PASSWORD are both set', { timeout: 60_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-admin-login-missing-'))
    const dshHome = join(root, '.dsh')
    const port = await freePort()
    try {
      await expect(startWeb(root, dshHome, port, { ADMIN_EMAIL: undefined, ADMIN_PASSWORD: undefined }))
        .rejects.toThrow(/ADMIN_EMAIL and ADMIN_PASSWORD must both be set/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('gates access behind ADMIN_EMAIL/ADMIN_PASSWORD, with no other credential accepted', { timeout: 180_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-admin-login-'))
    const dshHome = join(root, '.dsh')
    const port = await freePort()
    let running: RunningWeb | undefined
    try {
      running = await startWeb(root, dshHome, port)
      const url = new URL(running.launchUrl)
      // The printed URL carries no credential: the operator signs in instead.
      expect(url.search).toBe('')

      const form = await fetch(running.launchUrl)
      expect(form.status).toBe(200)
      expect(await form.text()).toContain('action="/login"')

      const wrong = await postLogin(port, url.host, `email=${encodeURIComponent(DEFAULT_ADMIN_EMAIL)}&password=wrong`)
      expect(wrong.status).toBe(401)
      expect(wrong.body).toContain('Invalid email or password.')

      // The very next attempt from the same source is throttled immediately.
      const throttled = await postLogin(port, url.host, `email=${encodeURIComponent(DEFAULT_ADMIN_EMAIL)}&password=wrong`)
      expect(throttled.status).toBe(429)

      // Correct credentials still work once the short initial backoff elapses.
      await new Promise(resolve => setTimeout(resolve, 1_100))
      const success = await postLogin(
        port, url.host,
        `email=${encodeURIComponent(DEFAULT_ADMIN_EMAIL)}&password=${encodeURIComponent(DEFAULT_ADMIN_PASSWORD)}`,
      )
      expect(success.status).toBe(303)
      expect(success.location).toBe('/')
      const cookie = success.setCookie?.split(';', 1)[0]
      if (cookie === undefined) throw new Error('admin login did not set a cookie')

      const authenticated = await describeSettings(port, url.host, cookie)
      expect(authenticated.status).toBe(200)
    } finally {
      if (running !== undefined) await stopWeb(running)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a forged loopback Host and preserves the browser session across restart', { timeout: 180_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-auth-real-cli-'))
    const dshHome = join(root, '.dsh')
    const port = await freePort()
    let first: RunningWeb | undefined
    let second: RunningWeb | undefined
    try {
      first = await startWeb(root, dshHome, port)
      const firstUrl = new URL(first.launchUrl)
      expect(firstUrl.origin).toBe(`http://127.0.0.1:${String(port)}`)
      expect(firstUrl.pathname).toBe('/')

      expect(await describeSettings(port, `localhost:${String(port)}`)).toEqual({
        status: 401,
        body: 'unauthorized',
      })

      const login = await postLogin(
        port, firstUrl.host,
        `email=${encodeURIComponent(DEFAULT_ADMIN_EMAIL)}&password=${encodeURIComponent(DEFAULT_ADMIN_PASSWORD)}`,
      )
      expect(login.status).toBe(303)
      const setCookie = login.setCookie
      if (setCookie === undefined) throw new Error('real CLI login omitted Set-Cookie')
      expect(setCookie).toContain('HttpOnly')
      expect(setCookie).toContain('SameSite=Strict')
      expect(setCookie).not.toContain('Secure')
      const cookie = setCookie.split(';', 1)[0]!

      const authenticated = await describeSettings(port, firstUrl.host, cookie)
      expect(authenticated.status).toBe(200)
      const authenticatedBody = JSON.parse(authenticated.body) as unknown
      expect(authenticatedBody).toMatchObject({
        type: 'server-response',
        rpcId: 'web-auth-real-cli',
        result: { ok: true, value: { namespaces: expect.any(Array) as unknown } },
      })

      await stopWeb(first)
      first = undefined
      second = await startWeb(root, dshHome, port)
      const secondUrl = new URL(second.launchUrl)
      expect((await describeSettings(port, secondUrl.host, cookie)).status).toBe(200)

      const credentialMode = (await stat(join(dshHome, '.credentials.yaml'))).mode & 0o777
      expect(credentialMode).toBe(0o600)
    } catch (error) {
      const evidence = [first?.output(), second?.output()].filter(value => value !== undefined).join('\n')
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${evidence}`, { cause: error })
    } finally {
      if (second !== undefined) await stopWeb(second)
      if (first !== undefined) await stopWeb(first)
      await rm(root, { recursive: true, force: true })
    }
  })
})
