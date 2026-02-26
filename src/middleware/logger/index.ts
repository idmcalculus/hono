/**
 * @module
 * Logger Middleware for Hono.
 */

import type { MiddlewareHandler } from '../../types'
import { getColorEnabledAsync } from '../../utils/color'

enum LogPrefix {
  Outgoing = '-->',
  Incoming = '<--',
  Error = 'xxx',
}

const humanize = (times: string[]) => {
  const [delimiter, separator] = [',', '.']

  const orderTimes = times.map((v) => v.replace(/(\d)(?=(\d\d\d)+(?!\d))/g, '$1' + delimiter))

  return orderTimes.join(separator)
}

const time = (start: number) => {
  const delta = Date.now() - start
  return humanize([delta < 1000 ? delta + 'ms' : Math.round(delta / 1000) + 's'])
}

const colorStatus = async (status: number) => {
  const colorEnabled = await getColorEnabledAsync()
  if (colorEnabled) {
    switch ((status / 100) | 0) {
      case 5: // red = error
        return `\x1b[31m${status}\x1b[0m`
      case 4: // yellow = warning
        return `\x1b[33m${status}\x1b[0m`
      case 3: // cyan = redirect
        return `\x1b[36m${status}\x1b[0m`
      case 2: // green = success
        return `\x1b[32m${status}\x1b[0m`
    }
  }
  // Fallback to unsupported status code.
  // E.g.) Bun and Deno supports new Response with 101, but Node.js does not.
  // And those may evolve to accept more status.
  return `${status}`
}

type PrintFunc = (str: string, ...rest: string[]) => void

/**
 * Severity level derived from the HTTP status code.
 */
export type LogLevel = 'info' | 'warn' | 'error'

/**
 * Options for the logger middleware.
 */
export type LoggerOptions = {
  /**
   * Output mode for log entries.
   * - `'text'` (default): human-readable colorized text, e.g. `--> GET /path 200 3ms`
   * - `'json'`: machine-readable JSON, e.g. `{"timestamp":"...","level":"info","method":"GET","path":"/path","status":200,"elapsed":"3ms"}`
   * - `'yaml'`: machine-readable YAML with the same fields as JSON mode
   */
  mode?: 'text' | 'json' | 'yaml'
}

/**
 * Structured log entry used by json and yaml modes.
 */
export type LogEntry = {
  timestamp: string
  level: LogLevel
  direction: 'incoming' | 'outgoing'
  method: string
  path: string
  status?: number
  elapsed?: string
}

function levelFromStatus(status?: number): LogLevel {
  if (status === undefined) {
    return 'info'
  }
  const category = (status / 100) | 0
  if (category >= 5) {
    return 'error'
  }
  if (category >= 4) {
    return 'warn'
  }
  return 'info'
}

function buildLogEntry(
  direction: 'incoming' | 'outgoing',
  method: string,
  path: string,
  status?: number,
  elapsed?: string
): LogEntry {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level: levelFromStatus(status),
    direction,
    method,
    path,
  }
  if (status !== undefined) {
    entry.status = status
  }
  if (elapsed !== undefined) {
    entry.elapsed = elapsed
  }
  return entry
}

function formatJson(entry: LogEntry): string {
  return JSON.stringify(entry)
}

function formatYaml(entry: LogEntry): string {
  const lines: string[] = []
  lines.push(`timestamp: "${entry.timestamp}"`)
  lines.push(`level: ${entry.level}`)
  lines.push(`direction: ${entry.direction}`)
  lines.push(`method: ${entry.method}`)
  lines.push(`path: "${entry.path}"`)
  if (entry.status !== undefined) {
    lines.push(`status: ${entry.status}`)
  }
  if (entry.elapsed !== undefined) {
    lines.push(`elapsed: "${entry.elapsed}"`)
  }
  return lines.join('\n')
}

async function log(
  fn: PrintFunc,
  prefix: string,
  method: string,
  path: string,
  status: number = 0,
  elapsed?: string
) {
  const out =
    prefix === LogPrefix.Incoming
      ? `${prefix} ${method} ${path}`
      : `${prefix} ${method} ${path} ${await colorStatus(status)} ${elapsed}`
  fn(out)
}

function logStructured(
  fn: PrintFunc,
  formatter: (entry: LogEntry) => string,
  direction: 'incoming' | 'outgoing',
  method: string,
  path: string,
  status?: number,
  elapsed?: string
) {
  fn(formatter(buildLogEntry(direction, method, path, status, elapsed)))
}

/**
 * Logger Middleware for Hono.
 *
 * @see {@link https://hono.dev/docs/middleware/builtin/logger}
 *
 * @param {PrintFunc} [fn=console.log] - Optional function for customized logging behavior.
 * @param {LoggerOptions} [options] - Optional configuration options.
 * @returns {MiddlewareHandler} The middleware handler function.
 *
 * @example
 * ```ts
 * const app = new Hono()
 *
 * app.use(logger())
 * app.get('/', (c) => c.text('Hello Hono!'))
 * ```
 *
 * @example
 * ```ts
 * // JSON structured logging
 * app.use(logger(console.log, { mode: 'json' }))
 * ```
 *
 * @example
 * ```ts
 * // YAML structured logging
 * app.use(logger(console.log, { mode: 'yaml' }))
 * ```
 */
export const logger = (fn: PrintFunc = console.log, options: LoggerOptions = {}): MiddlewareHandler => {
  const formatter = options.mode === 'yaml' ? formatYaml : formatJson

  return async function logger(c, next) {
    const { method, url } = c.req

    const path = url.slice(url.indexOf('/', 8))

    if (options.mode === 'json' || options.mode === 'yaml') {
      logStructured(fn, formatter, 'incoming', method, path)
    } else {
      await log(fn, LogPrefix.Incoming, method, path)
    }

    const start = Date.now()

    await next()

    if (options.mode === 'json' || options.mode === 'yaml') {
      logStructured(fn, formatter, 'outgoing', method, path, c.res.status, time(start))
    } else {
      await log(fn, LogPrefix.Outgoing, method, path, c.res.status, time(start))
    }
  }
}
