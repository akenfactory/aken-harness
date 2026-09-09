/** Fixed-curve exponential backoff for the admin-login gate's /login route. */

import { describe, expect, it } from 'vitest'
import { LoginThrottle } from '../src/login-throttle.ts'

describe('LoginThrottle', () => {
  it('is not throttled before any recorded failure', () => {
    const throttle = new LoginThrottle()
    expect(throttle.check('203.0.113.1', 0)).toBeUndefined()
  })

  it('backs off exponentially, expires, and clears on success', () => {
    const throttle = new LoginThrottle()
    const key = '203.0.113.1'

    throttle.recordFailure(key, 0)
    expect(throttle.check(key, 0)).toBe(1000)
    expect(throttle.check(key, 999)).toBe(1)
    expect(throttle.check(key, 1000)).toBeUndefined()

    throttle.recordFailure(key, 1000)
    expect(throttle.check(key, 1000)).toBe(2000)

    throttle.recordSuccess(key)
    expect(throttle.check(key, 1000)).toBeUndefined()
  })

  it('caps the backoff at the fixed maximum regardless of failure count', () => {
    const throttle = new LoginThrottle()
    const key = '203.0.113.1'
    for (let i = 0; i < 10; i += 1) throttle.recordFailure(key, 0)
    expect(throttle.check(key, 0)).toBe(30_000)
  })

  it('tracks distinct source keys independently', () => {
    const throttle = new LoginThrottle()
    throttle.recordFailure('a', 0)
    expect(throttle.check('a', 0)).toBeDefined()
    expect(throttle.check('b', 0)).toBeUndefined()
  })

  it('evicts the oldest tracked key once the cap is exceeded', () => {
    const throttle = new LoginThrottle()
    for (let i = 0; i < 10_000; i += 1) throttle.recordFailure(`key-${String(i)}`, 0)
    expect(throttle.check('key-0', 0)).toBeDefined()
    throttle.recordFailure('key-10000', 0)
    expect(throttle.check('key-0', 0)).toBeUndefined()
    expect(throttle.check('key-10000', 0)).toBeDefined()
  })
})
