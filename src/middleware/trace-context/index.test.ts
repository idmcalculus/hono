import { Hono } from '../../hono'
import { traceContext } from '.'

const TRACEPARENT_REGEX = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/
const HEX_32 = /^[0-9a-f]{32}$/
const HEX_16 = /^[0-9a-f]{16}$/
const ALL_ZEROS_32 = '0'.repeat(32)
const ALL_ZEROS_16 = '0'.repeat(16)

const VALID_TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
const VALID_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'
const VALID_PARENT_ID = '00f067aa0ba902b7'

describe('Trace Context Middleware - no incoming traceparent', () => {
  const app = new Hono()
  app.use('*', traceContext())
  app.get('/trace', (c) =>
    c.json({
      traceId: c.get('traceId'),
      spanId: c.get('spanId'),
      parentSpanId: c.get('parentSpanId'),
      traceFlags: c.get('traceFlags'),
      traceparent: c.get('traceparent'),
      tracestate: c.get('tracestate'),
    })
  )

  it('Should generate a valid traceparent response header', async () => {
    const res = await app.request('http://localhost/trace')
    expect(res.status).toBe(200)
    const header = res.headers.get('traceparent')
    expect(header).not.toBeNull()
    expect(header).toMatch(TRACEPARENT_REGEX)
    const ctx = await res.json()
    expect(ctx.traceparent).toBe(header)
  })

  it('Should generate non-zero traceId and spanId', async () => {
    const res = await app.request('http://localhost/trace')
    const header = res.headers.get('traceparent')!
    const match = TRACEPARENT_REGEX.exec(header)!
    expect(match[1]).not.toBe(ALL_ZEROS_32)
    expect(match[2]).not.toBe(ALL_ZEROS_16)
  })

  it('Should default to traceFlags 01 for fresh traces', async () => {
    const res = await app.request('http://localhost/trace')
    const header = res.headers.get('traceparent')!
    const match = TRACEPARENT_REGEX.exec(header)!
    expect(match[3]).toBe('01')
  })

  it('Should store correct flat context variables', async () => {
    const res = await app.request('http://localhost/trace')
    const ctx = await res.json()
    expect(ctx.traceId).toMatch(HEX_32)
    expect(ctx.spanId).toMatch(HEX_16)
    expect(ctx.traceFlags).toBe('01')
    expect(ctx.parentSpanId).toBeUndefined()
    expect(ctx.tracestate).toBeUndefined()
    expect(ctx.traceparent).toMatch(TRACEPARENT_REGEX)
    expect(ctx.traceparent).toBe(res.headers.get('traceparent'))
  })

  it('Should not set tracestate response header', async () => {
    const res = await app.request('http://localhost/trace')
    expect(res.headers.get('tracestate')).toBeNull()
  })
})

describe('Trace Context Middleware - valid incoming traceparent', () => {
  const app = new Hono()
  app.use('*', traceContext())
  app.get('/trace', (c) =>
    c.json({
      traceId: c.get('traceId'),
      spanId: c.get('spanId'),
      parentSpanId: c.get('parentSpanId'),
      traceFlags: c.get('traceFlags'),
      traceparent: c.get('traceparent'),
    })
  )

  it('Should preserve the trace-id from incoming traceparent', async () => {
    const res = await app.request('http://localhost/trace', {
      headers: { traceparent: VALID_TRACEPARENT },
    })
    const header = res.headers.get('traceparent')!
    const match = TRACEPARENT_REGEX.exec(header)!
    expect(match[1]).toBe(VALID_TRACE_ID)
  })

  it('Should generate a NEW span-id (not reuse incoming parent-id)', async () => {
    const res = await app.request('http://localhost/trace', {
      headers: { traceparent: VALID_TRACEPARENT },
    })
    const header = res.headers.get('traceparent')!
    const match = TRACEPARENT_REGEX.exec(header)!
    expect(match[2]).not.toBe(VALID_PARENT_ID)
    expect(match[2]).toMatch(HEX_16)
  })

  it('Should preserve trace flags', async () => {
    const res = await app.request('http://localhost/trace', {
      headers: { traceparent: VALID_TRACEPARENT },
    })
    const header = res.headers.get('traceparent')!
    const match = TRACEPARENT_REGEX.exec(header)!
    expect(match[3]).toBe('01')
  })

  it('Should store parentSpanId from incoming parent-id', async () => {
    const res = await app.request('http://localhost/trace', {
      headers: { traceparent: VALID_TRACEPARENT },
    })
    const ctx = await res.json()
    expect(ctx.traceId).toBe(VALID_TRACE_ID)
    expect(ctx.parentSpanId).toBe(VALID_PARENT_ID)
    expect(ctx.spanId).toMatch(HEX_16)
    expect(ctx.spanId).not.toBe(VALID_PARENT_ID)
    expect(ctx.traceFlags).toBe('01')
  })

  it('Should store the full traceparent string in context matching response header', async () => {
    const res = await app.request('http://localhost/trace', {
      headers: { traceparent: VALID_TRACEPARENT },
    })
    const ctx = await res.json()
    const header = res.headers.get('traceparent')!
    expect(ctx.traceparent).toBe(header)
    expect(ctx.traceparent).toMatch(TRACEPARENT_REGEX)
    expect(ctx.traceparent).toContain(VALID_TRACE_ID)
    expect(ctx.traceparent).toContain(ctx.spanId)
  })

  it('Should parse case-insensitive traceparent and output lowercase', async () => {
    const upperTraceparent = '00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01'
    const res = await app.request('http://localhost/trace', {
      headers: { traceparent: upperTraceparent },
    })
    const header = res.headers.get('traceparent')!
    expect(header).toMatch(TRACEPARENT_REGEX)
    const ctx = await res.json()
    expect(ctx.traceId).toBe(VALID_TRACE_ID)
    expect(ctx.parentSpanId).toBe(VALID_PARENT_ID)
    expect(ctx.traceparent).toBe(header)
  })
})

describe('Trace Context Middleware - invalid traceparent falls back to fresh trace', () => {
  const app = new Hono()
  app.use('*', traceContext())
  app.get('/trace', (c) =>
    c.json({
      traceId: c.get('traceId'),
      parentSpanId: c.get('parentSpanId'),
      traceFlags: c.get('traceFlags'),
    })
  )

  const invalidCases = [
    ['missing version prefix', '4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
    ['wrong version (not 00)', '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
    ['trace-id too short (31 chars)', '00-4bf92f3577b34da6a3ce929d0e0e47-00f067aa0ba902b7-01'],
    ['parent-id too short (15 chars)', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b-01'],
    ['extra field at end', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra'],
    ['all-zero trace-id', `00-${ALL_ZEROS_32}-00f067aa0ba902b7-01`],
    ['all-zero parent-id', `00-4bf92f3577b34da6a3ce929d0e0e4736-${ALL_ZEROS_16}-01`],
    ['empty string', ''],
  ]

  it.each(invalidCases)('Should generate fresh trace for: %s', async (_label, badHeader) => {
    const res = await app.request('http://localhost/trace', {
      headers: { traceparent: badHeader },
    })
    expect(res.status).toBe(200)
    const header = res.headers.get('traceparent')!
    expect(header).toMatch(TRACEPARENT_REGEX)
    const ctx = await res.json()
    expect(ctx.traceId).not.toBe(VALID_TRACE_ID)
    expect(ctx.parentSpanId).toBeUndefined()
    expect(ctx.traceFlags).toBe('01')
  })
})

describe('Trace Context Middleware - tracestate propagation', () => {
  const app = new Hono()
  app.use('*', traceContext())
  app.get('/trace', (c) =>
    c.json({
      tracestate: c.get('tracestate'),
    })
  )

  it('Should forward tracestate on response when incoming traceparent is valid', async () => {
    const tracestate = 'vendor1=value1,vendor2=value2'
    const res = await app.request('http://localhost/trace', {
      headers: { traceparent: VALID_TRACEPARENT, tracestate },
    })
    expect(res.headers.get('tracestate')).toBe(tracestate)
    const ctx = await res.json()
    expect(ctx.tracestate).toBe(tracestate)
  })

  it('Should not set tracestate response header when no tracestate is sent', async () => {
    const res = await app.request('http://localhost/trace', {
      headers: { traceparent: VALID_TRACEPARENT },
    })
    expect(res.headers.get('tracestate')).toBeNull()
    const ctx = await res.json()
    expect(ctx.tracestate).toBeUndefined()
  })

  it('Should forward tracestate even on a fresh trace (no incoming traceparent)', async () => {
    const tracestate = 'vendor=val'
    const res = await app.request('http://localhost/trace', {
      headers: { tracestate },
    })
    expect(res.headers.get('tracestate')).toBe(tracestate)
    const ctx = await res.json()
    expect(ctx.tracestate).toBe(tracestate)
  })
})

describe('Trace Context Middleware - custom generators', () => {
  it('Should use custom generateSpanId', async () => {
    const customSpanId = 'aabbccdd11223344'
    const app = new Hono()
    app.use('*', traceContext({ generateSpanId: () => customSpanId }))
    app.get('/trace', (c) => c.json({ spanId: c.get('spanId') }))

    const res = await app.request('http://localhost/trace')
    const header = res.headers.get('traceparent')!
    const match = TRACEPARENT_REGEX.exec(header)!
    expect(match[2]).toBe(customSpanId)
    const ctx = await res.json()
    expect(ctx.spanId).toBe(customSpanId)
  })

  it('Should use custom generateTraceId for fresh traces', async () => {
    const customTraceId = 'deadbeefdeadbeefdeadbeefdeadbeef'
    const app = new Hono()
    app.use('*', traceContext({ generateTraceId: () => customTraceId }))
    app.get('/trace', (c) => c.json({ traceId: c.get('traceId') }))

    const res = await app.request('http://localhost/trace')
    const header = res.headers.get('traceparent')!
    const match = TRACEPARENT_REGEX.exec(header)!
    expect(match[1]).toBe(customTraceId)
    const ctx = await res.json()
    expect(ctx.traceId).toBe(customTraceId)
  })

  it('Should NOT use custom generateTraceId when incoming traceparent is valid', async () => {
    const customTraceId = 'deadbeefdeadbeefdeadbeefdeadbeef'
    const app = new Hono()
    app.use('*', traceContext({ generateTraceId: () => customTraceId }))
    app.get('/trace', (c) => c.json({ traceId: c.get('traceId') }))

    const res = await app.request('http://localhost/trace', {
      headers: { traceparent: VALID_TRACEPARENT },
    })
    const ctx = await res.json()
    expect(ctx.traceId).toBe(VALID_TRACE_ID)
    expect(ctx.traceId).not.toBe(customTraceId)
  })
})

describe('Trace Context Middleware - flagsHandler option', () => {
  it('Should transform trace flags via flagsHandler', async () => {
    const app = new Hono()
    app.use('*', traceContext({ flagsHandler: () => '00' }))
    app.get('/trace', (c) => c.json({ traceFlags: c.get('traceFlags') }))

    const res = await app.request('http://localhost/trace', {
      headers: { traceparent: VALID_TRACEPARENT },
    })
    const header = res.headers.get('traceparent')!
    const match = TRACEPARENT_REGEX.exec(header)!
    expect(match[3]).toBe('00')
    const ctx = await res.json()
    expect(ctx.traceFlags).toBe('00')
  })

  it('Should apply flagsHandler to the default flags on a fresh trace', async () => {
    const app = new Hono()
    app.use('*', traceContext({ flagsHandler: (flags) => (flags === '01' ? '00' : flags) }))
    app.get('/trace', (c) => c.json({ traceFlags: c.get('traceFlags') }))

    const res = await app.request('http://localhost/trace')
    const header = res.headers.get('traceparent')!
    const match = TRACEPARENT_REGEX.exec(header)!
    expect(match[3]).toBe('00')
    const ctx = await res.json()
    expect(ctx.traceFlags).toBe('00')
  })
})

describe('Trace Context Middleware - propagateResponse: false', () => {
  const app = new Hono()
  app.use('*', traceContext({ propagateResponse: false }))
  app.get('/trace', (c) =>
    c.json({
      traceId: c.get('traceId'),
      spanId: c.get('spanId'),
      traceFlags: c.get('traceFlags'),
      traceparent: c.get('traceparent'),
      tracestate: c.get('tracestate'),
    })
  )

  it('Should not set traceparent response header', async () => {
    const res = await app.request('http://localhost/trace')
    expect(res.headers.get('traceparent')).toBeNull()
  })

  it('Should not set tracestate response header even when tracestate is sent', async () => {
    const res = await app.request('http://localhost/trace', {
      headers: { traceparent: VALID_TRACEPARENT, tracestate: 'vendor=value' },
    })
    expect(res.headers.get('traceparent')).toBeNull()
    expect(res.headers.get('tracestate')).toBeNull()
  })

  it('Should still populate context variables', async () => {
    const res = await app.request('http://localhost/trace')
    const ctx = await res.json()
    expect(ctx.traceId).toMatch(HEX_32)
    expect(ctx.spanId).toMatch(HEX_16)
    expect(ctx.traceFlags).toBe('01')
    expect(ctx.traceparent).toMatch(TRACEPARENT_REGEX)
  })

  it('Should still populate context variables from valid incoming traceparent', async () => {
    const tracestate = 'vendor=value'
    const res = await app.request('http://localhost/trace', {
      headers: { traceparent: VALID_TRACEPARENT, tracestate },
    })
    const ctx = await res.json()
    expect(ctx.traceId).toBe(VALID_TRACE_ID)
    expect(ctx.tracestate).toBe(tracestate)
    expect(ctx.traceparent).toContain(VALID_TRACE_ID)
  })
})

describe('Trace Context Middleware - uniqueness across requests', () => {
  const app = new Hono()
  app.use('*', traceContext())
  app.get('/trace', (c) =>
    c.json({
      traceId: c.get('traceId'),
      spanId: c.get('spanId'),
    })
  )

  it('Should generate unique spanIds for each request (fresh traces)', async () => {
    const res1 = await app.request('http://localhost/trace')
    const res2 = await app.request('http://localhost/trace')
    const ctx1 = await res1.json()
    const ctx2 = await res2.json()
    const h1 = res1.headers.get('traceparent')!
    const h2 = res2.headers.get('traceparent')!
    expect(TRACEPARENT_REGEX.exec(h1)![2]).not.toBe(TRACEPARENT_REGEX.exec(h2)![2])
    expect(ctx1.spanId).not.toBe(ctx2.spanId)
    expect(ctx1.spanId).toBe(TRACEPARENT_REGEX.exec(h1)![2])
    expect(ctx2.spanId).toBe(TRACEPARENT_REGEX.exec(h2)![2])
  })

  it('Should generate unique traceIds for each fresh request', async () => {
    const res1 = await app.request('http://localhost/trace')
    const res2 = await app.request('http://localhost/trace')
    const ctx1 = await res1.json()
    const ctx2 = await res2.json()
    const h1 = res1.headers.get('traceparent')!
    const h2 = res2.headers.get('traceparent')!
    expect(TRACEPARENT_REGEX.exec(h1)![1]).not.toBe(TRACEPARENT_REGEX.exec(h2)![1])
    expect(ctx1.traceId).not.toBe(ctx2.traceId)
    expect(ctx1.traceId).toBe(TRACEPARENT_REGEX.exec(h1)![1])
    expect(ctx2.traceId).toBe(TRACEPARENT_REGEX.exec(h2)![1])
  })

  it('Should generate unique spanIds per request even with the same incoming trace-id', async () => {
    const res1 = await app.request('http://localhost/trace', {
      headers: { traceparent: VALID_TRACEPARENT },
    })
    const res2 = await app.request('http://localhost/trace', {
      headers: { traceparent: VALID_TRACEPARENT },
    })
    const ctx1 = await res1.json()
    const ctx2 = await res2.json()
    const h1 = res1.headers.get('traceparent')!
    const h2 = res2.headers.get('traceparent')!
    expect(TRACEPARENT_REGEX.exec(h1)![1]).toBe(VALID_TRACE_ID)
    expect(TRACEPARENT_REGEX.exec(h2)![1]).toBe(VALID_TRACE_ID)
    expect(ctx1.traceId).toBe(VALID_TRACE_ID)
    expect(ctx2.traceId).toBe(VALID_TRACE_ID)
    expect(TRACEPARENT_REGEX.exec(h1)![2]).not.toBe(TRACEPARENT_REGEX.exec(h2)![2])
    expect(ctx1.spanId).not.toBe(ctx2.spanId)
    expect(ctx1.spanId).toBe(TRACEPARENT_REGEX.exec(h1)![2])
    expect(ctx2.spanId).toBe(TRACEPARENT_REGEX.exec(h2)![2])
  })
})
