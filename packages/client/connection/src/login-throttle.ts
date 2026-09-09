/**
 * Fixed-curve, in-memory login-attempt throttle for the admin-login gate. The
 * backoff curve is a security invariant, not a configurable tunable — an
 * operator must not be able to weaken it through config.
 */

const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 30_000
/** Bounds memory under a distributed flood of distinct source keys; a
 * single-process, no-Redis mitigation is not meant to defeat that flood, only
 * to slow down credential guessing from any one source. */
const MAX_TRACKED_KEYS = 10_000

interface ThrottleEntry {
  failures: number
  blockedUntil: number
}

/** Per-source-key exponential backoff for failed login attempts. */
export class LoginThrottle {
  private readonly entries = new Map<string, ThrottleEntry>()

  /**
   * Remaining block time for a key, if currently throttled.
   * @param key - the source identity (e.g. remote address).
   * @param now - current time in epoch milliseconds.
   * @returns milliseconds remaining, or undefined when not throttled.
   */
  check(key: string, now: number): number | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined || entry.blockedUntil <= now) return undefined
    return entry.blockedUntil - now
  }

  /**
   * Record one failed attempt, extending the key's backoff exponentially.
   * @param key - the source identity.
   * @param now - current time in epoch milliseconds.
   */
  recordFailure(key: string, now: number): void {
    const previous = this.entries.get(key)
    if (previous === undefined && this.entries.size >= MAX_TRACKED_KEYS) {
      const oldestKey = this.entries.keys().next().value
      if (oldestKey !== undefined) this.entries.delete(oldestKey)
    }
    const failures = (previous?.failures ?? 0) + 1
    this.entries.set(key, { failures, blockedUntil: now + Math.min(2 ** failures * BASE_DELAY_MS, MAX_DELAY_MS) })
  }

  /**
   * Clear a key's throttle state after a successful attempt.
   * @param key - the source identity.
   */
  recordSuccess(key: string): void {
    this.entries.delete(key)
  }
}
