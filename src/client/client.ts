import type { Hono } from '../hono'
import type { FormValue, ValidationTargets } from '../types'
import { serialize } from '../utils/cookie'
import type { UnionToIntersection } from '../utils/types'
import type {
  BackoffStrategy,
  BuildSearchParamsFn,
  Callback,
  Client,
  ClientRequestOptions,
  RetryOptions,
} from './types'
import {
  buildSearchParams,
  deepMerge,
  mergePath,
  removeIndexString,
  replaceUrlParam,
  replaceUrlProtocol,
} from './utils'

const DEFAULT_RETRY_OPTIONS: Required<Omit<RetryOptions, 'shouldRetry' | 'onRetry'>> = {
  maxRetries: 3,
  initialDelayMs: 100,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  backoff: 'exponential',
  retryOn: [408, 429, 500, 502, 503, 504],
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const calculateBackoff = (
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  backoffMultiplier: number,
  strategy: BackoffStrategy
): number => {
  let delay: number
  if (strategy === 'linear') {
    delay = initialDelayMs * (attempt + 1)
  } else {
    // exponential (default)
    delay = initialDelayMs * Math.pow(backoffMultiplier, attempt)
  }
  return Math.min(delay, maxDelayMs)
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

const fetchWithTimeout = async (
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeout: number
): Promise<Response> => {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  // Link external AbortSignal to internal controller
  const externalSignal = init.signal
  let externalAbortHandler: (() => void) | undefined

  if (externalSignal) {
    // If already aborted, abort immediately
    if (externalSignal.aborted) {
      clearTimeout(timeoutId)
      controller.abort()
    } else {
      externalAbortHandler = () => controller.abort()
      externalSignal.addEventListener('abort', externalAbortHandler)
    }
  }

  try {
    const response = await fetchFn(url, {
      ...init,
      signal: controller.signal,
    })
    return response
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      // Check if the abort was from external signal or timeout
      if (externalSignal?.aborted) {
        throw error // Re-throw original abort error for external aborts
      }
      throw new TimeoutError(`Request timed out after ${timeout}ms`)
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
    if (externalSignal && externalAbortHandler) {
      externalSignal.removeEventListener('abort', externalAbortHandler)
    }
  }
}

const shouldRetryResponse = async (
  response: Response,
  retryOptions: RetryOptions
): Promise<boolean> => {
  if (retryOptions.shouldRetry) {
    return retryOptions.shouldRetry(response)
  }
  const retryOn = retryOptions.retryOn ?? DEFAULT_RETRY_OPTIONS.retryOn
  return retryOn.includes(response.status)
}

const fetchWithRetry = async (
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  retryOptions: RetryOptions,
  timeout?: number
): Promise<Response> => {
  const maxRetries = retryOptions.maxRetries ?? DEFAULT_RETRY_OPTIONS.maxRetries
  const initialDelayMs = retryOptions.initialDelayMs ?? DEFAULT_RETRY_OPTIONS.initialDelayMs
  const maxDelayMs = retryOptions.maxDelayMs ?? DEFAULT_RETRY_OPTIONS.maxDelayMs
  const backoffMultiplier = retryOptions.backoffMultiplier ?? DEFAULT_RETRY_OPTIONS.backoffMultiplier
  const backoffStrategy = retryOptions.backoff ?? DEFAULT_RETRY_OPTIONS.backoff
  const onRetry = retryOptions.onRetry

  let lastError: Error | undefined
  let lastResponse: Response | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = timeout
        ? await fetchWithTimeout(fetchFn, url, init, timeout)
        : await fetchFn(url, init)

      if (await shouldRetryResponse(response, retryOptions)) {
        lastResponse = response
        if (attempt < maxRetries) {
          const delay = calculateBackoff(
            attempt,
            initialDelayMs,
            maxDelayMs,
            backoffMultiplier,
            backoffStrategy
          )
          if (onRetry) {
            await onRetry({
              attempt: attempt + 1,
              response,
              delayMs: delay,
            })
          }
          await sleep(delay)
          continue
        }
      }
      return response
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      // Don't retry on timeout errors or abort errors
      if (lastError instanceof TimeoutError || lastError.name === 'AbortError') {
        throw lastError
      }
      if (attempt < maxRetries) {
        const delay = calculateBackoff(
          attempt,
          initialDelayMs,
          maxDelayMs,
          backoffMultiplier,
          backoffStrategy
        )
        if (onRetry) {
          await onRetry({
            attempt: attempt + 1,
            error: lastError,
            delayMs: delay,
          })
        }
        await sleep(delay)
        continue
      }
    }
  }

  // If we have a response (retryable status but exhausted retries), return it
  if (lastResponse) {
    return lastResponse
  }

  // Otherwise throw the last error
  throw lastError ?? new Error('Request failed')
}

export { TimeoutError }

const createProxy = (callback: Callback, path: string[]) => {
  const proxy: unknown = new Proxy(() => {}, {
    get(_obj, key) {
      if (typeof key !== 'string' || key === 'then') {
        return undefined
      }
      return createProxy(callback, [...path, key])
    },
    apply(_1, _2, args) {
      return callback({
        path,
        args,
      })
    },
  })
  return proxy
}

class ClientRequestImpl {
  private url: string
  private method: string
  private buildSearchParams: BuildSearchParamsFn
  private queryParams: URLSearchParams | undefined = undefined
  private pathParams: Record<string, string> = {}
  private rBody: BodyInit | undefined
  private cType: string | undefined = undefined

  constructor(
    url: string,
    method: string,
    options: {
      buildSearchParams: BuildSearchParamsFn
    }
  ) {
    this.url = url
    this.method = method
    this.buildSearchParams = options.buildSearchParams
  }
  fetch = async (
    args?: ValidationTargets<FormValue> & {
      param?: Record<string, string>
    },
    opt?: ClientRequestOptions
  ) => {
    if (args) {
      if (args.query) {
        this.queryParams = this.buildSearchParams(args.query)
      }

      if (args.form) {
        const form = new FormData()
        for (const [k, v] of Object.entries(args.form)) {
          if (Array.isArray(v)) {
            for (const v2 of v) {
              form.append(k, v2)
            }
          } else {
            form.append(k, v)
          }
        }
        this.rBody = form
      }

      if (args.json) {
        this.rBody = JSON.stringify(args.json)
        this.cType = 'application/json'
      }

      if (args.param) {
        this.pathParams = args.param
      }
    }

    let methodUpperCase = this.method.toUpperCase()

    const headerValues: Record<string, string> = {
      ...args?.header,
      ...(typeof opt?.headers === 'function' ? await opt.headers() : opt?.headers),
    }

    if (args?.cookie) {
      const cookies: string[] = []
      for (const [key, value] of Object.entries(args.cookie)) {
        cookies.push(serialize(key, value, { path: '/' }))
      }
      headerValues['Cookie'] = cookies.join(',')
    }

    if (this.cType) {
      headerValues['Content-Type'] = this.cType
    }

    const headers = new Headers(headerValues ?? undefined)
    let url = this.url

    url = removeIndexString(url)
    url = replaceUrlParam(url, this.pathParams)

    if (this.queryParams) {
      url = url + '?' + this.queryParams.toString()
    }
    methodUpperCase = this.method.toUpperCase()
    const setBody = !(methodUpperCase === 'GET' || methodUpperCase === 'HEAD')

    const fetchFn = (opt?.fetch || fetch) as typeof fetch
    const requestInit: RequestInit = {
      body: setBody ? this.rBody : undefined,
      method: methodUpperCase,
      headers: headers,
      ...opt?.init,
    }

    // Handle retry and timeout options
    const retryOptions = opt?.retry
    const timeout = opt?.timeout

    // If retry is explicitly disabled or not configured, use simple fetch with optional timeout
    if (retryOptions === false || retryOptions === undefined) {
      if (timeout !== undefined) {
        return fetchWithTimeout(fetchFn, url, requestInit, timeout)
      }
      // Pass URL string to 1st arg for testing with MSW and node-fetch
      return fetchFn(url, requestInit)
    }

    // Use retry logic with optional timeout
    return fetchWithRetry(fetchFn, url, requestInit, retryOptions, timeout)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const hc = <T extends Hono<any, any, any>, Prefix extends string = string>(
  baseUrl: Prefix,
  options?: ClientRequestOptions
) =>
  createProxy(function proxyCallback(opts) {
    const buildSearchParamsOption = options?.buildSearchParams ?? buildSearchParams
    const parts = [...opts.path]
    const lastParts = parts.slice(-3).reverse()

    // allow calling .toString() and .valueOf() on the proxy
    if (lastParts[0] === 'toString') {
      if (lastParts[1] === 'name') {
        // e.g. hc().somePath.name.toString() -> "somePath"
        return lastParts[2] || ''
      }
      // e.g. hc().somePath.toString()
      return proxyCallback.toString()
    }

    if (lastParts[0] === 'valueOf') {
      if (lastParts[1] === 'name') {
        // e.g. hc().somePath.name.valueOf() -> "somePath"
        return lastParts[2] || ''
      }
      // e.g. hc().somePath.valueOf()
      return proxyCallback
    }

    let method = ''
    if (/^\$/.test(lastParts[0] as string)) {
      const last = parts.pop()
      if (last) {
        method = last.replace(/^\$/, '')
      }
    }

    const path = parts.join('/')
    const url = mergePath(baseUrl, path)
    if (method === 'url') {
      let result = url
      if (opts.args[0]) {
        if (opts.args[0].param) {
          result = replaceUrlParam(url, opts.args[0].param)
        }
        if (opts.args[0].query) {
          result = result + '?' + buildSearchParamsOption(opts.args[0].query).toString()
        }
      }
      result = removeIndexString(result)
      return new URL(result)
    }
    if (method === 'ws') {
      const webSocketUrl = replaceUrlProtocol(
        opts.args[0] && opts.args[0].param ? replaceUrlParam(url, opts.args[0].param) : url,
        'ws'
      )
      const targetUrl = new URL(webSocketUrl)

      const queryParams: Record<string, string | string[]> | undefined = opts.args[0]?.query
      if (queryParams) {
        Object.entries(queryParams).forEach(([key, value]) => {
          if (Array.isArray(value)) {
            value.forEach((item) => targetUrl.searchParams.append(key, item))
          } else {
            targetUrl.searchParams.set(key, value)
          }
        })
      }
      const establishWebSocket = (...args: ConstructorParameters<typeof WebSocket>) => {
        if (options?.webSocket !== undefined && typeof options.webSocket === 'function') {
          return options.webSocket(...args)
        }
        return new WebSocket(...args)
      }

      return establishWebSocket(targetUrl.toString())
    }

    const req = new ClientRequestImpl(url, method, {
      buildSearchParams: buildSearchParamsOption,
    })
    if (method) {
      options ??= {}
      const args = deepMerge<ClientRequestOptions>(options, { ...opts.args[1] })
      return req.fetch(opts.args[0], args)
    }
    return req
  }, []) as UnionToIntersection<Client<T, Prefix>>
