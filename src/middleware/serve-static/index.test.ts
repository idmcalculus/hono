import { Hono } from '../../hono'
import { serveStatic as baseServeStatic } from '.'

describe('Serve Static Middleware', () => {
  const app = new Hono()
  const getContent = vi.fn(async (path) => {
    if (path.endsWith('not-found.txt')) {
      return null
    }
    return `Hello in ${path}`
  })

  const serveStatic = baseServeStatic({
    getContent,
    isDir: (path) => {
      if (path === 'static/sub' || path === 'static/hello.world') {
        return true
      }
    },
    onFound: (path, c) => {
      if (path.endsWith('hello.html')) {
        c.header('X-Custom', `Found the file at ${path}`)
      }
    },
  })

  app.get('/static/*', serveStatic)

  beforeEach(() => {
    getContent.mockClear()
  })

  it('Should return 200 response - /static/hello.html', async () => {
    const res = await app.request('/static/hello.html')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Encoding')).toBeNull()
    expect(res.headers.get('Content-Type')).toMatch(/^text\/html/)
    expect(await res.text()).toBe('Hello in static/hello.html')
    expect(res.headers.get('X-Custom')).toBe('Found the file at static/hello.html')
  })

  it('Should return 200 response - /static/sub', async () => {
    const res = await app.request('/static/sub')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toMatch(/^text\/html/)
    expect(await res.text()).toBe('Hello in static/sub/index.html')
  })

  it('Should return 200 response - /static/hello.world', async () => {
    const res = await app.request('/static/hello.world')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toMatch(/^text\/html/)
    expect(await res.text()).toBe('Hello in static/hello.world/index.html')
  })

  it('Should decode URI strings - /static/%E7%82%8E.txt', async () => {
    const res = await app.request('/static/%E7%82%8E.txt')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toMatch(/^text\/plain/)
    expect(await res.text()).toBe('Hello in static/炎.txt')
  })

  it('Should return 404 response - /static/not-found.txt', async () => {
    const res = await app.request('/static/not-found.txt')
    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Encoding')).toBeNull()
    expect(res.headers.get('Content-Type')).toMatch(/^text\/plain/)
    expect(await res.text()).toBe('404 Not Found')
    expect(getContent).toBeCalledTimes(1)
  })

  it('Should not allow a directory traversal - /static/%2e%2e/static/hello.html', async () => {
    const res = await app.fetch({
      method: 'GET',
      url: 'http://localhost/static/%2e%2e/static/hello.html',
    } as Request)
    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Type')).toMatch(/^text\/plain/)
    expect(await res.text()).toBe('404 Not Found')
  })

  it('Should return a pre-compressed zstd response - /static/hello.html', async () => {
    const app = new Hono().use(
      '*',
      baseServeStatic({
        getContent,
        precompressed: true,
      })
    )

    const res = await app.request('/static/hello.html', {
      headers: { 'Accept-Encoding': 'zstd' },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Encoding')).toBe('zstd')
    expect(res.headers.get('Vary')).toBe('Accept-Encoding')
    expect(res.headers.get('Content-Type')).toMatch(/^text\/html/)
    expect(await res.text()).toBe('Hello in static/hello.html.zst')
  })

  it('Should return a pre-compressed brotli response - /static/hello.html', async () => {
    const app = new Hono().use(
      '*',
      baseServeStatic({
        getContent,
        precompressed: true,
      })
    )

    const res = await app.request('/static/hello.html', {
      headers: { 'Accept-Encoding': 'wompwomp, gzip, br, deflate, zstd' },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Encoding')).toBe('br')
    expect(res.headers.get('Vary')).toBe('Accept-Encoding')
    expect(res.headers.get('Content-Type')).toMatch(/^text\/html/)
    expect(await res.text()).toBe('Hello in static/hello.html.br')
  })

  it('Should return a pre-compressed brotli response - /static/hello.unknown', async () => {
    const app = new Hono().use(
      '*',
      baseServeStatic({
        getContent,
        precompressed: true,
      })
    )

    const res = await app.request('/static/hello.unknown', {
      headers: { 'Accept-Encoding': 'wompwomp, gzip, br, deflate, zstd' },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Encoding')).toBe('br')
    expect(res.headers.get('Vary')).toBe('Accept-Encoding')
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(await res.text()).toBe('Hello in static/hello.unknown.br')
  })

  it('Should not return a pre-compressed response - /static/not-found.txt', async () => {
    const app = new Hono().use(
      '*',
      baseServeStatic({
        getContent,
        precompressed: true,
      })
    )

    const res = await app.request('/static/not-found.txt', {
      headers: { 'Accept-Encoding': 'gzip, zstd, br' },
    })

    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Encoding')).toBeNull()
    expect(res.headers.get('Vary')).toBeNull()
    expect(res.headers.get('Content-Type')).toMatch(/^text\/plain/)
    expect(await res.text()).toBe('404 Not Found')
  })

  it('Should not return a pre-compressed response - /static/hello.html', async () => {
    const app = new Hono().use(
      '*',
      baseServeStatic({
        getContent,
        precompressed: true,
      })
    )

    const res = await app.request('/static/hello.html', {
      headers: { 'Accept-Encoding': 'wompwomp, unknown' },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Encoding')).toBeNull()
    expect(res.headers.get('Vary')).toBeNull()
    expect(res.headers.get('Content-Type')).toMatch(/^text\/html/)
    expect(await res.text()).toBe('Hello in static/hello.html')
  })

  it('Should not find pre-compressed files - /static/hello.jpg', async () => {
    const app = new Hono().use(
      '*',
      baseServeStatic({
        getContent,
        precompressed: true,
      })
    )

    const res = await app.request('/static/hello.jpg', {
      headers: { 'Accept-Encoding': 'gzip, br, deflate, zstd' },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Encoding')).toBeNull()
    expect(res.headers.get('Vary')).toBeNull()
    expect(res.headers.get('Content-Type')).toMatch(/^image\/jpeg/)
    expect(await res.text()).toBe('Hello in static/hello.jpg')
  })

  it('Should return response object content as-is', async () => {
    const body = new ReadableStream()
    const response = new Response(body)
    const app = new Hono().use(
      '*',
      baseServeStatic({
        getContent: async () => {
          return response
        },
      })
    )

    const res = await app.fetch({
      method: 'GET',
      url: 'http://localhost',
    } as Request)
    expect(res.status).toBe(200)
    expect(res.body).toBe(body)
  })

  describe('Changing root path', () => {
    it('Should return the content with absolute root path', async () => {
      const app = new Hono()
      const serveStatic = baseServeStatic({
        getContent,
        root: '/home/hono/child',
      })
      app.get('/static/*', serveStatic)

      const res = await app.request('/static/html/hello.html')
      expect(await res.text()).toBe('Hello in /home/hono/child/static/html/hello.html')
    })

    it('Should traverse the directories with absolute root path', async () => {
      const app = new Hono()
      const serveStatic = baseServeStatic({
        getContent,
        root: '/home/hono/../parent',
      })
      app.get('/static/*', serveStatic)

      const res = await app.request('/static/html/hello.html')
      expect(await res.text()).toBe('Hello in /home/parent/static/html/hello.html')
    })

    it('Should treat the root path includes .. as relative path', async () => {
      const app = new Hono()
      const serveStatic = baseServeStatic({
        getContent,
        root: '../home/hono',
      })
      app.get('/static/*', serveStatic)

      const res = await app.request('/static/html/hello.html')
      expect(await res.text()).toBe('Hello in ../home/hono/static/html/hello.html')
    })

    it('Should not allow directory traversal with . as relative path', async () => {
      const app = new Hono()
      const serveStatic = baseServeStatic({
        getContent,
        root: '.',
      })
      app.get('*', serveStatic)

      const res = await app.request('///etc/passwd')
      expect(await res.text()).toBe('Hello in etc/passwd')
    })
  })

  describe('Range requests', () => {
    const rangeContent = '0123456789ABCDEFGHIJ' // 20 bytes
    const rangeApp = new Hono()
    rangeApp.use(
      '*',
      baseServeStatic({
        getContent: async (path) => {
          if (path.endsWith('not-found.txt')) {
            return null
          }
          return rangeContent
        },
      })
    )

    it('Should include Accept-Ranges header in response', async () => {
      const res = await rangeApp.request('/static/file.txt')
      expect(res.status).toBe(200)
      expect(res.headers.get('Accept-Ranges')).toBe('bytes')
    })

    it('Should return 206 for valid range bytes=0-9', async () => {
      const res = await rangeApp.request('/static/file.txt', {
        headers: { Range: 'bytes=0-9' },
      })
      expect(res.status).toBe(206)
      expect(res.headers.get('Content-Range')).toBe('bytes 0-9/20')
      expect(res.headers.get('Content-Length')).toBe('10')
      expect(res.headers.get('Accept-Ranges')).toBe('bytes')
      expect(await res.text()).toBe('0123456789')
    })

    it('Should return 206 for valid range bytes=10-19', async () => {
      const res = await rangeApp.request('/static/file.txt', {
        headers: { Range: 'bytes=10-19' },
      })
      expect(res.status).toBe(206)
      expect(res.headers.get('Content-Range')).toBe('bytes 10-19/20')
      expect(res.headers.get('Content-Length')).toBe('10')
      expect(await res.text()).toBe('ABCDEFGHIJ')
    })

    it('Should return 206 for open-ended range bytes=15-', async () => {
      const res = await rangeApp.request('/static/file.txt', {
        headers: { Range: 'bytes=15-' },
      })
      expect(res.status).toBe(206)
      expect(res.headers.get('Content-Range')).toBe('bytes 15-19/20')
      expect(res.headers.get('Content-Length')).toBe('5')
      expect(await res.text()).toBe('FGHIJ')
    })

    it('Should return 206 for suffix range bytes=-5', async () => {
      const res = await rangeApp.request('/static/file.txt', {
        headers: { Range: 'bytes=-5' },
      })
      expect(res.status).toBe(206)
      expect(res.headers.get('Content-Range')).toBe('bytes 15-19/20')
      expect(res.headers.get('Content-Length')).toBe('5')
      expect(await res.text()).toBe('FGHIJ')
    })

    it('Should return 206 for single byte range bytes=5-5', async () => {
      const res = await rangeApp.request('/static/file.txt', {
        headers: { Range: 'bytes=5-5' },
      })
      expect(res.status).toBe(206)
      expect(res.headers.get('Content-Range')).toBe('bytes 5-5/20')
      expect(res.headers.get('Content-Length')).toBe('1')
      expect(await res.text()).toBe('5')
    })

    it('Should clamp end to file size for range bytes=0-100', async () => {
      const res = await rangeApp.request('/static/file.txt', {
        headers: { Range: 'bytes=0-100' },
      })
      expect(res.status).toBe(206)
      expect(res.headers.get('Content-Range')).toBe('bytes 0-19/20')
      expect(res.headers.get('Content-Length')).toBe('20')
      expect(await res.text()).toBe('0123456789ABCDEFGHIJ')
    })

    it('Should return 416 for unsatisfiable range bytes=20-30', async () => {
      const res = await rangeApp.request('/static/file.txt', {
        headers: { Range: 'bytes=20-30' },
      })
      expect(res.status).toBe(416)
      expect(res.headers.get('Content-Range')).toBe('bytes */20')
    })

    it('Should return 416 for unsatisfiable range bytes=100-200', async () => {
      const res = await rangeApp.request('/static/file.txt', {
        headers: { Range: 'bytes=100-200' },
      })
      expect(res.status).toBe(416)
      expect(res.headers.get('Content-Range')).toBe('bytes */20')
    })

    it('Should return 416 for invalid range bytes=10-5 (start > end)', async () => {
      const res = await rangeApp.request('/static/file.txt', {
        headers: { Range: 'bytes=10-5' },
      })
      expect(res.status).toBe(416)
      expect(res.headers.get('Content-Range')).toBe('bytes */20')
    })

    it('Should return 200 for invalid range header format (ignored per RFC 7233)', async () => {
      const res = await rangeApp.request('/static/file.txt', {
        headers: { Range: 'invalid-range' },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Range')).toBeNull()
      expect(await res.text()).toBe('0123456789ABCDEFGHIJ')
    })

    it('Should return 200 for multi-range (ignored per RFC 7233)', async () => {
      const res = await rangeApp.request('/static/file.txt', {
        headers: { Range: 'bytes=0-5, 10-15' },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Range')).toBeNull()
      expect(await res.text()).toBe('0123456789ABCDEFGHIJ')
    })

    it('Should return 200 for non-bytes range unit (ignored per RFC 7233)', async () => {
      const res = await rangeApp.request('/static/file.txt', {
        headers: { Range: 'items=0-5' },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Range')).toBeNull()
      expect(await res.text()).toBe('0123456789ABCDEFGHIJ')
    })

    it('Should work with ArrayBuffer content', async () => {
      const bufferApp = new Hono()
      const encoder = new TextEncoder()
      bufferApp.use(
        '*',
        baseServeStatic({
          getContent: async () => encoder.encode(rangeContent).buffer as ArrayBuffer,
        })
      )

      const res = await bufferApp.request('/static/file.txt', {
        headers: { Range: 'bytes=0-9' },
      })
      expect(res.status).toBe(206)
      expect(res.headers.get('Content-Range')).toBe('bytes 0-9/20')
      expect(await res.text()).toBe('0123456789')
    })

    it('Should work with Uint8Array content', async () => {
      const uint8App = new Hono()
      const encoder = new TextEncoder()
      uint8App.use(
        '*',
        baseServeStatic({
          getContent: async () => encoder.encode(rangeContent),
        })
      )

      const res = await uint8App.request('/static/file.txt', {
        headers: { Range: 'bytes=0-9' },
      })
      expect(res.status).toBe(206)
      expect(res.headers.get('Content-Range')).toBe('bytes 0-9/20')
      expect(await res.text()).toBe('0123456789')
    })

    it('Should work with ReadableStream content (multiple chunks)', async () => {
      const streamApp = new Hono()
      const encoder = new TextEncoder()
      // Split content into multiple chunks to test reassembly
      const chunks = ['01234', '56789', 'ABCDE', 'FGHIJ']
      streamApp.use(
        '*',
        baseServeStatic({
          getContent: async () => {
            let chunkIndex = 0
            return new ReadableStream({
              pull(controller) {
                if (chunkIndex < chunks.length) {
                  controller.enqueue(encoder.encode(chunks[chunkIndex]))
                  chunkIndex++
                } else {
                  controller.close()
                }
              },
            })
          },
        })
      )

      const res = await streamApp.request('/static/file.txt', {
        headers: { Range: 'bytes=0-9' },
      })
      expect(res.status).toBe(206)
      expect(res.headers.get('Content-Range')).toBe('bytes 0-9/20')
      expect(await res.text()).toBe('0123456789')

      // Also test a range that spans multiple chunks
      const res2 = await streamApp.request('/static/file.txt', {
        headers: { Range: 'bytes=3-12' },
      })
      expect(res2.status).toBe(206)
      expect(res2.headers.get('Content-Range')).toBe('bytes 3-12/20')
      expect(await res2.text()).toBe('3456789ABC')
    })
  })
})
