/** Admin email+password credential derivation and constant-time verification. */

import { Context } from '@deepseek-ai/cordis'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { describe, expect, it } from 'vitest'
import { requireAdminCredentials, verifyAdminLogin } from '../src/admin-login.ts'

function contextWithEnv(values: Record<string, string>): Context {
  const ctx = new Context()
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values }]))
  return ctx
}

describe('requireAdminCredentials', () => {
  it('throws when neither ADMIN_EMAIL nor ADMIN_PASSWORD is set', () => {
    expect(() => requireAdminCredentials(contextWithEnv({})))
      .toThrow(/ADMIN_EMAIL and ADMIN_PASSWORD must both be set/u)
  })

  it('throws when only ADMIN_EMAIL is set', () => {
    expect(() => requireAdminCredentials(contextWithEnv({ ADMIN_EMAIL: 'admin@example.com' })))
      .toThrow(/ADMIN_EMAIL and ADMIN_PASSWORD must both be set/u)
  })

  it('throws when only ADMIN_PASSWORD is set', () => {
    expect(() => requireAdminCredentials(contextWithEnv({ ADMIN_PASSWORD: 'secret' })))
      .toThrow(/ADMIN_EMAIL and ADMIN_PASSWORD must both be set/u)
  })

  it('derives a fresh salt and hash on every read, never equal across reads', () => {
    const values = { ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'correct horse battery' }
    const first = requireAdminCredentials(contextWithEnv(values))
    const second = requireAdminCredentials(contextWithEnv(values))
    expect(first.passwordSalt.equals(second.passwordSalt)).toBe(false)
    expect(first.passwordHash.equals(second.passwordHash)).toBe(false)
    expect(first.emailDigest.equals(second.emailDigest)).toBe(true)
  })
})

describe('verifyAdminLogin', () => {
  const creds = requireAdminCredentials(contextWithEnv({
    ADMIN_EMAIL: 'admin@example.com',
    ADMIN_PASSWORD: 'correct horse battery',
  }))

  it('accepts the exact configured email and password', () => {
    expect(verifyAdminLogin(creds, 'admin@example.com', 'correct horse battery')).toBe(true)
  })

  it('rejects a wrong password, a wrong email, and both wrong, identically', () => {
    expect(verifyAdminLogin(creds, 'admin@example.com', 'wrong')).toBe(false)
    expect(verifyAdminLogin(creds, 'wrong@example.com', 'correct horse battery')).toBe(false)
    expect(verifyAdminLogin(creds, 'wrong@example.com', 'wrong')).toBe(false)
  })
})
