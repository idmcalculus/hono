/**
 * @module
 * W3C Trace Context Middleware for Hono.
 */

import type { MiddlewareHandler } from '../../types'

export type TraceContextVariables = {
  traceId: string
  spanId: string
  parentSpanId?: string
  traceFlags: string
  traceparent: string
  tracestate?: string
}

export type TraceContextOptions = {
  generateSpanId?: () => string
  generateTraceId?: () => string
  flagsHandler?: (traceFlags: string) => string
  propagateResponse?: boolean
}

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

const generateId = (byteLength: number): string => {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return bytesToHex(bytes)
}

const TRACEPARENT_REGEX = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/
const ALL_ZEROS_32 = '0'.repeat(32)
const ALL_ZEROS_16 = '0'.repeat(16)

const parseTraceparent = (
  header: string
): { traceId: string; parentId: string; flags: string } | null => {
  const normalized = header.toLowerCase()
  const match = TRACEPARENT_REGEX.exec(normalized)
  if (!match) return null
  const [, traceId, parentId, flags] = match
  if (traceId === ALL_ZEROS_32 || parentId === ALL_ZEROS_16) return null
  return { traceId, parentId, flags }
}

/**
 * W3C Trace Context Middleware for Hono.
 *
 * Reads or generates W3C `traceparent`/`tracestate` headers, stores trace fields
 * as flat context variables, and propagates headers on the response.
 *
 * @see {@link https://www.w3.org/TR/trace-context/}
 *
 * @param {TraceContextOptions} [options] - Options for the trace context middleware.
 * @param {() => string} [options.generateSpanId] - Custom span ID generator (must return 16 hex chars).
 * @param {() => string} [options.generateTraceId] - Custom trace ID generator (must return 32 hex chars).
 * @param {(traceFlags: string) => string} [options.flagsHandler] - Transform the trace flags value.
 * @param {boolean} [options.propagateResponse=true] - Whether to set traceparent/tracestate response headers.
 * @returns {MiddlewareHandler} The middleware handler function.
 *
 * @example
 * ```ts
 * import { traceContext } from 'hono/trace-context'
 *
 * type Variables = TraceContextVariables
 * const app = new Hono<{ Variables: Variables }>()
 *
 * app.use(traceContext())
 * app.get('/', (c) => {
 *   const traceId = c.get('traceId')
 *   const spanId = c.get('spanId')
 *   return c.text(`traceId=${traceId} spanId=${spanId}`)
 * })
 * ```
 */
export const traceContext = ({
  generateSpanId = () => generateId(8),
  generateTraceId = () => generateId(16),
  flagsHandler,
  propagateResponse = true,
}: TraceContextOptions = {}): MiddlewareHandler => {
  return async function traceContext(c, next) {
    const incomingTraceparent = c.req.header('traceparent')
    const incomingTracestate = c.req.header('tracestate')

    let traceId: string
    let parentSpanId: string | undefined
    let traceFlags: string

    const parsed = incomingTraceparent ? parseTraceparent(incomingTraceparent) : null

    if (parsed) {
      traceId = parsed.traceId
      parentSpanId = parsed.parentId
      traceFlags = parsed.flags
    } else {
      traceId = generateTraceId()
      parentSpanId = undefined
      traceFlags = '01'
    }

    if (flagsHandler) {
      traceFlags = flagsHandler(traceFlags)
    }

    const spanId = generateSpanId()
    const traceparentValue = `00-${traceId}-${spanId}-${traceFlags}`

    c.set('traceId', traceId)
    c.set('spanId', spanId)
    if (parentSpanId !== undefined) {
      c.set('parentSpanId', parentSpanId)
    }
    c.set('traceFlags', traceFlags)
    c.set('traceparent', traceparentValue)
    if (incomingTracestate !== undefined) {
      c.set('tracestate', incomingTracestate)
    }

    if (propagateResponse) {
      c.header('traceparent', traceparentValue)
      if (incomingTracestate) {
        c.header('tracestate', incomingTracestate)
      }
    }

    await next()
  }
}
