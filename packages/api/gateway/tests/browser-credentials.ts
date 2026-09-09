import type { Context } from '@deepseek-ai/cordis'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'

/** Default test admin credential, since `dsh web` now requires one to boot. */
export const TEST_ADMIN_EMAIL = 'admin@example.com'
export const TEST_ADMIN_PASSWORD = 'correct horse battery'

/**
 * Provide an in-memory credential-record owner and the required admin-login
 * env vars for a mounted Connection plugin. `env` overrides the default test
 * admin credential.
 */
export function provideBrowserCredentials(
  ctx: Context,
  env: Record<string, string> = { ADMIN_EMAIL: TEST_ADMIN_EMAIL, ADMIN_PASSWORD: TEST_ADMIN_PASSWORD },
): void {
  const records = new Map<unknown, unknown>()
  ctx.provide('credentials', {
    async modifyRecord(
      key: unknown,
      mutate: (current: unknown) => Promise<unknown>,
    ): Promise<unknown> {
      const current = records.get(key)
      const next = await mutate(current)
      if (next !== undefined) records.set(key, next)
      return next ?? current
    },
  } as never)
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: env }]))
}
