/**
 * @module
 * Response Time Middleware for Hono.
 */

import type { MiddlewareHandler } from '../../types'

export type ResponseTimeOptions = {
  /**
   * The name of the response header to set.
   * @default "X-Response-Time"
   */
  headerName?: string
  /**
   * The number of decimal places to include in the reported time value.
   * Ignored when `format` is provided.
   * @default 0
   */
  precision?: number
  /**
   * A custom function to format the header value given the elapsed time in milliseconds.
   * When provided, the `precision` option is ignored.
   */
  format?: (elapsed: number) => string
}

const getTime: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now()

/**
 * Response Time Middleware for Hono.
 *
 * Measures the elapsed time between receiving a request and sending a response,
 * then sets the result as an HTTP response header. The default value includes a
 * `ms` unit suffix (e.g. `"42ms"`).
 *
 * @param {ResponseTimeOptions} [options] - Options for the Response Time Middleware.
 * @param {string} [options.headerName="X-Response-Time"] - The header name to set.
 *   Pass an empty string to suppress the header entirely.
 * @param {number} [options.precision=0] - Decimal places in the reported millisecond value.
 *   Ignored when `format` is provided.
 * @param {Function} [options.format] - Custom formatter `(elapsed: number) => string`.
 *   Receives the raw elapsed milliseconds and must return the full header value string.
 *
 * @returns {MiddlewareHandler} The middleware handler function.
 *
 * @example
 * ```ts
 * import { Hono } from 'hono'
 * import { responseTime } from 'hono/response-time'
 *
 * const app = new Hono()
 *
 * app.use(responseTime())
 * // → X-Response-Time: 42ms
 *
 * app.use(responseTime({ headerName: 'X-Duration', precision: 2 }))
 * // → X-Duration: 3.14ms
 *
 * app.use(responseTime({ format: (ms) => `${ms.toFixed(1)} milliseconds` }))
 * // → X-Response-Time: 3.1 milliseconds
 * ```
 */
export const responseTime = ({
  headerName = 'X-Response-Time',
  precision = 0,
  format,
}: ResponseTimeOptions = {}): MiddlewareHandler => {
  return async function responseTime(c, next) {
    const start = getTime()
    await next()
    const elapsed = getTime() - start
    if (headerName) {
      c.res.headers.set(headerName, format ? format(elapsed) : `${elapsed.toFixed(precision)}ms`)
    }
  }
}
