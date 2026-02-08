/**
 * @module
 * Rate Limit Middleware for Hono.
 */

import type { Context } from '../../context'
import { HTTPException } from '../../http-exception'
import type { MiddlewareHandler } from '../../types'

/**
 * Function to generate a unique key for rate limiting.
 * Typically based on IP address or user ID.
 */
export type KeyGenerator = (c: Context) => string | Promise<string>

/**
 * Custom handler for rate limit exceeded.
 */
export type RateLimitHandler = (c: Context) => Response | Promise<Response>

/**
 * Store interface for rate limit data.
 *
 * **Thread Safety:**
 * Implementations MUST handle concurrent access atomically to ensure correctness
 * in multi-request scenarios. All methods should be safe to call concurrently
 * from multiple requests. Operations like increment/decrement must be atomic
 * to prevent race conditions where multiple requests could bypass the rate limit.
 *
 * For example, if two requests check the count simultaneously before incrementing,
 * both might see count=4 (under a limit of 5) and both increment, resulting in
 * count=6, exceeding the limit. Proper implementations use atomic operations,
 * locks, or transactions to prevent this.
 *
 * **Note on single-threaded JavaScript environments:**
 * In single-threaded environments like Node.js, Deno, or Bun, the default
 * MemoryStore is inherently safe because JavaScript's event loop processes
 * one operation at a time. However, external or distributed stores (Redis,
 * databases, etc.) require explicit atomicity guarantees since multiple
 * server instances may access the store concurrently. Use atomic operations
 * like Redis INCR or database transactions for such implementations.
 */
export interface RateLimitStore {
  /**
   * Get the current count and reset time for a key.
   * @param key - The rate limit key
   * @returns The count and reset time, or undefined if not found
   */
  get(key: string): Promise<{ count: number; resetTime: number } | undefined>

  /**
   * Increment the count for a key atomically.
   * @param key - The rate limit key
   * @param windowMs - The window duration in milliseconds
   * @returns The new count and reset time
   */
  increment(key: string, windowMs: number): Promise<{ count: number; resetTime: number }>

  /**
   * Decrement the count for a key atomically.
   * @param key - The rate limit key
   * @returns The new count and reset time, or undefined if not found
   */
  decrement(key: string): Promise<{ count: number; resetTime: number } | undefined>

  /**
   * Reset the count for a key.
   * @param key - The rate limit key
   */
  reset(key: string): Promise<void>
}

/**
 * Options for the in-memory store.
 */
export interface MemoryStoreOptions {
  /**
   * Maximum number of keys to store before evicting oldest entries.
   * Prevents unbounded memory growth under attack.
   * @default 5000
   */
  maxKeys?: number

  /**
   * Interval in milliseconds for cleaning up expired entries.
   * Set to 0 to disable periodic cleanup.
   * @default 60000 (1 minute)
   */
  cleanupIntervalMs?: number
}

/**
 * Options for the rate limit middleware.
 */
export interface RateLimitOptions {
  /**
   * The time window in milliseconds.
   * @default 60000 (1 minute)
   */
  windowMs?: number

  /**
   * Maximum number of requests allowed within the window.
   * @default 60
   */
  limit?: number

  /**
   * Function to generate a unique key for rate limiting.
   * Defaults to using x-forwarded-for or x-real-ip headers, with a global fallback.
   */
  keyGenerator?: KeyGenerator

  /**
   * Custom handler when rate limit is exceeded.
   * Defaults to throwing a 429 HTTPException.
   */
  handler?: RateLimitHandler

  /**
   * Custom store for rate limit data.
   * Defaults to an in-memory store.
   */
  store?: RateLimitStore

  /**
   * Whether to skip rate limiting for successful requests.
   * @default false
   */
  skipSuccessfulRequests?: boolean

  /**
   * Whether to skip rate limiting for failed requests (status >= 400).
   * @default false
   */
  skipFailedRequests?: boolean

  /**
   * Whether to include standard rate limit headers (X-RateLimit-*).
   * Set to false for performance-sensitive endpoints.
   * @default true
   */
  standardHeaders?: boolean
}

/**
 * Default in-memory store for rate limiting with LRU eviction and periodic cleanup.
 *
 * Uses Map's insertion-order iteration for O(1) eviction of oldest entries.
 * When an entry is accessed, it is deleted and re-inserted to move it to the end,
 * maintaining LRU order. This avoids the O(n) scan required by timestamp-based LRU.
 */
export class MemoryStore implements RateLimitStore {
  private cache: Map<string, { count: number; resetTime: number }> = new Map()
  private maxKeys: number
  private cleanupInterval?: ReturnType<typeof setInterval>

  constructor(options: MemoryStoreOptions = {}) {
    this.maxKeys = options.maxKeys ?? 5000

    const cleanupIntervalMs = options.cleanupIntervalMs ?? 60000
    if (cleanupIntervalMs > 0) {
      this.cleanupInterval = setInterval(() => {
        this.cleanupExpired()
      }, cleanupIntervalMs)

      // Prevent the interval from keeping the process alive
      if (typeof this.cleanupInterval === 'object' && 'unref' in this.cleanupInterval) {
        this.cleanupInterval.unref()
      }
    }
  }

  /**
   * Clean up expired entries proactively.
   */
  private cleanupExpired(): void {
    const now = Date.now()
    const keysToDelete: string[] = []

    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.resetTime) {
        keysToDelete.push(key)
      }
    }

    for (const key of keysToDelete) {
      this.cache.delete(key)
    }
  }

  /**
   * Evict oldest entry when maxKeys is exceeded. O(1) operation using Map's
   * insertion-order iteration - the first key is the least recently used.
   */
  private evictOldest(): void {
    if (this.cache.size < this.maxKeys) {
      return
    }

    // Map.keys().next() returns the first (oldest) key in O(1)
    const oldestKey = this.cache.keys().next().value
    if (oldestKey !== undefined) {
      this.cache.delete(oldestKey)
    }
  }

  /**
   * Move a key to the end of the Map to mark it as most recently used.
   * This is O(1) for both delete and set operations.
   */
  private touch(key: string, entry: { count: number; resetTime: number }): void {
    this.cache.delete(key)
    this.cache.set(key, entry)
  }

  async get(key: string): Promise<{ count: number; resetTime: number } | undefined> {
    const entry = this.cache.get(key)
    if (!entry) {
      return undefined
    }

    const now = Date.now()
    if (now > entry.resetTime) {
      this.cache.delete(key)
      return undefined
    }

    // Move to end to mark as recently used
    this.touch(key, entry)
    return { count: entry.count, resetTime: entry.resetTime }
  }

  async increment(key: string, windowMs: number): Promise<{ count: number; resetTime: number }> {
    const now = Date.now()
    const entry = this.cache.get(key)

    if (!entry || now > entry.resetTime) {
      // If adding a new key, check if we need to evict
      if (!this.cache.has(key)) {
        this.evictOldest()
      }
      const newEntry = { count: 1, resetTime: now + windowMs }
      this.cache.set(key, newEntry)
      return { count: newEntry.count, resetTime: newEntry.resetTime }
    }

    entry.count++
    // Move to end to mark as recently used
    this.touch(key, entry)
    return { count: entry.count, resetTime: entry.resetTime }
  }

  async decrement(key: string): Promise<{ count: number; resetTime: number } | undefined> {
    const entry = this.cache.get(key)
    if (!entry) {
      return undefined
    }

    const now = Date.now()
    if (now > entry.resetTime) {
      this.cache.delete(key)
      return undefined
    }

    if (entry.count > 0) {
      entry.count--
    }
    // Move to end to mark as recently used
    this.touch(key, entry)
    return { count: entry.count, resetTime: entry.resetTime }
  }

  async reset(key: string): Promise<void> {
    this.cache.delete(key)
  }

  /**
   * Stop the cleanup interval. Call this when shutting down.
   */
  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
    }
  }
}

const defaultKeyGenerator: KeyGenerator = (c) => {
  // Try x-forwarded-for first (most common proxy header)
  const forwarded = c.req.header('x-forwarded-for')
  if (forwarded) {
    // Use the first IP if multiple are present
    const firstIp = forwarded.split(',')[0]?.trim()
    if (firstIp) {
      return firstIp
    }
  }

  // Fall back to x-real-ip
  const realIp = c.req.header('x-real-ip')
  if (realIp) {
    return realIp
  }

  // No IP headers present, use global fallback
  return 'global'
}

const defaultHandler: RateLimitHandler = (c) => {
  const res = new Response('Too Many Requests', {
    status: 429,
    headers: {
      'Content-Type': 'text/plain',
    },
  })
  throw new HTTPException(429, { res })
}

/**
 * Rate Limit Middleware for Hono.
 *
 * @see {@link https://hono.dev/docs/middleware/builtin/rate-limit}
 *
 * @param {RateLimitOptions} [options] - The options for the rate limit middleware.
 * @param {number} [options.windowMs=60000] - The time window in milliseconds.
 * @param {number} [options.limit=60] - Maximum number of requests allowed within the window.
 * @param {KeyGenerator} [options.keyGenerator] - Function to generate a unique key for rate limiting.
 * @param {RateLimitHandler} [options.handler] - Custom handler when rate limit is exceeded.
 * @param {RateLimitStore} [options.store] - Custom store for rate limit data.
 * @param {boolean} [options.skipSuccessfulRequests=false] - Whether to skip rate limiting for successful requests.
 * @param {boolean} [options.skipFailedRequests=false] - Whether to skip rate limiting for failed requests.
 * @returns {MiddlewareHandler} The middleware handler function.
 *
 * @example
 * ```ts
 * const app = new Hono()
 *
 * // Basic usage - 60 requests per minute
 * app.use('/api/*', rateLimiter())
 *
 * // Custom configuration
 * app.use(
 *   '/api/*',
 *   rateLimiter({
 *     windowMs: 15 * 60 * 1000, // 15 minutes
 *     limit: 100, // limit each key to 100 requests per window
 *     keyGenerator: (c) => c.req.header('x-forwarded-for') ?? 'anonymous',
 *     handler: (c) => c.text('Rate limit exceeded', 429),
 *   })
 * )
 * ```
 */
export const rateLimiter = (options: RateLimitOptions = {}): MiddlewareHandler => {
  const {
    windowMs = 60 * 1000,
    limit = 60,
    keyGenerator = defaultKeyGenerator,
    handler = defaultHandler,
    store = new MemoryStore(),
    skipSuccessfulRequests = false,
    skipFailedRequests = false,
    standardHeaders = true,
  } = options

  // Determine if we need to use deferred counting (increment after response)
  const shouldDeferCounting = skipSuccessfulRequests || skipFailedRequests

  return async function rateLimiter(c, next) {
    const key = await keyGenerator(c)

    if (shouldDeferCounting) {
      // Deferred counting: get current count without incrementing,
      // then increment only if the request should be counted
      const current = await store.get(key)
      const currentCount = current?.count ?? 0
      const resetTime = current?.resetTime ?? Date.now() + windowMs

      // Set rate limit headers if enabled
      if (standardHeaders) {
        const remaining = Math.max(0, limit - currentCount)
        c.header('X-RateLimit-Limit', limit.toString())
        c.header('X-RateLimit-Remaining', remaining.toString())
        c.header('X-RateLimit-Reset', Math.ceil(resetTime / 1000).toString())
      }

      // Check if already over limit
      if (currentCount >= limit) {
        if (standardHeaders) {
          c.header('Retry-After', Math.ceil((resetTime - Date.now()) / 1000).toString())
        }
        return handler(c)
      }

      await next()

      // Only increment if this request type should be counted
      const shouldSkip =
        (skipSuccessfulRequests && c.res.status < 400) ||
        (skipFailedRequests && c.res.status >= 400)

      if (!shouldSkip) {
        await store.increment(key, windowMs)
      }
    } else {
      // Standard counting: increment immediately
      const { count, resetTime } = await store.increment(key, windowMs)

      // Set rate limit headers if enabled
      if (standardHeaders) {
        const remaining = Math.max(0, limit - count)
        c.header('X-RateLimit-Limit', limit.toString())
        c.header('X-RateLimit-Remaining', remaining.toString())
        c.header('X-RateLimit-Reset', Math.ceil(resetTime / 1000).toString())
      }

      if (count > limit) {
        if (standardHeaders) {
          c.header('Retry-After', Math.ceil((resetTime - Date.now()) / 1000).toString())
        }
        return handler(c)
      }

      await next()
    }
  }
}
