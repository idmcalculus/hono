import { Hono } from '../../hono'
import type { RateLimitStore } from '.'
import { rateLimiter, MemoryStore } from '.'

describe('Rate Limit Middleware', () => {
  describe('Basic functionality', () => {
    it('should allow requests within the limit', async () => {
      const app = new Hono()
      app.use('/api/*', rateLimiter({ limit: 5, windowMs: 60000 }))
      app.get('/api/test', (c) => c.text('ok'))

      for (let i = 0; i < 5; i++) {
        const res = await app.request('/api/test')
        expect(res.status).toBe(200)
        expect(await res.text()).toBe('ok')
      }
    })

    it('should block requests exceeding the limit', async () => {
      const app = new Hono()
      app.use('/api/*', rateLimiter({ limit: 3, windowMs: 60000 }))
      app.get('/api/test', (c) => c.text('ok'))

      // First 3 requests should succeed
      for (let i = 0; i < 3; i++) {
        const res = await app.request('/api/test')
        expect(res.status).toBe(200)
      }

      // 4th request should be rate limited
      const res = await app.request('/api/test')
      expect(res.status).toBe(429)
      expect(await res.text()).toBe('Too Many Requests')
    })

    it('should use default options when none provided', async () => {
      const app = new Hono()
      app.use('/api/*', rateLimiter())
      app.get('/api/test', (c) => c.text('ok'))

      const res = await app.request('/api/test')
      expect(res.status).toBe(200)
    })
  })

  describe('Rate limit headers', () => {
    it('should set X-RateLimit-Limit header', async () => {
      const app = new Hono()
      app.use('/api/*', rateLimiter({ limit: 10, windowMs: 60000 }))
      app.get('/api/test', (c) => c.text('ok'))

      const res = await app.request('/api/test')
      expect(res.headers.get('X-RateLimit-Limit')).toBe('10')
    })

    it('should set X-RateLimit-Remaining header', async () => {
      const app = new Hono()
      app.use('/api/*', rateLimiter({ limit: 10, windowMs: 60000 }))
      app.get('/api/test', (c) => c.text('ok'))

      const res1 = await app.request('/api/test')
      expect(res1.headers.get('X-RateLimit-Remaining')).toBe('9')

      const res2 = await app.request('/api/test')
      expect(res2.headers.get('X-RateLimit-Remaining')).toBe('8')
    })

    it('should set X-RateLimit-Reset header', async () => {
      const app = new Hono()
      app.use('/api/*', rateLimiter({ limit: 10, windowMs: 60000 }))
      app.get('/api/test', (c) => c.text('ok'))

      const res = await app.request('/api/test')
      const resetTime = res.headers.get('X-RateLimit-Reset')
      expect(resetTime).not.toBeNull()
      expect(parseInt(resetTime!)).toBeGreaterThan(Math.floor(Date.now() / 1000))
    })

    it('should set Retry-After header when rate limited', async () => {
      const app = new Hono()
      app.use('/api/*', rateLimiter({ limit: 1, windowMs: 60000 }))
      app.get('/api/test', (c) => c.text('ok'))

      await app.request('/api/test')
      const res = await app.request('/api/test')

      expect(res.status).toBe(429)
      const retryAfter = res.headers.get('Retry-After')
      expect(retryAfter).not.toBeNull()
      expect(parseInt(retryAfter!)).toBeGreaterThan(0)
    })
  })

  describe('Default key generator', () => {
    it('should use x-forwarded-for header when present', async () => {
      const app = new Hono()
      app.use('/api/*', rateLimiter({ limit: 2, windowMs: 60000 }))
      app.get('/api/test', (c) => c.text('ok'))

      // Requests from IP1
      const res1 = await app.request('/api/test', {
        headers: { 'x-forwarded-for': '192.168.1.1' },
      })
      expect(res1.status).toBe(200)

      const res2 = await app.request('/api/test', {
        headers: { 'x-forwarded-for': '192.168.1.1' },
      })
      expect(res2.status).toBe(200)

      const res3 = await app.request('/api/test', {
        headers: { 'x-forwarded-for': '192.168.1.1' },
      })
      expect(res3.status).toBe(429)

      // Requests from IP2 have separate limit
      const res4 = await app.request('/api/test', {
        headers: { 'x-forwarded-for': '192.168.1.2' },
      })
      expect(res4.status).toBe(200)
    })

    it('should use x-real-ip header when x-forwarded-for is not present', async () => {
      const app = new Hono()
      app.use('/api/*', rateLimiter({ limit: 1, windowMs: 60000 }))
      app.get('/api/test', (c) => c.text('ok'))

      const res1 = await app.request('/api/test', {
        headers: { 'x-real-ip': '10.0.0.1' },
      })
      expect(res1.status).toBe(200)

      const res2 = await app.request('/api/test', {
        headers: { 'x-real-ip': '10.0.0.1' },
      })
      expect(res2.status).toBe(429)

      // Different IP has separate limit
      const res3 = await app.request('/api/test', {
        headers: { 'x-real-ip': '10.0.0.2' },
      })
      expect(res3.status).toBe(200)
    })

    it('should prioritize x-forwarded-for over x-real-ip', async () => {
      const app = new Hono()
      app.use('/api/*', rateLimiter({ limit: 1, windowMs: 60000 }))
      app.get('/api/test', (c) => c.text('ok'))

      const res1 = await app.request('/api/test', {
        headers: {
          'x-forwarded-for': '192.168.1.1',
          'x-real-ip': '10.0.0.1',
        },
      })
      expect(res1.status).toBe(200)

      // Should use x-forwarded-for value
      const res2 = await app.request('/api/test', {
        headers: {
          'x-forwarded-for': '192.168.1.1',
          'x-real-ip': '10.0.0.1',
        },
      })
      expect(res2.status).toBe(429)

      // Request with only x-real-ip should have separate limit
      const res3 = await app.request('/api/test', {
        headers: { 'x-real-ip': '10.0.0.1' },
      })
      expect(res3.status).toBe(200)
    })

    it('should use first IP from x-forwarded-for when multiple IPs present', async () => {
      const app = new Hono()
      app.use('/api/*', rateLimiter({ limit: 1, windowMs: 60000 }))
      app.get('/api/test', (c) => c.text('ok'))

      const res1 = await app.request('/api/test', {
        headers: { 'x-forwarded-for': '192.168.1.1, 10.0.0.1, 172.16.0.1' },
      })
      expect(res1.status).toBe(200)

      // Should use first IP (192.168.1.1)
      const res2 = await app.request('/api/test', {
        headers: { 'x-forwarded-for': '192.168.1.1, 10.0.0.2' },
      })
      expect(res2.status).toBe(429)
    })

    it('should use global fallback when no IP headers present', async () => {
      const app = new Hono()
      app.use('/api/*', rateLimiter({ limit: 2, windowMs: 60000 }))
      app.get('/api/test', (c) => c.text('ok'))

      // All requests without IP headers share the 'global' key
      const res1 = await app.request('/api/test')
      expect(res1.status).toBe(200)

      const res2 = await app.request('/api/test')
      expect(res2.status).toBe(200)

      const res3 = await app.request('/api/test')
      expect(res3.status).toBe(429)
    })
  })

  describe('Custom key generator', () => {
    it('should use custom key generator', async () => {
      const app = new Hono()
      app.use(
        '/api/*',
        rateLimiter({
          limit: 2,
          windowMs: 60000,
          keyGenerator: (c) => c.req.header('x-api-key') ?? 'anonymous',
        })
      )
      app.get('/api/test', (c) => c.text('ok'))

      // Requests with key1 should have their own limit
      const res1 = await app.request('/api/test', {
        headers: { 'x-api-key': 'key1' },
      })
      expect(res1.status).toBe(200)

      const res2 = await app.request('/api/test', {
        headers: { 'x-api-key': 'key1' },
      })
      expect(res2.status).toBe(200)

      const res3 = await app.request('/api/test', {
        headers: { 'x-api-key': 'key1' },
      })
      expect(res3.status).toBe(429)

      // Requests with key2 should have their own separate limit
      const res4 = await app.request('/api/test', {
        headers: { 'x-api-key': 'key2' },
      })
      expect(res4.status).toBe(200)
    })

    it('should support async key generator', async () => {
      const app = new Hono()
      app.use(
        '/api/*',
        rateLimiter({
          limit: 1,
          windowMs: 60000,
          keyGenerator: async (c) => {
            await new Promise((resolve) => setTimeout(resolve, 1))
            return c.req.header('x-user-id') ?? 'guest'
          },
        })
      )
      app.get('/api/test', (c) => c.text('ok'))

      const res1 = await app.request('/api/test', {
        headers: { 'x-user-id': 'user1' },
      })
      expect(res1.status).toBe(200)

      const res2 = await app.request('/api/test', {
        headers: { 'x-user-id': 'user1' },
      })
      expect(res2.status).toBe(429)
    })
  })

  describe('Custom handler', () => {
    it('should use custom rate limit handler', async () => {
      const app = new Hono()
      app.use(
        '/api/*',
        rateLimiter({
          limit: 1,
          windowMs: 60000,
          handler: (c) => c.json({ error: 'Rate limit exceeded' }, 429),
        })
      )
      app.get('/api/test', (c) => c.text('ok'))

      await app.request('/api/test')
      const res = await app.request('/api/test')

      expect(res.status).toBe(429)
      expect(await res.json()).toEqual({ error: 'Rate limit exceeded' })
    })

    it('should support async custom handler', async () => {
      const app = new Hono()
      app.use(
        '/api/*',
        rateLimiter({
          limit: 1,
          windowMs: 60000,
          handler: async (c) => {
            await new Promise((resolve) => setTimeout(resolve, 1))
            return c.text('Custom rate limit message', 429)
          },
        })
      )
      app.get('/api/test', (c) => c.text('ok'))

      await app.request('/api/test')
      const res = await app.request('/api/test')

      expect(res.status).toBe(429)
      expect(await res.text()).toBe('Custom rate limit message')
    })
  })

  describe('Custom store', () => {
    it('should use custom store', async () => {
      const data = new Map<string, { count: number; resetTime: number }>()

      const customStore: RateLimitStore = {
        async get(key: string) {
          return data.get(key)
        },
        async increment(key: string, windowMs: number) {
          const now = Date.now()
          const entry = data.get(key)
          if (!entry || now > entry.resetTime) {
            const newEntry = { count: 1, resetTime: now + windowMs }
            data.set(key, newEntry)
            return newEntry
          }
          entry.count++
          return entry
        },
        async decrement(key: string) {
          const entry = data.get(key)
          if (!entry) {
            return undefined
          }
          if (Date.now() > entry.resetTime) {
            data.delete(key)
            return undefined
          }
          if (entry.count > 0) {
            entry.count--
          }
          return entry
        },
        async reset(key: string) {
          data.delete(key)
        },
      }

      const app = new Hono()
      app.use('/api/*', rateLimiter({ limit: 2, windowMs: 60000, store: customStore }))
      app.get('/api/test', (c) => c.text('ok'))

      const res1 = await app.request('/api/test')
      expect(res1.status).toBe(200)

      const res2 = await app.request('/api/test')
      expect(res2.status).toBe(200)

      const res3 = await app.request('/api/test')
      expect(res3.status).toBe(429)
    })
  })

  describe('Skip options', () => {
    it('should skip successful requests when skipSuccessfulRequests is true', async () => {
      const app = new Hono()
      app.use('/api/*', rateLimiter({ limit: 2, windowMs: 60000, skipSuccessfulRequests: true }))
      app.get('/api/test', (c) => c.text('ok'))

      // All successful requests should not count toward the limit
      for (let i = 0; i < 5; i++) {
        const res = await app.request('/api/test')
        expect(res.status).toBe(200)
      }
    })

    it('should skip failed requests when skipFailedRequests is true', async () => {
      const app = new Hono()
      app.use('/api/*', rateLimiter({ limit: 2, windowMs: 60000, skipFailedRequests: true }))
      app.get('/api/success', (c) => c.text('ok'))
      app.get('/api/error', (c) => c.text('error', 500))

      // Failed requests should not count
      const errorRes1 = await app.request('/api/error')
      expect(errorRes1.status).toBe(500)

      const errorRes2 = await app.request('/api/error')
      expect(errorRes2.status).toBe(500)

      // Successful requests should still count
      const successRes1 = await app.request('/api/success')
      expect(successRes1.status).toBe(200)

      const successRes2 = await app.request('/api/success')
      expect(successRes2.status).toBe(200)

      // Third successful request should be rate limited
      const successRes3 = await app.request('/api/success')
      expect(successRes3.status).toBe(429)
    })

    it('should use deferred counting and only increment for non-skipped requests', async () => {
      const data = new Map<string, { count: number; resetTime: number }>()
      const incrementCalls: string[] = []
      const getCalls: string[] = []

      const customStore: RateLimitStore = {
        async get(key: string) {
          getCalls.push(key)
          return data.get(key)
        },
        async increment(key: string, windowMs: number) {
          incrementCalls.push(key)
          const now = Date.now()
          const entry = data.get(key)
          if (!entry || now > entry.resetTime) {
            const newEntry = { count: 1, resetTime: now + windowMs }
            data.set(key, newEntry)
            return newEntry
          }
          entry.count++
          return entry
        },
        async decrement(key: string) {
          // With deferred counting, decrement should not be called
          const entry = data.get(key)
          if (!entry) {
            return undefined
          }
          if (entry.count > 0) {
            entry.count--
          }
          return entry
        },
        async reset(key: string) {
          data.delete(key)
        },
      }

      const app = new Hono()
      app.use('/api/*', rateLimiter({ limit: 5, windowMs: 60000, skipSuccessfulRequests: true, store: customStore }))
      app.get('/api/test', (c) => c.text('ok'))

      // Make 3 successful requests
      await app.request('/api/test')
      await app.request('/api/test')
      await app.request('/api/test')

      // With deferred counting and skipSuccessfulRequests:
      // - get() is called to check current count before processing
      // - increment() is NOT called for successful requests (they are skipped)
      expect(getCalls.length).toBe(3)
      expect(incrementCalls.length).toBe(0)

      // Verify count is still 0 (no increments happened)
      const finalEntry = data.get('global')
      expect(finalEntry).toBeUndefined()

      // Additional requests should still succeed since count is 0
      const res = await app.request('/api/test')
      expect(res.status).toBe(200)
      expect(incrementCalls.length).toBe(0)
    })

    it('should only increment for failed requests when skipSuccessfulRequests is true', async () => {
      const data = new Map<string, { count: number; resetTime: number }>()
      const incrementCalls: string[] = []

      const customStore: RateLimitStore = {
        async get(key: string) {
          return data.get(key)
        },
        async increment(key: string, windowMs: number) {
          incrementCalls.push(key)
          const now = Date.now()
          const entry = data.get(key)
          if (!entry || now > entry.resetTime) {
            const newEntry = { count: 1, resetTime: now + windowMs }
            data.set(key, newEntry)
            return newEntry
          }
          entry.count++
          return entry
        },
        async decrement(key: string) {
          const entry = data.get(key)
          if (!entry) {
            return undefined
          }
          if (entry.count > 0) {
            entry.count--
          }
          return entry
        },
        async reset(key: string) {
          data.delete(key)
        },
      }

      const app = new Hono()
      app.use('/api/*', rateLimiter({ limit: 2, windowMs: 60000, skipSuccessfulRequests: true, store: customStore }))
      app.get('/api/success', (c) => c.text('ok'))
      app.get('/api/error', (c) => c.text('error', 500))

      // Successful requests should not increment
      await app.request('/api/success')
      await app.request('/api/success')
      expect(incrementCalls.length).toBe(0)

      // Failed requests should increment
      await app.request('/api/error')
      expect(incrementCalls.length).toBe(1)
      expect(data.get('global')?.count).toBe(1)

      await app.request('/api/error')
      expect(incrementCalls.length).toBe(2)
      expect(data.get('global')?.count).toBe(2)

      // Third failed request should be rate limited
      const res = await app.request('/api/error')
      expect(res.status).toBe(429)
    })
  })

  describe('Window expiration', () => {
    it('should reset count after window expires', async () => {
      vi.useFakeTimers()

      const app = new Hono()
      app.use('/api/*', rateLimiter({ limit: 1, windowMs: 1000 }))
      app.get('/api/test', (c) => c.text('ok'))

      const res1 = await app.request('/api/test')
      expect(res1.status).toBe(200)

      const res2 = await app.request('/api/test')
      expect(res2.status).toBe(429)

      // Advance time past the window
      vi.advanceTimersByTime(1100)

      const res3 = await app.request('/api/test')
      expect(res3.status).toBe(200)

      vi.useRealTimers()
    })
  })

  describe('Different routes', () => {
    it('should share rate limit across routes with default key generator', async () => {
      const app = new Hono()
      app.use('/api/*', rateLimiter({ limit: 2, windowMs: 60000 }))
      app.get('/api/route1', (c) => c.text('route1'))
      app.get('/api/route2', (c) => c.text('route2'))

      // Default key generator uses 'global' when no IP headers present
      // so all routes share the same limit
      const res1 = await app.request('/api/route1')
      expect(res1.status).toBe(200)

      const res2 = await app.request('/api/route2')
      expect(res2.status).toBe(200)

      // Third request to any route should be rate limited
      const res3 = await app.request('/api/route1')
      expect(res3.status).toBe(429)
    })

    it('should rate limit routes independently with x-forwarded-for header', async () => {
      const app = new Hono()
      app.use('/api/*', rateLimiter({ limit: 1, windowMs: 60000 }))
      app.get('/api/route1', (c) => c.text('route1'))
      app.get('/api/route2', (c) => c.text('route2'))

      // Requests from IP1 are rate limited independently
      const res1 = await app.request('/api/route1', {
        headers: { 'x-forwarded-for': '192.168.1.1' },
      })
      expect(res1.status).toBe(200)

      const res2 = await app.request('/api/route1', {
        headers: { 'x-forwarded-for': '192.168.1.1' },
      })
      expect(res2.status).toBe(429)

      // Requests from IP2 have their own limit
      const res3 = await app.request('/api/route2', {
        headers: { 'x-forwarded-for': '192.168.1.2' },
      })
      expect(res3.status).toBe(200)
    })

    it('should share limit across routes with custom key generator', async () => {
      const app = new Hono()
      app.use(
        '/api/*',
        rateLimiter({
          limit: 2,
          windowMs: 60000,
          keyGenerator: () => 'shared-key',
        })
      )
      app.get('/api/route1', (c) => c.text('route1'))
      app.get('/api/route2', (c) => c.text('route2'))

      const res1 = await app.request('/api/route1')
      expect(res1.status).toBe(200)

      const res2 = await app.request('/api/route2')
      expect(res2.status).toBe(200)

      // Third request to either route should be rate limited
      const res3 = await app.request('/api/route1')
      expect(res3.status).toBe(429)
    })
  })

  describe('Does not affect routes without middleware', () => {
    it('should not rate limit routes without the middleware', async () => {
      const app = new Hono()
      app.use('/api/*', rateLimiter({ limit: 1, windowMs: 60000 }))
      app.get('/api/test', (c) => c.text('api'))
      app.get('/public/test', (c) => c.text('public'))

      // API route should be rate limited
      await app.request('/api/test')
      const res1 = await app.request('/api/test')
      expect(res1.status).toBe(429)

      // Public route should not be rate limited
      for (let i = 0; i < 10; i++) {
        const res = await app.request('/public/test')
        expect(res.status).toBe(200)
      }
    })
  })

  describe('Standard headers option', () => {
    it('should not set rate limit headers when standardHeaders is false', async () => {
      const app = new Hono()
      app.use('/api/*', rateLimiter({ limit: 5, windowMs: 60000, standardHeaders: false }))
      app.get('/api/test', (c) => c.text('ok'))

      const res = await app.request('/api/test')
      expect(res.status).toBe(200)
      expect(res.headers.get('X-RateLimit-Limit')).toBeNull()
      expect(res.headers.get('X-RateLimit-Remaining')).toBeNull()
      expect(res.headers.get('X-RateLimit-Reset')).toBeNull()
    })

    it('should not set Retry-After header when rate limited with standardHeaders false', async () => {
      const app = new Hono()
      app.use('/api/*', rateLimiter({ limit: 1, windowMs: 60000, standardHeaders: false }))
      app.get('/api/test', (c) => c.text('ok'))

      await app.request('/api/test')
      const res = await app.request('/api/test')

      expect(res.status).toBe(429)
      expect(res.headers.get('Retry-After')).toBeNull()
    })
  })

  describe('Memory store with maxKeys', () => {
    it('should evict oldest entries when maxKeys is exceeded', async () => {
      const store = new MemoryStore({ maxKeys: 3, cleanupIntervalMs: 0 })

      // Add 3 entries
      await store.increment('key1', 60000)
      await store.increment('key2', 60000)
      await store.increment('key3', 60000)

      // Add 4th entry, should evict oldest (key1)
      await store.increment('key4', 60000)

      const key1Entry = await store.get('key1')
      expect(key1Entry).toBeUndefined()

      const key4Entry = await store.get('key4')
      expect(key4Entry).toBeDefined()

      store.shutdown()
    })

    it('should track lastAccess and evict based on it', async () => {
      const store = new MemoryStore({ maxKeys: 2, cleanupIntervalMs: 0 })

      await store.increment('key1', 60000)
      // Small delay to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 10))
      await store.increment('key2', 60000)

      // Access key1 to update lastAccess - now key1 is most recent
      await new Promise((resolve) => setTimeout(resolve, 10))
      await store.get('key1')

      // Add key3, should evict key2 (oldest lastAccess)
      await new Promise((resolve) => setTimeout(resolve, 10))
      await store.increment('key3', 60000)

      const key1Entry = await store.get('key1')
      expect(key1Entry).toBeDefined()

      const key2Entry = await store.get('key2')
      expect(key2Entry).toBeUndefined()

      const key3Entry = await store.get('key3')
      expect(key3Entry).toBeDefined()

      store.shutdown()
    })
  })

  describe('Concurrent requests', () => {
    it('should enforce rate limit when 10 requests fired concurrently with limit of 5', async () => {
      const app = new Hono()
      app.use('/api/*', rateLimiter({ limit: 5, windowMs: 60000 }))
      app.get('/api/test', async (c) => {
        await new Promise((resolve) => setTimeout(resolve, 1))
        return c.text('ok')
      })

      const requests = Array.from({ length: 10 }, () =>
        app.request('/api/test', {
          headers: { 'x-forwarded-for': '192.168.1.1' },
        })
      )

      const responses = await Promise.all(requests)
      const successCount = responses.filter((r) => r.status === 200).length
      const rateLimitedCount = responses.filter((r) => r.status === 429).length

      // Each request increments before checking limit, so with concurrent execution
      // all 10 may increment (1→10), then all check count > 5, resulting in all being blocked.
      // Or they may be sequentialized by the runtime, giving exactly 5 success + 5 blocked.
      // The only guarantee: at most 5 succeed, at least 5 blocked, total is 10.
      expect(successCount).toBeLessThanOrEqual(5)
      expect(rateLimitedCount).toBeGreaterThanOrEqual(5)
      expect(successCount + rateLimitedCount).toBe(10)

      responses.forEach((res) => {
        expect(res.headers.get('X-RateLimit-Limit')).toBe('5')
        expect(res.headers.get('X-RateLimit-Remaining')).not.toBeNull()
        expect(res.headers.get('X-RateLimit-Reset')).not.toBeNull()
      })
    })

    it('should isolate rate limits per IP when 4 requests from each of 2 IPs with limit of 2', async () => {
      const app = new Hono()
      app.use('/api/*', rateLimiter({ limit: 2, windowMs: 60000 }))
      app.get('/api/test', (c) => c.text('ok'))

      const ip1Requests = Array.from({ length: 4 }, () =>
        app.request('/api/test', {
          headers: { 'x-forwarded-for': '192.168.1.1' },
        })
      )
      const ip2Requests = Array.from({ length: 4 }, () =>
        app.request('/api/test', {
          headers: { 'x-forwarded-for': '192.168.1.2' },
        })
      )

      const allResponses = await Promise.all([...ip1Requests, ...ip2Requests])
      const ip1Responses = allResponses.slice(0, 4)
      const ip2Responses = allResponses.slice(4)

      const ip1Success = ip1Responses.filter((r) => r.status === 200).length
      const ip1RateLimited = ip1Responses.filter((r) => r.status === 429).length
      const ip2Success = ip2Responses.filter((r) => r.status === 200).length
      const ip2RateLimited = ip2Responses.filter((r) => r.status === 429).length

      // Each IP's requests increment independently. With limit=2:
      // IP1: at most 2 succeed, at least 2 blocked
      // IP2: at most 2 succeed, at least 2 blocked
      expect(ip1Success).toBeLessThanOrEqual(2)
      expect(ip1RateLimited).toBeGreaterThanOrEqual(2)
      expect(ip1Success + ip1RateLimited).toBe(4)

      expect(ip2Success).toBeLessThanOrEqual(2)
      expect(ip2RateLimited).toBeGreaterThanOrEqual(2)
      expect(ip2Success + ip2RateLimited).toBe(4)
    })

    it('should enforce exact rate limit when 5 sequential requests with limit of 3', async () => {
      const app = new Hono()
      app.use('/api/*', rateLimiter({ limit: 3, windowMs: 60000 }))
      app.get('/api/test', (c) => c.text('ok'))

      const responses = []
      for (let i = 0; i < 5; i++) {
        const res = await app.request('/api/test', {
          headers: { 'x-forwarded-for': '192.168.1.1' },
        })
        responses.push(res)
      }

      // Sequential requests are processed one at a time:
      // Request 1: count=1, allowed (1 ≤ 3)
      // Request 2: count=2, allowed (2 ≤ 3)
      // Request 3: count=3, allowed (3 ≤ 3)
      // Request 4: count=4, blocked (4 > 3)
      // Request 5: count=5, blocked (5 > 3)
      expect(responses[0].status).toBe(200)
      expect(responses[1].status).toBe(200)
      expect(responses[2].status).toBe(200)
      expect(responses[3].status).toBe(429)
      expect(responses[4].status).toBe(429)
    })
  })
})
