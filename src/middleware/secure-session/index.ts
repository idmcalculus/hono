/**
 * @module
 * Secure Session Middleware for Hono.
 *
 * Provides encrypted, stateless session management using signed and encrypted cookies.
 * All session data is stored in a single cookie encrypted with AES-256-GCM.
 *
 * Features:
 * - AES-256-GCM authenticated encryption
 * - PBKDF2 key derivation (100,000 iterations)
 * - Automatic compression (deflate) when beneficial
 * - Secret rotation support (array format)
 * - Automatic session expiration
 * - Cookie size limit enforcement (throws error if exceeded)
 *
 * @example
 * ```ts
 * import { Hono } from 'hono'
 * import { secureSession, getSession } from 'hono/secure-session'
 *
 * interface MySession {
 *   userId?: number
 *   cart?: string[]
 * }
 *
 * const app = new Hono()
 *
 * app.use('*', secureSession<MySession>({
 *   secret: process.env.SESSION_SECRET!, // min 32 chars
 *   ttl: 3600 // 1 hour
 * }))
 *
 * app.get('/', (c) => {
 *   const session = getSession<MySession>(c)
 *   session.set('userId', 1)
 *   return c.json({ userId: session.get('userId') })
 * })
 * ```
 */

import type { SecureSessionVariables } from './session'
export type {
  SecureSessionVariables,
  SecureSessionOptions,
  Session,
  SessionCookieOptions,
  SecretConfig,
  SessionData,
} from './session'
export { secureSession, getSession, SessionSizeError, SessionNotFoundError } from './session'
export { seal, unseal, compress, decompress } from './crypto'
export type { SealResult, UnsealResult } from './crypto'
import type {} from '../..'

declare module '../..' {
  interface ContextVariableMap extends SecureSessionVariables {}
}
