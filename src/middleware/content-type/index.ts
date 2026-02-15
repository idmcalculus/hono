/**
 * @module
 * Content-Type Middleware for Hono.
 */

import type { Context } from '../../context'
import { HTTPException } from '../../http-exception'
import type { MiddlewareHandler } from '../../types'

const ERROR_MESSAGE = 'Unsupported Media Type'

type OnError = (c: Context) => Response | Promise<Response>

type ContentTypeOptions = {
  /**
   * Array of allowed Content-Type values.
   * Supports exact matches (e.g., `'application/json'`),
   * wildcard type matches (e.g., `'application/*'`, `'*​/*'`),
   * and a bare `'*'` shorthand for allowing all content types.
   * Matching ignores parameters like charset and boundary.
   */
  allowedTypes: string[]

  /**
   * HTTP methods to enforce content type checking on.
   * @default ['POST', 'PUT', 'PATCH']
   */
  methods?: string[]

  /**
   * Custom error handler invoked when the content type is not allowed.
   * If not provided, throws an HTTPException with status 415.
   */
  onError?: OnError
}

const parseMediaType = (contentType: string): string => {
  const semicolonIndex = contentType.indexOf(';')
  const mediaType = semicolonIndex === -1 ? contentType : contentType.slice(0, semicolonIndex)
  return mediaType.trim().toLowerCase()
}

const buildMatcher = (allowedTypes: string[]): ((mediaType: string) => boolean) => {
  const exactTypes = new Set<string>()
  const wildcardPrefixes: string[] = []
  let allowAll = false

  for (const type of allowedTypes) {
    const normalized = type.trim().toLowerCase()
    if (normalized === '*/*' || normalized === '*') {
      allowAll = true
      break
    }
    const slashIndex = normalized.indexOf('/')
    if (slashIndex !== -1 && normalized.slice(slashIndex + 1) === '*') {
      wildcardPrefixes.push(normalized.slice(0, slashIndex + 1))
    } else {
      exactTypes.add(normalized)
    }
  }

  if (allowAll) {
    return () => true
  }

  return (mediaType: string): boolean => {
    if (exactTypes.has(mediaType)) {
      return true
    }
    for (const prefix of wildcardPrefixes) {
      if (mediaType.startsWith(prefix)) {
        return true
      }
    }
    return false
  }
}

/**
 * Content-Type Middleware for Hono.
 *
 * @see {@link https://hono.dev/docs/middleware/builtin/content-type}
 *
 * @param {ContentTypeOptions} options - The options for the content type middleware.
 * @param {string[]} options.allowedTypes - Allowed Content-Type values.
 * @param {string[]} [options.methods=['POST', 'PUT', 'PATCH']] - HTTP methods to enforce on.
 * @param {OnError} [options.onError] - Custom error handler for unsupported content types.
 * @returns {MiddlewareHandler} The middleware handler function.
 *
 * @example
 * ```ts
 * const app = new Hono()
 *
 * app.use(
 *   contentType({
 *     allowedTypes: ['application/json', 'text/plain'],
 *   })
 * )
 *
 * app.post('/', (c) => c.text('ok'))
 * ```
 */
export const contentType = (options: ContentTypeOptions): MiddlewareHandler => {
  const methods = new Set(
    (options.methods ?? ['POST', 'PUT', 'PATCH']).map((m) => m.toUpperCase())
  )
  const matcher = buildMatcher(options.allowedTypes)
  const onError: OnError =
    options.onError ||
    (() => {
      const res = new Response(ERROR_MESSAGE, { status: 415 })
      throw new HTTPException(415, { res })
    })

  return async function contentType(c, next) {
    if (!methods.has(c.req.method)) {
      return next()
    }

    const contentTypeHeader = c.req.header('Content-Type')

    if (!contentTypeHeader) {
      return onError(c)
    }

    const mediaType = parseMediaType(contentTypeHeader)

    if (!matcher(mediaType)) {
      return onError(c)
    }

    await next()
  }
}
