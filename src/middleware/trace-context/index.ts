import type { TraceContextVariables } from './trace-context'
export type { TraceContextVariables }
export type { TraceContextOptions } from './trace-context'
export { traceContext } from './trace-context'

declare module '../..' {
  interface ContextVariableMap extends TraceContextVariables {}
}
