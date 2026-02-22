import { Hono } from '../../hono'
import { responseTime } from '.'

describe('Response Time Middleware', () => {
  describe('Default options', () => {
    const app = new Hono()
    app.use(responseTime())
    app.get('/', (c) => c.text('Hello'))

    it('Should set X-Response-Time header', async () => {
      const res = await app.request('http://localhost/')
      expect(res.status).toBe(200)
      expect(res.headers.get('X-Response-Time')).not.toBeNull()
    })

    it('Should format value as integer milliseconds with ms suffix by default (precision=0)', async () => {
      const res = await app.request('http://localhost/')
      const header = res.headers.get('X-Response-Time')!
      expect(header).toMatch(/^\d+ms$/)
    })
  })

  describe('Custom headerName', () => {
    const app = new Hono()
    app.use(responseTime({ headerName: 'X-Duration' }))
    app.get('/', (c) => c.text('Hello'))

    it('Should use the custom header name', async () => {
      const res = await app.request('http://localhost/')
      expect(res.headers.get('X-Duration')).not.toBeNull()
    })

    it('Should not set the default header when a custom name is given', async () => {
      const res = await app.request('http://localhost/')
      expect(res.headers.get('X-Response-Time')).toBeNull()
    })
  })

  describe('Precision', () => {
    const app = new Hono()
    app.use(responseTime({ precision: 3 }))
    app.get('/', (c) => c.text('Hello'))

    it('Should include exactly the requested number of decimal places followed by ms', async () => {
      const res = await app.request('http://localhost/')
      const header = res.headers.get('X-Response-Time')!
      expect(header).toMatch(/^\d+\.\d{3}ms$/)
    })
  })

  describe('Custom format', () => {
    const app = new Hono()
    app.use(responseTime({ format: (ms) => `${ms.toFixed(1)}ms`, precision: 3 }))
    app.get('/', (c) => c.text('Hello'))

    it('Should use the custom format function output', async () => {
      const res = await app.request('http://localhost/')
      const header = res.headers.get('X-Response-Time')!
      expect(header).toMatch(/^\d+\.\dms$/)
    })

    it('Should ignore precision when format is provided', async () => {
      const res = await app.request('http://localhost/')
      const header = res.headers.get('X-Response-Time')!
      // format returns 1 decimal place, not 3
      expect(header).not.toMatch(/^\d+\.\d{3}ms$/)
    })
  })

  describe('Suppressed header', () => {
    const app = new Hono()
    app.use(responseTime({ headerName: '' }))
    app.get('/', (c) => c.text('Hello'))

    it('Should not set any header when headerName is an empty string', async () => {
      const res = await app.request('http://localhost/')
      expect(res.headers.get('X-Response-Time')).toBeNull()
    })
  })

  describe('Error handling', () => {
    const app = new Hono()
    app.use(responseTime())
    app.get('/', () => {
      throw new Error('boom')
    })
    app.onError((_err, c) => c.text('error', 500))

    it('Should still set the header when the handler throws and onError handles it', async () => {
      const res = await app.request('http://localhost/')
      expect(res.status).toBe(500)
      expect(res.headers.get('X-Response-Time')).not.toBeNull()
    })
  })

  describe('Sub-path scoping', () => {
    const app = new Hono()
    app.use('/api/*', responseTime({ headerName: 'X-API-Time' }))
    app.get('/api/hello', (c) => c.text('Hello'))
    app.get('/other', (c) => c.text('Other'))

    it('Should set the header for routes under the middleware path', async () => {
      const res = await app.request('http://localhost/api/hello')
      expect(res.headers.get('X-API-Time')).not.toBeNull()
    })

    it('Should not set the header for routes outside the middleware path', async () => {
      const res = await app.request('http://localhost/other')
      expect(res.headers.get('X-API-Time')).toBeNull()
    })
  })

  describe('Slow route', () => {
    const DELAY_MS = 50
    const TOLERANCE_MS = 40

    const app = new Hono()
    app.use(responseTime({ precision: 2 }))
    app.get('/slow', async (c) => {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS))
      return c.text('slow')
    })

    it('Should report elapsed time plausibly close to the actual handler delay', async () => {
      const res = await app.request('http://localhost/slow')
      expect(res.status).toBe(200)
      const header = res.headers.get('X-Response-Time')!
      expect(header).toMatch(/^\d+\.\d{2}ms$/)
      const reported = parseFloat(header)
      expect(reported).toBeGreaterThanOrEqual(DELAY_MS)
      expect(reported).toBeLessThan(DELAY_MS + TOLERANCE_MS)
    })
  })
})
