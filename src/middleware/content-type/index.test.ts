import { Hono } from '../../hono'
import { contentType } from '.'

describe('Content Type Middleware', () => {
  let app: Hono

  beforeEach(() => {
    app = new Hono()
    app.use(
      '*',
      contentType({
        allowedTypes: ['application/json', 'text/plain'],
      })
    )
    app.get('/', (c) => c.text('get'))
    app.post('/', (c) => c.text('post'))
    app.put('/', (c) => c.text('put'))
    app.patch('/', (c) => c.text('patch'))
    app.delete('/', (c) => c.text('delete'))
    app.options('/', (c) => c.text('options'))
  })

  describe('methods not in enforcement list', () => {
    it('should pass through GET requests', async () => {
      const res = await app.request('/')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('get')
    })

    it('should pass through HEAD requests', async () => {
      const res = await app.request('/', { method: 'HEAD' })
      expect(res.status).toBe(200)
    })

    it('should pass through OPTIONS requests', async () => {
      const res = await app.request('/', { method: 'OPTIONS' })
      expect(res.status).toBe(200)
    })

    it('should pass through DELETE requests by default', async () => {
      const res = await app.request('/', { method: 'DELETE' })
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('delete')
    })
  })

  describe('allowed content types', () => {
    it('should return 200 for POST with exact match application/json', async () => {
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('post')
    })

    it('should return 200 for POST with application/json; charset=utf-8', async () => {
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      })
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('post')
    })

    it('should return 200 for POST with text/plain', async () => {
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
      })
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('post')
    })

    it('should return 200 for PUT with allowed content type', async () => {
      const res = await app.request('/', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
      })
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('put')
    })

    it('should return 200 for PATCH with allowed content type', async () => {
      const res = await app.request('/', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
      })
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('patch')
    })
  })

  describe('rejected content types', () => {
    it('should return 415 for POST with unsupported content type', async () => {
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'text/html' },
      })
      expect(res.status).toBe(415)
      expect(await res.text()).toBe('Unsupported Media Type')
    })

    it('should return 415 for POST without Content-Type header', async () => {
      const res = await app.request('/', { method: 'POST' })
      expect(res.status).toBe(415)
      expect(await res.text()).toBe('Unsupported Media Type')
    })

    it('should return 415 for PUT with unsupported content type', async () => {
      const res = await app.request('/', {
        method: 'PUT',
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      expect(res.status).toBe(415)
      expect(await res.text()).toBe('Unsupported Media Type')
    })
  })

  describe('wildcard matching', () => {
    beforeEach(() => {
      app = new Hono()
      app.use(
        '*',
        contentType({
          allowedTypes: ['application/*'],
        })
      )
      app.post('/', (c) => c.text('ok'))
    })

    it('should match application/* against application/json', async () => {
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      expect(res.status).toBe(200)
    })

    it('should match application/* against application/xml', async () => {
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml' },
      })
      expect(res.status).toBe(200)
    })

    it('should not match application/* against text/plain', async () => {
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
      })
      expect(res.status).toBe(415)
    })

    it('should match */* against any content type', async () => {
      app = new Hono()
      app.use('*', contentType({ allowedTypes: ['*/*'] }))
      app.post('/', (c) => c.text('ok'))

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'text/html' },
      })
      expect(res.status).toBe(200)
    })

    it('should match bare * as shorthand for */*', async () => {
      app = new Hono()
      app.use('*', contentType({ allowedTypes: ['*'] }))
      app.post('/', (c) => c.text('ok'))

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml' },
      })
      expect(res.status).toBe(200)
    })

    it('should match text/* against text/html and text/csv', async () => {
      app = new Hono()
      app.use('*', contentType({ allowedTypes: ['text/*'] }))
      app.post('/', (c) => c.text('ok'))

      const res1 = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'text/html' },
      })
      expect(res1.status).toBe(200)

      const res2 = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv' },
      })
      expect(res2.status).toBe(200)

      const res3 = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      expect(res3.status).toBe(415)
    })
  })

  describe('case insensitive matching', () => {
    it('should match Application/JSON case-insensitively', async () => {
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'Application/JSON' },
      })
      expect(res.status).toBe(200)
    })

    it('should match APPLICATION/JSON case-insensitively', async () => {
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'APPLICATION/JSON' },
      })
      expect(res.status).toBe(200)
    })
  })

  describe('custom methods option', () => {
    beforeEach(() => {
      app = new Hono()
      app.use(
        '*',
        contentType({
          allowedTypes: ['application/json'],
          methods: ['DELETE'],
        })
      )
      app.post('/', (c) => c.text('post'))
      app.delete('/', (c) => c.text('delete'))
    })

    it('should enforce on DELETE when configured', async () => {
      const res = await app.request('/', {
        method: 'DELETE',
        headers: { 'Content-Type': 'text/plain' },
      })
      expect(res.status).toBe(415)
    })

    it('should not enforce on POST when only DELETE is configured', async () => {
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
      })
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('post')
    })

    it('should handle lowercase method names in options', async () => {
      app = new Hono()
      app.use(
        '*',
        contentType({
          allowedTypes: ['application/json'],
          methods: ['post'],
        })
      )
      app.post('/', (c) => c.text('post'))

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
      })
      expect(res.status).toBe(415)
    })
  })

  describe('custom onError handler', () => {
    it('should use custom error handler when provided', async () => {
      app = new Hono()
      app.use(
        '*',
        contentType({
          allowedTypes: ['application/json'],
          onError: (c) => {
            return c.text('Custom rejection', 400)
          },
        })
      )
      app.post('/', (c) => c.text('ok'))

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'text/html' },
      })
      expect(res.status).toBe(400)
      expect(await res.text()).toBe('Custom rejection')
    })

    it('should invoke custom onError when Content-Type header is missing', async () => {
      app = new Hono()
      app.use(
        '*',
        contentType({
          allowedTypes: ['application/json'],
          onError: (c) => {
            return c.text('Missing Content-Type', 400)
          },
        })
      )
      app.post('/', (c) => c.text('ok'))

      const res = await app.request('/', { method: 'POST' })
      expect(res.status).toBe(400)
      expect(await res.text()).toBe('Missing Content-Type')
    })
  })

  describe('edge cases', () => {
    it('should handle Content-Type with extra whitespace around parameters', async () => {
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json ; charset=utf-8' },
      })
      expect(res.status).toBe(200)
    })

    it('should match multipart/form-data with boundary parameter', async () => {
      app = new Hono()
      app.use(
        '*',
        contentType({
          allowedTypes: ['multipart/form-data'],
        })
      )
      app.post('/', (c) => c.text('ok'))

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=----WebKitFormBoundary' },
      })
      expect(res.status).toBe(200)
    })

    it('should reject all content types when allowedTypes is empty', async () => {
      app = new Hono()
      app.use('*', contentType({ allowedTypes: [] }))
      app.post('/', (c) => c.text('ok'))

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      expect(res.status).toBe(415)
    })

    it('should handle Content-Type with multiple semicolons', async () => {
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8; boundary=test' },
      })
      expect(res.status).toBe(200)
    })
  })

  describe('multiple middleware instances on different routes', () => {
    beforeEach(() => {
      app = new Hono()
      app.use(
        '/api/*',
        contentType({
          allowedTypes: ['application/json'],
        })
      )
      app.use(
        '/upload/*',
        contentType({
          allowedTypes: ['multipart/form-data'],
        })
      )
      app.post('/api/data', (c) => c.text('api'))
      app.post('/upload/file', (c) => c.text('upload'))
    })

    it('should allow application/json on /api/* but reject on /upload/*', async () => {
      const res1 = await app.request('/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      expect(res1.status).toBe(200)
      expect(await res1.text()).toBe('api')

      const res2 = await app.request('/upload/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      expect(res2.status).toBe(415)
    })

    it('should allow multipart/form-data on /upload/* but reject on /api/*', async () => {
      const res1 = await app.request('/upload/file', {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      expect(res1.status).toBe(200)
      expect(await res1.text()).toBe('upload')

      const res2 = await app.request('/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      expect(res2.status).toBe(415)
    })
  })
})
