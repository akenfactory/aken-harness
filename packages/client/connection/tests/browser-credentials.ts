import type { Context } from '@deepseek-ai/cordis'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'

/** Default test admin credential, since `dsh web` now requires one to boot. */
export const TEST_ADMIN_EMAIL = 'admin@example.com'
export const TEST_ADMIN_PASSWORD = 'correct horse battery'

/** Mutable credential-record double for Connection authentication tests. */
export class RecordCredentials {
  record: CredentialRecord | undefined
  discardWrites = false
  reads = 0
  modifies = 0

  readRecord(): Promise<CredentialRecord | undefined> {
    this.reads += 1
    return Promise.resolve(this.record)
  }

  async modifyRecord(
    _key: unknown,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    this.modifies += 1
    const next = await mutate(this.record)
    if (this.discardWrites) return undefined
    if (next !== undefined) this.record = next
    return this.record
  }

  deleteRecord(): Promise<void> {
    this.record = undefined
    return Promise.resolve()
  }
}

/**
 * Provide the record operations and required admin-login env vars Connection
 * needs to boot. `env` overrides the default test admin credential; pass a
 * partial or empty object to exercise the required-env-var failure path.
 */
export function provideBrowserCredentials(
  ctx: Context,
  env: Record<string, string> = { ADMIN_EMAIL: TEST_ADMIN_EMAIL, ADMIN_PASSWORD: TEST_ADMIN_PASSWORD },
): void {
  ctx.provide('credentials', new RecordCredentials() as unknown as CredentialProvider)
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: env }]))
}
