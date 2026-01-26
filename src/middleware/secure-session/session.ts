/**
 * @module
 * Secure Session Middleware for Hono.
 */

import type { Context } from '../../context'
import { getCookie, setCookie, deleteCookie } from '../../helper/cookie'
import type { MiddlewareHandler } from '../../types'
import type { CookiePrefixOptions } from '../../utils/cookie'
import { seal, unseal } from './crypto'
import type { SecretConfig } from './crypto'

export type { SecretConfig }

/**
 * Cookie options for session storage
 */
export interface SessionCookieOptions {
  /** Cookie name (default: 'session') */
  name?: string
  /** Cookie path (default: '/') */
  path?: string
  /** Cookie domain */
  domain?: string
  /** Secure flag - only send over HTTPS (default: true) */
  secure?: boolean
  /** HttpOnly flag - prevent JavaScript access (default: true) */
  httpOnly?: boolean
  /** SameSite attribute for CSRF protection (default: 'Lax') */
  sameSite?: 'Strict' | 'Lax' | 'None'
  /** Cookie prefix for additional security ('host' or 'secure') */
  prefix?: CookiePrefixOptions
  /** Partitioned cookie support (CHIPS) */
  partitioned?: boolean
}

/**
 * Options for the secure session middleware
 */
export interface SecureSessionOptions<T extends SessionData = SessionData> {
  /**
   * Secret(s) for encryption - required.
   * - Single string: Must be at least 32 characters
   * - Array of strings: First element encrypts, all elements decrypt
   *   - secrets[0] is used for new seals
   *   - All secrets are tried for unsealing (first to last)
   *
   * @example
   * // Single secret
   * secret: 'my-32-character-minimum-secret!!'
   *
   * @example
   * // Secret rotation (new secret first, old secrets after)
   * secret: ['new-secret-32-chars-minimum!!!!!', 'old-secret-32-chars-minimum!!!!!']
   */
  secret: SecretConfig

  /**
   * Session time-to-live in seconds (default: 86400 = 24 hours)
   */
  ttl?: number

  /**
   * Cookie configuration options
   */
  cookie?: SessionCookieOptions

  /**
   * Maximum cookie size in bytes (default: 3584 = 3.5KB)
   * If exceeded, an error is thrown. The 4KB browser limit is absolute.
   */
  cookieSizeLimit?: number

  /**
   * Default session data for new sessions
   */
  defaultData?: Partial<T>
}

/**
 * Error thrown when session cookie size exceeds the limit
 */
export class SessionSizeError extends Error {
  readonly size: number
  readonly limit: number
  readonly reduction: number

  constructor(size: number, limit: number) {
    const reduction = size - limit
    super(
      `Session cookie size (${size} bytes) exceeds limit (${limit} bytes). ` +
        `Reduce session data by ${reduction} bytes. ` +
        `Browser cookie limit is 4KB. Store less data in the session or use external storage.`
    )
    this.name = 'SessionSizeError'
    this.size = size
    this.limit = limit
    this.reduction = reduction
  }
}

/**
 * Error thrown when session is accessed without middleware being applied
 */
export class SessionNotFoundError extends Error {
  constructor() {
    super(
      `Session not found. The secureSession() middleware must be applied before accessing the session.\n\n` +
        `Example:\n` +
        `  import { Hono } from 'hono'\n` +
        `  import { secureSession } from 'hono/secure-session'\n\n` +
        `  const app = new Hono()\n` +
        `  app.use('*', secureSession({ secret: 'your-32-char-secret-here!!!!!!!!' }))\n`
    )
    this.name = 'SessionNotFoundError'
  }
}

/**
 * Internal sealed payload structure
 */
interface SealedPayload<T> {
  /** Session data */
  d: T
  /** Created at timestamp (ms) */
  c: number
  /** Expires at timestamp (ms) */
  e: number
}

/**
 * Base session data type constraint
 */
export type SessionData = Record<string, unknown>

/**
 * Reserved property names that cannot be used as session data keys
 */
type ReservedKeys =
  | 'isNew'
  | 'isModified'
  | 'isDestroyed'
  | 'createdAt'
  | 'expiresAt'
  | 'destroy'
  | 'save'
  | 'getData'
  | 'get'
  | 'set'
  | 'delete'
  | 'has'

/**
 * Session interface exposed to application code.
 * Use get/set/delete/has methods for type-safe property access.
 */
export interface Session<T extends SessionData = SessionData> {
  /** Mark session as destroyed (will clear cookie on response) */
  destroy(): void

  /** Explicitly save session (usually auto-saved on response) */
  save(): Promise<void>

  /** Check if this is a new session (no existing cookie) */
  readonly isNew: boolean

  /** Check if session has been modified */
  readonly isModified: boolean

  /** Check if session is destroyed */
  readonly isDestroyed: boolean

  /** Get session creation timestamp */
  readonly createdAt: Date

  /** Get session expiration timestamp */
  readonly expiresAt: Date

  /** Get a copy of all session data */
  getData(): T

  /**
   * Get a session property value
   * @param key - Property name
   * @returns Property value or undefined
   */
  get<K extends keyof T>(key: K): T[K]
  get(key: string): unknown

  /**
   * Set a session property value
   * @param key - Property name (cannot be a reserved key)
   * @param value - Property value
   */
  set<K extends Exclude<keyof T, ReservedKeys>>(key: K, value: T[K]): void
  set(key: Exclude<string, ReservedKeys>, value: unknown): void

  /**
   * Delete a session property
   * @param key - Property name
   * @returns true if property existed and was deleted
   */
  delete<K extends keyof T>(key: K): boolean
  delete(key: string): boolean

  /**
   * Check if a session property exists
   * @param key - Property name
   * @returns true if the property exists in the session data
   */
  has<K extends keyof T>(key: K): boolean
  has(key: string): boolean
}

/**
 * Variables added to Hono context by this middleware
 */
export type SecureSessionVariables<T extends SessionData = SessionData> = {
  session: Session<T>
}

// Default values
const DEFAULT_COOKIE_NAME = 'session'
const DEFAULT_TTL = 86400 // 24 hours in seconds
const DEFAULT_COOKIE_SIZE_LIMIT = 3584 // 3.5KB - leave room for cookie overhead
const ABSOLUTE_COOKIE_LIMIT = 4096 // 4KB absolute browser limit
const MIN_SECRET_LENGTH = 32

/**
 * Reserved session property names
 */
const RESERVED_KEYS = new Set<string>([
  'isNew',
  'isModified',
  'isDestroyed',
  'createdAt',
  'expiresAt',
  'destroy',
  'save',
  'getData',
  'get',
  'set',
  'delete',
  'has',
])

/**
 * Session implementation with explicit get/set/delete/has methods
 */
function createSession<T extends SessionData>(
  data: T,
  createdAt: Date,
  expiresAt: Date,
  isNew: boolean,
  saveHandler: () => Promise<void>
): Session<T> {
  let _isModified = false
  let _isDestroyed = false
  const _data = { ...data } as T

  function getValue<K extends keyof T>(key: K): T[K]
  function getValue(key: string): unknown
  function getValue(key: string): unknown {
    return _data[key as keyof T]
  }

  const session: Session<T> = {
    get isNew() {
      return isNew
    },
    get isModified() {
      return _isModified
    },
    get isDestroyed() {
      return _isDestroyed
    },
    get createdAt() {
      return createdAt
    },
    get expiresAt() {
      return expiresAt
    },
    destroy() {
      _isDestroyed = true
      _isModified = true
    },
    save: saveHandler,
    getData() {
      return { ..._data } as T
    },
    get: getValue,
    set(key: string, value: unknown): void {
      if (RESERVED_KEYS.has(key)) {
        throw new Error(`Cannot set reserved session property: ${key}`)
      }
      _isModified = true
      ;(_data as SessionData)[key] = value
    },
    delete(key: string): boolean {
      if (key in _data) {
        _isModified = true
        delete (_data as SessionData)[key]
        return true
      }
      return false
    },
    has(key: string): boolean {
      return key in _data
    },
  }

  // Also support property access via Proxy for backwards compatibility
  return new Proxy(session, {
    get(target, prop) {
      // Handle built-in methods and properties first
      if (prop in target) {
        const value = target[prop as keyof typeof target]
        if (typeof value === 'function') {
          return (value as (...args: unknown[]) => unknown).bind(target)
        }
        return value
      }
      // Access data property via get method
      if (typeof prop === 'string') {
        return _data[prop as keyof T]
      }
      return undefined
    },
    set(_target, prop, value) {
      // Prevent modification of reserved properties
      if (typeof prop === 'string' && RESERVED_KEYS.has(prop)) {
        return false
      }
      // Mark as modified and set data
      if (typeof prop === 'string') {
        _isModified = true
        ;(_data as SessionData)[prop] = value
        return true
      }
      return false
    },
    deleteProperty(_target, prop) {
      if (typeof prop === 'string' && prop in _data) {
        _isModified = true
        delete (_data as SessionData)[prop]
        return true
      }
      return false
    },
    has(target, prop) {
      return prop in target || (typeof prop === 'string' && prop in _data)
    },
    ownKeys() {
      return [
        ...Object.keys(_data),
        'isNew',
        'isModified',
        'isDestroyed',
        'createdAt',
        'expiresAt',
        'destroy',
        'save',
        'getData',
        'get',
        'set',
        'delete',
        'has',
      ]
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === 'string' && prop in _data) {
        return {
          configurable: true,
          enumerable: true,
          value: _data[prop as keyof T],
          writable: true,
        }
      }
      if (prop in target) {
        return Object.getOwnPropertyDescriptor(target, prop)
      }
      return undefined
    },
  })
}

/**
 * Validate secret configuration
 */
function validateSecrets(secrets: SecretConfig): void {
  const secretArray = typeof secrets === 'string' ? [secrets] : secrets

  if (secretArray.length === 0) {
    throw new Error('Secure session middleware requires at least one secret')
  }

  for (let i = 0; i < secretArray.length; i++) {
    const secret = secretArray[i]
    if (!secret || typeof secret !== 'string') {
      throw new Error(`Secret at index ${i} is invalid`)
    }
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `Secret at index ${i} is too short. Minimum ${MIN_SECRET_LENGTH} characters required for security.`
      )
    }
  }
}

/**
 * Get the session from context with type safety.
 * Throws a SessionNotFoundError if the secure session middleware is not applied.
 *
 * @param c - Hono context
 * @returns The typed session object
 * @throws SessionNotFoundError if middleware is not applied
 *
 * @example
 * ```ts
 * interface MySession {
 *   userId?: number
 *   cart?: string[]
 * }
 *
 * app.get('/profile', (c) => {
 *   const session = getSession<MySession>(c)
 *   return c.json({ userId: session.get('userId') })
 * })
 * ```
 */
export function getSession<T extends SessionData = SessionData>(c: Context): Session<T> {
  const session = c.get('session')
  if (!session) {
    throw new SessionNotFoundError()
  }
  return session as Session<T>
}

/**
 * Secure Session Middleware for Hono
 *
 * Provides encrypted, stateless session management using signed and encrypted cookies.
 * All session data is stored in a single cookie encrypted with AES-256-GCM.
 *
 * @see {@link https://hono.dev/docs/middleware/builtin/secure-session}
 *
 * @param options - Configuration options
 * @returns Middleware handler
 *
 * @example
 * ```ts
 * import { Hono } from 'hono'
 * import { secureSession, getSession } from 'hono/secure-session'
 *
 * interface MySession {
 *   userId?: number
 *   name?: string
 * }
 *
 * const app = new Hono()
 *
 * app.use('*', secureSession<MySession>({
 *   secret: process.env.SESSION_SECRET!, // min 32 chars
 *   ttl: 3600 // 1 hour
 * }))
 *
 * app.get('/login', (c) => {
 *   const session = getSession<MySession>(c)
 *   session.set('userId', 1)
 *   session.set('name', 'Alice')
 *   return c.json({ success: true })
 * })
 *
 * app.get('/profile', (c) => {
 *   const session = getSession<MySession>(c)
 *   const userId = session.get('userId')
 *   if (!userId) {
 *     return c.json({ error: 'Not logged in' }, 401)
 *   }
 *   return c.json({ userId, name: session.get('name') })
 * })
 *
 * app.post('/logout', (c) => {
 *   getSession(c).destroy()
 *   return c.json({ success: true })
 * })
 * ```
 *
 * @example
 * ```ts
 * // With secret rotation (new secret first)
 * app.use('*', secureSession({
 *   secret: [
 *     'new-secret-that-is-at-least-32-chars',
 *     'old-secret-that-is-at-least-32-chars'
 *   ]
 * }))
 * ```
 */
export const secureSession = <T extends SessionData = SessionData>(
  options: SecureSessionOptions<T>
): MiddlewareHandler => {
  // Validate required options
  if (!options.secret) {
    throw new Error('Secure session middleware requires a "secret" option')
  }

  validateSecrets(options.secret)

  // Validate crypto availability
  if (!crypto.subtle?.encrypt) {
    throw new Error(
      'Web Crypto API (crypto.subtle) is required but not available. ' +
        'Ensure you are running in a secure context (HTTPS) or a supported runtime.'
    )
  }

  // Extract and merge options with defaults
  const cookieName = options.cookie?.name ?? DEFAULT_COOKIE_NAME
  const ttl = options.ttl ?? DEFAULT_TTL
  const sizeLimit = Math.min(options.cookieSizeLimit ?? DEFAULT_COOKIE_SIZE_LIMIT, ABSOLUTE_COOKIE_LIMIT)

  const cookieOptions: SessionCookieOptions = {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    ...options.cookie,
  }

  return async function secureSession(ctx: Context, next) {
    let sessionData: T = (options.defaultData ? { ...options.defaultData } : {}) as T
    let isNew = true
    let createdAt = new Date()
    let expiresAt = new Date(Date.now() + ttl * 1000)
    let needsRefresh = false

    // Try to load existing session from cookie
    const existingCookie = getCookie(ctx, cookieName, cookieOptions.prefix)

    if (existingCookie) {
      try {
        const { payload, keyIndex } = await unseal<SealedPayload<T>>(existingCookie, options.secret)

        // Check expiration
        if (payload.e > Date.now()) {
          sessionData = payload.d
          createdAt = new Date(payload.c)
          expiresAt = new Date(payload.e)
          isNew = false

          // Refresh if past half TTL to ensure smooth key rotation
          const halfwayPoint = payload.c + (payload.e - payload.c) / 2
          if (Date.now() > halfwayPoint) {
            needsRefresh = true
          }

          // Also refresh if sealed with an old key (not index 0)
          if (keyIndex !== 0) {
            needsRefresh = true
          }
        }
      } catch {
        // Invalid or expired session - start fresh
        // Silently ignore errors to avoid leaking information
      }
    }

    // Track if save is pending
    let pendingSave = false

    // Create save handler
    const saveSession = async (): Promise<void> => {
      if (pendingSave) {
        return
      }
      pendingSave = true

      try {
        if (session.isDestroyed) {
          deleteCookie(ctx, cookieName, {
            path: cookieOptions.path,
            domain: cookieOptions.domain,
            prefix: cookieOptions.prefix,
          })
          return
        }

        const payload: SealedPayload<T> = {
          d: session.getData(),
          c: createdAt.getTime(),
          e: expiresAt.getTime(),
        }

        const { sealed } = await seal(payload, options.secret)

        // Check cookie size - throw error if exceeded
        const encodedSize = sealed.length
        if (encodedSize > sizeLimit) {
          throw new SessionSizeError(encodedSize, sizeLimit)
        }

        // Calculate maxAge from remaining TTL
        const maxAge = Math.floor((expiresAt.getTime() - Date.now()) / 1000)

        setCookie(ctx, cookieName, sealed, {
          path: cookieOptions.path,
          domain: cookieOptions.domain,
          secure: cookieOptions.secure,
          httpOnly: cookieOptions.httpOnly,
          sameSite: cookieOptions.sameSite,
          maxAge: maxAge > 0 ? maxAge : undefined,
          prefix: cookieOptions.prefix,
          partitioned: cookieOptions.partitioned,
        })
      } finally {
        pendingSave = false
      }
    }

    // Create session instance
    const session = createSession<T>(sessionData, createdAt, expiresAt, isNew, saveSession)

    // Set session in context
    ctx.set('session', session)

    // Execute downstream handlers
    await next()

    // Auto-save session if modified or needs refresh
    if (session.isModified || needsRefresh) {
      await saveSession()
    }
  }
}
