import { Hono } from '../../hono'
import { logger } from '.'

describe('Logger by Middleware', () => {
  let app: Hono
  let log: string

  beforeEach(() => {
    function sleep(time: number) {
      return new Promise((resolve) => setTimeout(resolve, time))
    }

    app = new Hono()

    const logFn = (str: string) => {
      log = str
    }

    const shortRandomString = 'hono'
    const longRandomString = 'hono'.repeat(1000)

    app.use('*', logger(logFn))
    app.get('/short', (c) => c.text(shortRandomString))
    app.get('/long', (c) => c.text(longRandomString))
    app.get('/seconds', async (c) => {
      await sleep(1000)

      return c.text(longRandomString)
    })
    app.get('/empty', (c) => c.text(''))
    app.get('/redirect', (c) => {
      return c.redirect('/empty', 301)
    })
    app.get('/server-error', (c) => {
      const res = new Response('', { status: 511 })
      if (c.req.query('status')) {
        // test status code not yet supported by runtime `Response` object
        Object.defineProperty(res, 'status', { value: parseInt(c.req.query('status') as string) })
      }
      return res
    })
  })

  it('Log status 200 with empty body', async () => {
    const res = await app.request('http://localhost/empty')
    expect(res).not.toBeNull()
    expect(res.status).toBe(200)
    expect(log.startsWith('--> GET /empty \x1b[32m200\x1b[0m')).toBe(true)
    expect(log).toMatch(/m?s$/)
  })

  it('Log status 200 with small body', async () => {
    const res = await app.request('http://localhost/short')
    expect(res).not.toBeNull()
    expect(res.status).toBe(200)
    expect(log.startsWith('--> GET /short \x1b[32m200\x1b[0m')).toBe(true)
    expect(log).toMatch(/m?s$/)
  })

  it('Log status 200 with small body and query param', async () => {
    const res = await app.request('http://localhost/short?foo=bar')
    expect(res).not.toBeNull()
    expect(res.status).toBe(200)
    expect(log.startsWith('--> GET /short?foo=bar \x1b[32m200\x1b[0m')).toBe(true)
    expect(log).toMatch(/m?s$/)
  })

  it('Log status 200 with big body', async () => {
    const res = await app.request('http://localhost/long')
    expect(res).not.toBeNull()
    expect(res.status).toBe(200)
    expect(log.startsWith('--> GET /long \x1b[32m200\x1b[0m')).toBe(true)
    expect(log).toMatch(/m?s$/)
  })

  it('Time in seconds', async () => {
    const res = await app.request('http://localhost/seconds')
    expect(res).not.toBeNull()
    expect(res.status).toBe(200)
    expect(log.startsWith('--> GET /seconds \x1b[32m200\x1b[0m')).toBe(true)
    expect(log).toMatch(/1s/)
  })

  it('Log status 301 with empty body', async () => {
    const res = await app.request('http://localhost/redirect')
    expect(res).not.toBeNull()
    expect(res.status).toBe(301)
    expect(log.startsWith('--> GET /redirect \x1b[36m301\x1b[0m')).toBe(true)
    expect(log).toMatch(/m?s$/)
  })

  it('Log status 404', async () => {
    const msg = 'Default 404 Not Found'
    app.all('*', (c) => {
      return c.text(msg, 404)
    })
    const res = await app.request('http://localhost/notfound')
    expect(res).not.toBeNull()
    expect(res.status).toBe(404)
    expect(log.startsWith('--> GET /notfound \x1b[33m404\x1b[0m')).toBe(true)
    expect(log).toMatch(/m?s$/)
  })

  it('Log status 511 with empty body', async () => {
    const res = await app.request('http://localhost/server-error')
    expect(res).not.toBeNull()
    expect(res.status).toBe(511)
    expect(log.startsWith('--> GET /server-error \x1b[31m511\x1b[0m')).toBe(true)
    expect(log).toMatch(/m?s$/)
  })

  it('Log status 100', async () => {
    const res = await app.request('http://localhost/server-error?status=100')
    expect(res).not.toBeNull()
    expect(res.status).toBe(100)
    expect(log.startsWith('--> GET /server-error?status=100 100')).toBe(true)
    expect(log).toMatch(/m?s$/)
  })

  it('Log status 700', async () => {
    const res = await app.request('http://localhost/server-error?status=700')
    expect(res).not.toBeNull()
    expect(res.status).toBe(700)
    expect(log.startsWith('--> GET /server-error?status=700 700')).toBe(true)
    expect(log).toMatch(/m?s$/)
  })
})

describe('Logger by Middleware in JSON mode', () => {
  const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/
  let app: Hono
  let logs: string[]

  beforeEach(() => {
    function sleep(time: number) {
      return new Promise((resolve) => setTimeout(resolve, time))
    }

    app = new Hono()
    logs = []

    const logFn = (str: string) => {
      logs.push(str)
    }

    app.use('*', logger(logFn, { mode: 'json' }))
    app.get('/hello', (c) => c.text('Hello'))
    app.get('/redirect', (c) => c.redirect('/hello', 301))
    app.get('/not-found', (c) => c.text('Not Found', 404))
    app.get('/error', (c) => c.text('Server Error', 500))
    app.get('/seconds', async (c) => {
      await sleep(1000)
      return c.text('slow')
    })
  })

  it('emits valid JSON for incoming and outgoing with timestamp', async () => {
    const res = await app.request('http://localhost/hello')
    expect(res.status).toBe(200)
    expect(logs).toHaveLength(2)

    const incoming = JSON.parse(logs[0])
    expect(incoming.timestamp).toMatch(ISO_8601_RE)
    expect(incoming.direction).toBe('incoming')
    expect(incoming.method).toBe('GET')
    expect(incoming.path).toBe('/hello')
    expect(incoming.level).toBe('info')
    expect(incoming.status).toBeUndefined()
    expect(incoming.elapsed).toBeUndefined()

    const outgoing = JSON.parse(logs[1])
    expect(outgoing.timestamp).toMatch(ISO_8601_RE)
    expect(outgoing.direction).toBe('outgoing')
    expect(outgoing.method).toBe('GET')
    expect(outgoing.path).toBe('/hello')
    expect(outgoing.level).toBe('info')
    expect(outgoing.status).toBe(200)
    expect(outgoing.elapsed).toMatch(/m?s$/)
  })

  it('includes query params in path', async () => {
    const res = await app.request('http://localhost/hello?foo=bar')
    expect(res.status).toBe(200)

    const incoming = JSON.parse(logs[0])
    expect(incoming.path).toBe('/hello?foo=bar')

    const outgoing = JSON.parse(logs[1])
    expect(outgoing.path).toBe('/hello?foo=bar')
  })

  it('records correct status and level for 301 redirect', async () => {
    const res = await app.request('http://localhost/redirect')
    expect(res.status).toBe(301)

    const outgoing = JSON.parse(logs[1])
    expect(outgoing.status).toBe(301)
    expect(outgoing.level).toBe('info')
    expect(outgoing.timestamp).toMatch(ISO_8601_RE)
  })

  it('records correct status and warn level for 404', async () => {
    const res = await app.request('http://localhost/not-found')
    expect(res.status).toBe(404)

    const outgoing = JSON.parse(logs[1])
    expect(outgoing.status).toBe(404)
    expect(outgoing.level).toBe('warn')
    expect(outgoing.timestamp).toMatch(ISO_8601_RE)
  })

  it('records correct status and error level for 500', async () => {
    const res = await app.request('http://localhost/error')
    expect(res.status).toBe(500)

    const outgoing = JSON.parse(logs[1])
    expect(outgoing.status).toBe(500)
    expect(outgoing.level).toBe('error')
    expect(outgoing.timestamp).toMatch(ISO_8601_RE)
  })

  it('elapsed time in seconds for slow responses', async () => {
    const res = await app.request('http://localhost/seconds')
    expect(res.status).toBe(200)

    const outgoing = JSON.parse(logs[1])
    expect(outgoing.elapsed).toMatch(/1s/)
  })

  it('output contains no ANSI color codes', async () => {
    await app.request('http://localhost/hello')
    for (const entry of logs) {
      expect(entry).not.toMatch(/\x1b\[/)
    }
  })
})

describe('Logger by Middleware in JSON mode with default console.log', () => {
  it('uses console.log by default without throwing', async () => {
    const app = new Hono()
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    app.use('*', logger(undefined, { mode: 'json' }))
    app.get('/test', (c) => c.text('ok'))

    const res = await app.request('http://localhost/test')
    expect(res.status).toBe(200)
    expect(consoleSpy).toHaveBeenCalledTimes(2)

    const incomingCall = consoleSpy.mock.calls[0][0]
    const incoming = JSON.parse(incomingCall)
    expect(incoming.direction).toBe('incoming')
    expect(incoming.method).toBe('GET')

    const outgoingCall = consoleSpy.mock.calls[1][0]
    const outgoing = JSON.parse(outgoingCall)
    expect(outgoing.direction).toBe('outgoing')
    expect(outgoing.status).toBe(200)

    consoleSpy.mockRestore()
  })
})

describe('Logger by Middleware in YAML mode', () => {
  const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/
  let app: Hono
  let logs: string[]

  function parseYaml(str: string): Record<string, string> {
    const result: Record<string, string> = {}
    for (const line of str.split('\n')) {
      const idx = line.indexOf(': ')
      if (idx !== -1) {
        const key = line.slice(0, idx)
        let value = line.slice(idx + 2)
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1)
        }
        result[key] = value
      }
    }
    return result
  }

  beforeEach(() => {
    function sleep(time: number) {
      return new Promise((resolve) => setTimeout(resolve, time))
    }

    app = new Hono()
    logs = []

    const logFn = (str: string) => {
      logs.push(str)
    }

    app.use('*', logger(logFn, { mode: 'yaml' }))
    app.get('/hello', (c) => c.text('Hello'))
    app.get('/redirect', (c) => c.redirect('/hello', 301))
    app.get('/not-found', (c) => c.text('Not Found', 404))
    app.get('/error', (c) => c.text('Server Error', 500))
    app.get('/seconds', async (c) => {
      await sleep(1000)
      return c.text('slow')
    })
  })

  it('emits valid YAML for incoming and outgoing with timestamp', async () => {
    const res = await app.request('http://localhost/hello')
    expect(res.status).toBe(200)
    expect(logs).toHaveLength(2)

    const incoming = parseYaml(logs[0])
    expect(incoming.timestamp).toMatch(ISO_8601_RE)
    expect(incoming.direction).toBe('incoming')
    expect(incoming.method).toBe('GET')
    expect(incoming.path).toBe('/hello')
    expect(incoming.level).toBe('info')
    expect(incoming.status).toBeUndefined()
    expect(incoming.elapsed).toBeUndefined()

    const outgoing = parseYaml(logs[1])
    expect(outgoing.timestamp).toMatch(ISO_8601_RE)
    expect(outgoing.direction).toBe('outgoing')
    expect(outgoing.method).toBe('GET')
    expect(outgoing.path).toBe('/hello')
    expect(outgoing.level).toBe('info')
    expect(outgoing.status).toBe('200')
    expect(outgoing.elapsed).toMatch(/m?s$/)
  })

  it('includes query params in path', async () => {
    const res = await app.request('http://localhost/hello?foo=bar')
    expect(res.status).toBe(200)

    const incoming = parseYaml(logs[0])
    expect(incoming.path).toBe('/hello?foo=bar')

    const outgoing = parseYaml(logs[1])
    expect(outgoing.path).toBe('/hello?foo=bar')
  })

  it('records correct status and level for 301 redirect', async () => {
    const res = await app.request('http://localhost/redirect')
    expect(res.status).toBe(301)

    const outgoing = parseYaml(logs[1])
    expect(outgoing.status).toBe('301')
    expect(outgoing.level).toBe('info')
    expect(outgoing.timestamp).toMatch(ISO_8601_RE)
  })

  it('records correct status and warn level for 404', async () => {
    const res = await app.request('http://localhost/not-found')
    expect(res.status).toBe(404)

    const outgoing = parseYaml(logs[1])
    expect(outgoing.status).toBe('404')
    expect(outgoing.level).toBe('warn')
    expect(outgoing.timestamp).toMatch(ISO_8601_RE)
  })

  it('records correct status and error level for 500', async () => {
    const res = await app.request('http://localhost/error')
    expect(res.status).toBe(500)

    const outgoing = parseYaml(logs[1])
    expect(outgoing.status).toBe('500')
    expect(outgoing.level).toBe('error')
    expect(outgoing.timestamp).toMatch(ISO_8601_RE)
  })

  it('elapsed time in seconds for slow responses', async () => {
    const res = await app.request('http://localhost/seconds')
    expect(res.status).toBe(200)

    const outgoing = parseYaml(logs[1])
    expect(outgoing.elapsed).toMatch(/1s/)
  })

  it('output contains no ANSI color codes', async () => {
    await app.request('http://localhost/hello')
    for (const entry of logs) {
      expect(entry).not.toMatch(/\x1b\[/)
    }
  })

  it('each entry is newline-separated key-value pairs', async () => {
    await app.request('http://localhost/hello')
    for (const entry of logs) {
      const lines = entry.split('\n')
      for (const line of lines) {
        expect(line).toMatch(/^\w+: .+$/)
      }
    }
  })
})

describe('Logger by Middleware in NO_COLOR', () => {
  let app: Hono
  let log: string

  beforeEach(() => {
    vi.stubEnv('NO_COLOR', '1')
    function sleep(time: number) {
      return new Promise((resolve) => setTimeout(resolve, time))
    }

    app = new Hono()

    const logFn = (str: string) => {
      log = str
    }

    const shortRandomString = 'hono'
    const longRandomString = 'hono'.repeat(1000)

    app.use('*', logger(logFn))
    app.get('/short', (c) => c.text(shortRandomString))
    app.get('/long', (c) => c.text(longRandomString))
    app.get('/seconds', async (c) => {
      await sleep(1000)

      return c.text(longRandomString)
    })
    app.get('/empty', (c) => c.text(''))
  })
  afterAll(() => {
    vi.unstubAllEnvs()
  })
  it('Log status 200 with empty body', async () => {
    const res = await app.request('http://localhost/empty')
    expect(res).not.toBeNull()
    expect(res.status).toBe(200)
    expect(log.startsWith('--> GET /empty 200')).toBe(true)
    expect(log).toMatch(/m?s$/)
  })

  it('Log status 200 with small body', async () => {
    const res = await app.request('http://localhost/short')
    expect(res).not.toBeNull()
    expect(res.status).toBe(200)
    expect(log.startsWith('--> GET /short 200')).toBe(true)
    expect(log).toMatch(/m?s$/)
  })

  it('Log status 200 with big body', async () => {
    const res = await app.request('http://localhost/long')
    expect(res).not.toBeNull()
    expect(res.status).toBe(200)
    expect(log.startsWith('--> GET /long 200')).toBe(true)
    expect(log).toMatch(/m?s$/)
  })

  it('Time in seconds', async () => {
    const res = await app.request('http://localhost/seconds')
    expect(res).not.toBeNull()
    expect(res.status).toBe(200)
    expect(log.startsWith('--> GET /seconds 200')).toBe(true)
    expect(log).toMatch(/1s/)
  })

  it('Log status 404', async () => {
    const msg = 'Default 404 Not Found'
    app.all('*', (c) => {
      return c.text(msg, 404)
    })
    const res = await app.request('http://localhost/notfound')
    expect(res).not.toBeNull()
    expect(res.status).toBe(404)
    expect(log.startsWith('--> GET /notfound 404')).toBe(true)
    expect(log).toMatch(/m?s$/)
  })
})
