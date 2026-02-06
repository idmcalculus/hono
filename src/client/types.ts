import type { Hono } from '../hono'
import type { HonoBase } from '../hono-base'
import type { Endpoint, ResponseFormat, Schema } from '../types'
import type { StatusCode, SuccessStatusCode } from '../utils/http-status'
import type { HasRequiredKeys } from '../utils/types'

type HonoRequest = (typeof Hono.prototype)['request']

export type BuildSearchParamsFn = (query: Record<string, string | string[]>) => URLSearchParams

/**
 * Backoff strategy for retry delays.
 * - 'exponential': delay = initialDelayMs * (backoffMultiplier ^ attempt)
 * - 'linear': delay = initialDelayMs * (attempt + 1)
 */
export type BackoffStrategy = 'exponential' | 'linear'

/**
 * Context passed to the onRetry callback.
 */
export type RetryContext = {
  /**
   * The current retry attempt number (starts at 1 for the first retry).
   */
  attempt: number
  /**
   * The error that triggered the retry, if the request threw an error.
   */
  error?: Error
  /**
   * The response that triggered the retry, if the request returned a retryable status.
   */
  response?: globalThis.Response
  /**
   * The delay in milliseconds before the next retry attempt.
   */
  delayMs: number
}

/**
 * Configuration options for retry behavior with exponential backoff.
 */
export type RetryOptions = {
  /**
   * Maximum number of retry attempts. Defaults to 3.
   */
  maxRetries?: number
  /**
   * Initial delay in milliseconds before the first retry. Defaults to 100.
   */
  initialDelayMs?: number
  /**
   * Maximum delay in milliseconds between retries. Defaults to 30000 (30 seconds).
   */
  maxDelayMs?: number
  /**
   * Multiplier for exponential backoff. Defaults to 2.
   * Only used when `backoff` is 'exponential'.
   */
  backoffMultiplier?: number
  /**
   * Backoff strategy for calculating retry delays. Defaults to 'exponential'.
   * - 'exponential': delay = initialDelayMs * (backoffMultiplier ^ attempt)
   * - 'linear': delay = initialDelayMs * (attempt + 1)
   */
  backoff?: BackoffStrategy
  /**
   * HTTP status codes that should trigger a retry. Defaults to [408, 429, 500, 502, 503, 504].
   */
  retryOn?: number[]
  /**
   * Custom function to determine if a response should be retried.
   * Takes precedence over `retryOn` if provided.
   */
  shouldRetry?: (response: globalThis.Response) => boolean | Promise<boolean>
  /**
   * Callback invoked before each retry attempt.
   * Useful for logging or observing retry behavior.
   *
   * @example
   * ```ts
   * const client = hc('http://localhost', {
   *   retry: {
   *     maxRetries: 3,
   *     onRetry: ({ attempt, error, response, delayMs }) => {
   *       console.log(`Retry attempt ${attempt} after ${delayMs}ms`)
   *     }
   *   }
   * })
   * ```
   */
  onRetry?: (context: RetryContext) => void | Promise<void>
}

export type ClientRequestOptions<T = unknown> = {
  fetch?: typeof fetch | HonoRequest
  webSocket?: (...args: ConstructorParameters<typeof WebSocket>) => WebSocket
  /**
   * Standard `RequestInit`, caution that this take highest priority
   * and could be used to overwrite things that Hono sets for you, like `body | method | headers`.
   *
   * If you want to add some headers, use in `headers` instead of `init`
   */
  init?: RequestInit
  /**
   * Custom function to serialize query parameters into URLSearchParams.
   * By default, arrays are serialized as multiple parameters with the same key (e.g., `key=a&key=b`).
   * You can provide a custom function to change this behavior, for example to use bracket notation (e.g., `key[]=a&key[]=b`).
   *
   * @example
   * ```ts
   * const client = hc('http://localhost', {
   *   buildSearchParams: (query) => {
   *     return new URLSearchParams(qs.stringify(query))
   *   }
   * })
   * ```
   */
  buildSearchParams?: BuildSearchParamsFn
  /**
   * Request timeout in milliseconds.
   * If the request takes longer than this, it will be aborted.
   *
   * @example
   * ```ts
   * const client = hc('http://localhost', {
   *   timeout: 5000 // 5 seconds
   * })
   * ```
   */
  timeout?: number
  /**
   * Retry configuration for failed requests.
   * Set to `false` to disable retries, or provide options to customize retry behavior.
   *
   * @example
   * ```ts
   * const client = hc('http://localhost', {
   *   retry: {
   *     maxRetries: 3,
   *     initialDelayMs: 100,
   *     backoffMultiplier: 2,
   *     retryOn: [503, 429]
   *   }
   * })
   * ```
   */
  retry?: RetryOptions | false
} & (keyof T extends never
  ? {
      headers?:
        | Record<string, string>
        | (() => Record<string, string> | Promise<Record<string, string>>)
    }
  : {
      headers: T | (() => T | Promise<T>)
    })

export type ClientRequest<Prefix extends string, Path extends string, S extends Schema> = {
  [M in keyof S]: S[M] extends Endpoint & { input: infer R }
    ? R extends object
      ? HasRequiredKeys<R> extends true
        ? (args: R, options?: ClientRequestOptions) => Promise<ClientResponseOfEndpoint<S[M]>>
        : (args?: R, options?: ClientRequestOptions) => Promise<ClientResponseOfEndpoint<S[M]>>
      : never
    : never
} & {
  $url: <
    const Arg extends
      | (S[keyof S] extends { input: infer R }
          ? R extends { param: infer P }
            ? R extends { query: infer Q }
              ? { param: P; query: Q }
              : { param: P }
            : R extends { query: infer Q }
              ? { query: Q }
              : {}
          : {})
      | undefined = undefined,
  >(
    arg?: Arg
  ) => HonoURL<Prefix, Path, Arg>
} & (S['$get'] extends { outputFormat: 'ws' }
    ? S['$get'] extends { input: infer I }
      ? {
          $ws: (args?: I) => WebSocket
        }
      : {}
    : {})

type ClientResponseOfEndpoint<T extends Endpoint = Endpoint> = T extends {
  output: infer O
  outputFormat: infer F
  status: infer S
}
  ? ClientResponse<O, S extends number ? S : never, F extends ResponseFormat ? F : never>
  : never

export interface ClientResponse<
  T,
  U extends number = StatusCode,
  F extends ResponseFormat = ResponseFormat,
>
  extends globalThis.Response {
  readonly body: ReadableStream | null
  readonly bodyUsed: boolean
  ok: U extends SuccessStatusCode
    ? true
    : U extends Exclude<StatusCode, SuccessStatusCode>
      ? false
      : boolean
  status: U
  statusText: string
  headers: Headers
  url: string
  redirect(url: string, status: number): Response
  clone(): Response
  json(): F extends 'text' ? Promise<never> : F extends 'json' ? Promise<T> : Promise<unknown>
  text(): F extends 'text' ? (T extends string ? Promise<T> : Promise<never>) : Promise<string>
  blob(): Promise<Blob>
  formData(): Promise<FormData>
  arrayBuffer(): Promise<ArrayBuffer>
}

type BuildSearch<Arg, Key extends 'query'> = Arg extends { [K in Key]: infer Query }
  ? IsEmptyObject<Query> extends true
    ? ''
    : `?${string}`
  : ''

type BuildPathname<P extends string, Arg> = Arg extends { param: infer Param }
  ? `${ApplyParam<TrimStartSlash<P>, Param>}`
  : `/${TrimStartSlash<P>}`

type BuildTypedURL<
  Protocol extends string,
  Host extends string,
  Port extends string,
  P extends string,
  Arg,
> = TypedURL<`${Protocol}:`, Host, Port, BuildPathname<P, Arg>, BuildSearch<Arg, 'query'>>

type HonoURL<Prefix extends string, Path extends string, Arg> =
  IsLiteral<Prefix> extends true
    ? TrimEndSlash<Prefix> extends `${infer Protocol}://${infer Rest}`
      ? Rest extends `${infer Hostname}/${infer P}`
        ? ParseHostName<Hostname> extends [infer Host extends string, infer Port extends string]
          ? BuildTypedURL<Protocol, Host, Port, P, Arg>
          : never
        : ParseHostName<Rest> extends [infer Host extends string, infer Port extends string]
          ? BuildTypedURL<Protocol, Host, Port, Path, Arg>
          : never
      : URL
    : URL
type ParseHostName<T extends string> = T extends `${infer Host}:${infer Port}`
  ? [Host, Port]
  : [T, '']
type TrimStartSlash<T extends string> = T extends `/${infer R}` ? TrimStartSlash<R> : T
type TrimEndSlash<T extends string> = T extends `${infer R}/` ? TrimEndSlash<R> : T
type IsLiteral<T extends string> = [T] extends [never] ? false : string extends T ? false : true
type ApplyParam<
  Path extends string,
  P,
  Result extends string = '',
> = Path extends `${infer Head}/${infer Rest}`
  ? Head extends `:${infer Param}`
    ? P extends Record<Param, infer Value extends string>
      ? IsLiteral<Value> extends true
        ? ApplyParam<Rest, P, `${Result}/${Value & string}`>
        : ApplyParam<Rest, P, `${Result}/${Head}`>
      : ApplyParam<Rest, P, `${Result}/${Head}`>
    : ApplyParam<Rest, P, `${Result}/${Head}`>
  : Path extends `:${infer Param}`
    ? P extends Record<Param, infer Value extends string>
      ? IsLiteral<Value> extends true
        ? `${Result}/${Value & string}`
        : `${Result}/${Path}`
      : `${Result}/${Path}`
    : `${Result}/${Path}`
type IsEmptyObject<T> = keyof T extends never ? true : false

export interface TypedURL<
  Protocol extends string,
  Hostname extends string,
  Port extends string,
  Pathname extends string,
  Search extends string,
> extends URL {
  protocol: Protocol
  hostname: Hostname
  port: Port
  host: Port extends '' ? Hostname : `${Hostname}:${Port}`
  origin: `${Protocol}//${Hostname}${Port extends '' ? '' : `:${Port}`}`
  pathname: Pathname
  search: Search
  href: `${Protocol}//${Hostname}${Port extends '' ? '' : `:${Port}`}${Pathname}${Search}`
}

export interface Response extends ClientResponse<unknown> {}

export type Fetch<T> = (
  args?: InferRequestType<T>,
  opt?: ClientRequestOptions
) => Promise<ClientResponseOfEndpoint<InferEndpointType<T>>>

type InferEndpointType<T> = T extends (
  args: infer R,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: any | undefined
) => Promise<infer U>
  ? U extends ClientResponse<infer O, infer S, infer F>
    ? { input: NonNullable<R>; output: O; outputFormat: F; status: S } extends Endpoint
      ? { input: NonNullable<R>; output: O; outputFormat: F; status: S }
      : never
    : never
  : never

export type InferResponseType<T, U extends StatusCode = StatusCode> = InferResponseTypeFromEndpoint<
  InferEndpointType<T>,
  U
>

type InferResponseTypeFromEndpoint<T extends Endpoint, U extends StatusCode> = T extends {
  output: infer O
  status: infer S
}
  ? S extends U
    ? O
    : never
  : never

export type InferRequestType<T> = T extends (
  args: infer R,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: any | undefined
) => Promise<ClientResponse<unknown>>
  ? NonNullable<R>
  : never

export type InferRequestOptionsType<T> = T extends (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any,
  options: infer R
) => Promise<ClientResponse<unknown>>
  ? NonNullable<R>
  : never

/**
 * Filter a ClientResponse type so it only includes responses of specific status codes.
 */
export type FilterClientResponseByStatusCode<
  T extends ClientResponse<any, any, any>,
  U extends number = StatusCode,
> =
  T extends ClientResponse<infer RT, infer RC, infer RF>
    ? RC extends U
      ? ClientResponse<RT, RC, RF>
      : never
    : never

type PathToChain<
  Prefix extends string,
  Path extends string,
  E extends Schema,
  Original extends string = Path,
> = Path extends `/${infer P}`
  ? PathToChain<Prefix, P, E, Path>
  : Path extends `${infer P}/${infer R}`
    ? { [K in P]: PathToChain<Prefix, R, E, Original> }
    : {
        [K in Path extends '' ? 'index' : Path]: ClientRequest<
          Prefix,
          Original,
          E extends Record<string, unknown> ? E[Original] : never
        >
      }

export type Client<T, Prefix extends string> =
  T extends HonoBase<any, infer S, any>
    ? S extends Record<infer K, Schema>
      ? K extends string
        ? PathToChain<Prefix, K, S>
        : never
      : never
    : never

export type Callback = (opts: CallbackOptions) => unknown

interface CallbackOptions {
  path: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any[]
}

export type ObjectType<T = unknown> = {
  [key: string]: T
}
