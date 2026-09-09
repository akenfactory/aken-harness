/** Single-admin email+password credential, required from process environment: dsh web's only sign-in path. */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

const ADMIN_EMAIL_VAR = 'ADMIN_EMAIL'
const ADMIN_PASSWORD_VAR = 'ADMIN_PASSWORD'
const SCRYPT_KEY_LENGTH = 64
const SALT_BYTES = 16

/** Derived admin identity; the raw password never survives past {@link requireAdminCredentials}. */
export interface AdminCredentials {
  readonly emailDigest: Buffer
  readonly passwordHash: Buffer
  readonly passwordSalt: Buffer
}

/**
 * Resolve the required admin-login credential from this launch's environment.
 * `dsh web` has exactly one way in — signing in with `ADMIN_EMAIL` and
 * `ADMIN_PASSWORD` — so either variable missing is a loud boot-time failure,
 * never a silent fallback to some other access path. Derives comparison
 * material once; the raw password is not retained.
 * @param ctx - plugin context carrying the launch environment.
 * @returns the derived credential.
 */
export function requireAdminCredentials(ctx: Context): AdminCredentials {
  const environment = launchEnvironmentOf(ctx)
  const email = environment.getFrom(ADMIN_EMAIL_VAR, ['process'])?.value
  const password = environment.getFrom(ADMIN_PASSWORD_VAR, ['process'])?.value
  if (email === undefined || password === undefined) {
    throw new Error(
      `client-connection: ${ADMIN_EMAIL_VAR} and ${ADMIN_PASSWORD_VAR} must both be set; `
      + 'dsh web has no other way to sign in',
    )
  }
  const passwordSalt = randomBytes(SALT_BYTES)
  return {
    emailDigest: createHash('sha256').update(email).digest(),
    passwordHash: scryptSync(password, passwordSalt, SCRYPT_KEY_LENGTH),
    passwordSalt,
  }
}

/**
 * Verify one login attempt against the configured admin credential. Both
 * comparisons run unconditionally so a wrong email costs exactly as much CPU
 * time as a wrong password: no timing side-channel, no user enumeration.
 * @param creds - the configured admin credential.
 * @param email - submitted email.
 * @param password - submitted password.
 * @returns true only when both the email and the password match.
 */
export function verifyAdminLogin(creds: AdminCredentials, email: string, password: string): boolean {
  const emailDigest = createHash('sha256').update(email).digest()
  const passwordHash = scryptSync(password, creds.passwordSalt, SCRYPT_KEY_LENGTH)
  const emailOk = timingSafeEqual(emailDigest, creds.emailDigest)
  const passwordOk = timingSafeEqual(passwordHash, creds.passwordHash)
  return emailOk && passwordOk
}
