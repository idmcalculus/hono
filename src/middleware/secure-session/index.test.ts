import { describe, it, expect } from 'vitest'
import { Hono } from '../../hono'
import { secureSession, seal, unseal, getSession, SessionSizeError, SessionNotFoundError } from '.'
import type { Session, SessionData } from '.'

// Test secrets (32+ characters)
const TEST_SECRET = 'test-secret-that-is-at-least-32-characters-long!'
const TEST_SECRET_2 = 'another-test-secret-32-chars-long-for-rotation!'
const SHORT_SECRET = 'short'

// Helper to extract cookie value from Set-Cookie header
function extractCookieValue(setCookieHeader: string | null, name: string): string | undefined {
  if (!setCookieHeader) return undefined
  const match = setCookieHeader.match(new RegExp(`${name}=([^;]+)`))
  return match ? match[1] : undefined
}

// Helper to create a request with a cookie
function requestWithCookie(url: string, cookie: string): Request {
  const req = new Request(url)
  req.headers.set('Cookie', cookie)
  return req
}

describe('Secure Session Middleware', () => {
  describe('Initialization', () => {
    it('Should throw if secret is not provided', () => {
      expect(() => {
        // @ts-expect-error - Testing invalid options
        secureSession({})
      }).toThrow('Secure session middleware requires a "secret" option')
    })

    it('Should throw if secret is too short', () => {
      expect(() => {
        secureSession({ secret: SHORT_SECRET })
      }).toThrow('too short')
    })

    it('Should throw if any secret in array is too short', () => {
      expect(() => {
        secureSession({
          secret: [TEST_SECRET, SHORT_SECRET],
        })
      }).toThrow('too short')
    })

    it('Should accept single string secret', () => {
      expect(() => {
        secureSession({ secret: TEST_SECRET })
      }).not.toThrow()
    })

    it('Should accept array of secrets for rotation', () => {
      expect(() => {
        secureSession({
          secret: [TEST_SECRET, TEST_SECRET_2],
        })
      }).not.toThrow()
    })
  })

  describe('Session Creation', () => {
    it('Should create new session when no cookie exists', async () => {
      const app = new Hono()
      app.use('*', secureSession({ secret: TEST_SECRET }))
      app.get('/', (c) => {
        const session = getSession(c)
        expect(session.isNew).toBe(true)
        session.set('userId', 123)
        return c.json({ userId: session.get('userId') })
      })

      const res = await app.request('/')
      expect(res.status).toBe(200)
      expect(res.headers.get('set-cookie')).toBeTruthy()
      expect(await res.json()).toEqual({ userId: 123 })
    })

    it('Should set session.isNew to true for new sessions', async () => {
      const app = new Hono()
      app.use('*', secureSession({ secret: TEST_SECRET }))
      app.get('/', (c) => {
        return c.json({ isNew: getSession(c).isNew })
      })

      const res = await app.request('/')
      expect(await res.json()).toEqual({ isNew: true })
    })

    it('Should provide access via c.get("session")', async () => {
      const app = new Hono()
      app.use('*', secureSession({ secret: TEST_SECRET }))
      app.get('/', (c) => {
        const session = c.get('session')
        expect(session).toBeDefined()
        expect(typeof session.destroy).toBe('function')
        expect(typeof session.save).toBe('function')
        return c.text('OK')
      })

      const res = await app.request('/')
      expect(res.status).toBe(200)
    })

    it('Should provide access via c.var.session', async () => {
      const app = new Hono()
      app.use('*', secureSession({ secret: TEST_SECRET }))
      app.get('/', (c) => {
        const session = c.var.session
        expect(session).toBeDefined()
        return c.text('OK')
      })

      const res = await app.request('/')
      expect(res.status).toBe(200)
    })

    it('Should initialize with defaultData', async () => {
      const app = new Hono()
      app.use(
        '*',
        secureSession({
          secret: TEST_SECRET,
          defaultData: { theme: 'dark', locale: 'en' },
        })
      )
      app.get('/', (c) => {
        const session = getSession(c)
        return c.json({ theme: session.get('theme'), locale: session.get('locale') })
      })

      const res = await app.request('/')
      expect(await res.json()).toEqual({ theme: 'dark', locale: 'en' })
    })
  })

  describe('getSession helper', () => {
    it('Should throw SessionNotFoundError if middleware not applied', async () => {
      const app = new Hono()
      app.get('/', (c) => {
        expect(() => getSession(c)).toThrow(SessionNotFoundError)
        return c.text('OK')
      })

      await app.request('/')
    })

    it('SessionNotFoundError should include example code', async () => {
      const app = new Hono()
      app.get('/', (c) => {
        try {
          getSession(c)
        } catch (e) {
          expect(e).toBeInstanceOf(SessionNotFoundError)
          expect((e as Error).message).toContain('secureSession()')
          expect((e as Error).message).toContain("app.use('*', secureSession")
          expect((e as Error).message).toContain("import { secureSession }")
        }
        return c.text('OK')
      })

      await app.request('/')
    })

    it('Should return typed session', async () => {
      interface MySession extends SessionData {
        userId?: number
        name?: string
      }

      const app = new Hono()
      app.use('*', secureSession<MySession>({ secret: TEST_SECRET }))
      app.get('/', (c) => {
        const session = getSession<MySession>(c)
        session.set('userId', 42)
        session.set('name', 'Alice')
        return c.json({
          userId: session.get('userId'),
          name: session.get('name'),
        })
      })

      const res = await app.request('/')
      expect(await res.json()).toEqual({ userId: 42, name: 'Alice' })
    })
  })

  describe('Session Persistence', () => {
    it('Should restore session from existing cookie', async () => {
      const app = new Hono()
      app.use('*', secureSession({ secret: TEST_SECRET }))

      app.get('/set', (c) => {
        const session = getSession(c)
        session.set('user', { id: 1, name: 'Alice' })
        return c.text('OK')
      })

      app.get('/get', (c) => {
        const session = getSession(c)
        return c.json({ user: session.get('user'), isNew: session.isNew })
      })

      // First request - set session
      const res1 = await app.request('/set')
      const cookie = res1.headers.get('set-cookie')
      expect(cookie).toBeTruthy()

      // Second request - get session
      const cookieValue = extractCookieValue(cookie, 'session')
      const req2 = requestWithCookie('http://localhost/get', `session=${cookieValue}`)
      const res2 = await app.request(req2)

      expect(res2.status).toBe(200)
      const data = await res2.json()
      expect(data.user).toEqual({ id: 1, name: 'Alice' })
      expect(data.isNew).toBe(false)
    })

    it('Should preserve session data across requests', async () => {
      const app = new Hono()
      app.use('*', secureSession({ secret: TEST_SECRET }))

      app.get('/increment', (c) => {
        const session = getSession(c)
        const count = (session.get('count') as number) || 0
        session.set('count', count + 1)
        return c.json({ count: session.get('count') })
      })

      // First request
      const res1 = await app.request('/increment')
      expect(await res1.json()).toEqual({ count: 1 })
      const cookie1 = extractCookieValue(res1.headers.get('set-cookie'), 'session')

      // Second request
      const res2 = await app.request(requestWithCookie('http://localhost/increment', `session=${cookie1}`))
      expect(await res2.json()).toEqual({ count: 2 })
      const cookie2 = extractCookieValue(res2.headers.get('set-cookie'), 'session')

      // Third request
      const res3 = await app.request(requestWithCookie('http://localhost/increment', `session=${cookie2}`))
      expect(await res3.json()).toEqual({ count: 3 })
    })

    it('Should auto-save modified sessions', async () => {
      const app = new Hono()
      app.use('*', secureSession({ secret: TEST_SECRET }))
      app.get('/', (c) => {
        getSession(c).set('modified', true)
        return c.text('OK')
      })

      const res = await app.request('/')
      expect(res.headers.get('set-cookie')).toBeTruthy()
    })

    it('Should not save unmodified sessions', async () => {
      const app = new Hono()
      app.use('*', secureSession({ secret: TEST_SECRET }))
      app.get('/', (c) => {
        // Just read session, don't modify
        getSession(c).isNew // Access but don't modify
        return c.text('OK')
      })

      const res = await app.request('/')
      expect(res.headers.get('set-cookie')).toBeNull()
    })
  })

  describe('Data Operations', () => {
    it('Should allow setting and getting session properties via methods', async () => {
      const app = new Hono()
      app.use('*', secureSession({ secret: TEST_SECRET }))
      app.get('/', (c) => {
        const session = getSession(c)
        session.set('string', 'hello')
        session.set('number', 42)
        session.set('boolean', true)
        session.set('array', [1, 2, 3])
        session.set('object', { nested: { value: 'deep' } })
        return c.json({
          string: session.get('string'),
          number: session.get('number'),
          boolean: session.get('boolean'),
          array: session.get('array'),
          object: session.get('object'),
        })
      })

      const res = await app.request('/')
      expect(await res.json()).toEqual({
        string: 'hello',
        number: 42,
        boolean: true,
        array: [1, 2, 3],
        object: { nested: { value: 'deep' } },
      })
    })

    it('Should allow deleting session properties', async () => {
      const app = new Hono()
      app.use('*', secureSession({ secret: TEST_SECRET }))

      app.get('/set', (c) => {
        getSession(c).set('data', 'test')
        return c.text('OK')
      })

      app.get('/delete', (c) => {
        const session = getSession(c)
        const deleted = session.delete('data')
        return c.json({ data: session.get('data'), deleted })
      })

      const res1 = await app.request('/set')
      const cookie = extractCookieValue(res1.headers.get('set-cookie'), 'session')

      const res2 = await app.request(requestWithCookie('http://localhost/delete', `session=${cookie}`))
      expect(await res2.json()).toEqual({ data: undefined, deleted: true })
    })

    it('Should track modifications correctly', async () => {
      const app = new Hono()
      app.use('*', secureSession({ secret: TEST_SECRET }))
      app.get('/', (c) => {
        const session = getSession(c)
        const beforeModify = session.isModified
        session.set('data', 'test')
        const afterModify = session.isModified
        return c.json({ beforeModify, afterModify })
      })

      const res = await app.request('/')
      expect(await res.json()).toEqual({ beforeModify: false, afterModify: true })
    })

    it('Should return session data via getData()', async () => {
      const app = new Hono()
      app.use('*', secureSession({ secret: TEST_SECRET }))
      app.get('/', (c) => {
        const session = getSession(c)
        session.set('a', 1)
        session.set('b', 'two')
        const data = session.getData()
        return c.json(data)
      })

      const res = await app.request('/')
      expect(await res.json()).toEqual({ a: 1, b: 'two' })
    })

    it('Should throw when setting reserved property', async () => {
      const app = new Hono()
      app.use('*', secureSession({ secret: TEST_SECRET }))
      app.get('/', (c) => {
        const session = getSession(c)
        expect(() => session.set('isNew', true)).toThrow('Cannot set reserved session property')
        return c.text('OK')
      })

      await app.request('/')
    })

    it('Should support property access via Proxy (backwards compatibility)', async () => {
      const app = new Hono()
      app.use('*', secureSession({ secret: TEST_SECRET }))
      app.get('/', (c) => {
        const session = c.get('session') as Session & { legacyProp?: string }
        session.legacyProp = 'value'
        return c.json({ legacyProp: session.legacyProp })
      })

      const res = await app.request('/')
      expect(await res.json()).toEqual({ legacyProp: 'value' })
    })

    it('Should support has() method to check key existence', async () => {
      const app = new Hono()
      app.use('*', secureSession({ secret: TEST_SECRET }))
      app.get('/', (c) => {
        const session = getSession(c)
        const beforeSet = session.has('userId')
        session.set('userId', 42)
        const afterSet = session.has('userId')
        session.delete('userId')
        const afterDelete = session.has('userId')
        return c.json({ beforeSet, afterSet, afterDelete })
      })

      const res = await app.request('/')
      expect(await res.json()).toEqual({ beforeSet: false, afterSet: true, afterDelete: false })
    })
  })

  describe('Session Expiration', () => {
    it('Should reject expired sessions', async () => {
      const app = new Hono()
      app.use('*', secureSession({ secret: TEST_SECRET, ttl: 1 })) // 1 second TTL

      app.get('/set', (c) => {
        getSession(c).set('data', 'test')
        return c.text('OK')
      })

      app.get('/get', (c) => {
        const session = getSession(c)
        return c.json({ data: session.get('data'), isNew: session.isNew })
      })

      const res1 = await app.request('/set')
      const cookie = extractCookieValue(res1.headers.get('set-cookie'), 'session')

      // Wait for session to expire
      await new Promise((resolve) => setTimeout(resolve, 1100))

      const res2 = await app.request(requestWithCookie('http://localhost/get', `session=${cookie}`))
      const data = await res2.json()
      expect(data.isNew).toBe(true)
      expect(data.data).toBeUndefined()
    })

    it('Should provide createdAt timestamp', async () => {
      const app = new Hono()
      app.use('*', secureSession({ secret: TEST_SECRET }))
      app.get('/', (c) => {
        const session = getSession(c)
        session.set('touch', true)
        const createdAt = session.createdAt
        expect(createdAt).toBeInstanceOf(Date)
        expect(createdAt.getTime()).toBeLessThanOrEqual(Date.now())
        expect(createdAt.getTime()).toBeGreaterThan(Date.now() - 1000)
        return c.text('OK')
      })

      await app.request('/')
    })

    it('Should provide expiresAt timestamp', async () => {
      const ttl = 3600 // 1 hour
      const app = new Hono()
      app.use('*', secureSession({ secret: TEST_SECRET, ttl }))
      app.get('/', (c) => {
        const session = getSession(c)
        session.set('touch', true)
        const expiresAt = session.expiresAt
        expect(expiresAt).toBeInstanceOf(Date)
        const expectedExpiry = Date.now() + ttl * 1000
        expect(expiresAt.getTime()).toBeGreaterThan(expectedExpiry - 1000)
        expect(expiresAt.getTime()).toBeLessThanOrEqual(expectedExpiry + 1000)
        return c.text('OK')
      })

      await app.request('/')
    })
  })

  describe('Session Destruction', () => {
    it('Should clear cookie on destroy()', async () => {
      const app = new Hono()
      app.use('*', secureSession({ secret: TEST_SECRET }))

      app.get('/set', (c) => {
        getSession(c).set('data', 'test')
        return c.text('OK')
      })

      app.get('/destroy', (c) => {
        getSession(c).destroy()
        return c.text('OK')
      })

      const res1 = await app.request('/set')
      const cookie = extractCookieValue(res1.headers.get('set-cookie'), 'session')

      const res2 = await app.request(requestWithCookie('http://localhost/destroy', `session=${cookie}`))
      const setCookie = res2.headers.get('set-cookie')
      expect(setCookie).toContain('session=')
      expect(setCookie).toContain('Max-Age=0')
    })

    it('Should mark session as destroyed', async () => {
      const app = new Hono()
      app.use('*', secureSession({ secret: TEST_SECRET }))
      app.get('/', (c) => {
        const session = getSession(c)
        session.set('data', 'test')
        const beforeDestroy = session.isDestroyed
        session.destroy()
        const afterDestroy = session.isDestroyed
        return c.json({ beforeDestroy, afterDestroy })
      })

      const res = await app.request('/')
      expect(await res.json()).toEqual({ beforeDestroy: false, afterDestroy: true })
    })
  })

  describe('Secret Rotation', () => {
    it('Should seal with first secret (index 0)', async () => {
      const secrets = [TEST_SECRET, TEST_SECRET_2]
      const data = { test: 'data' }
      const { keyIndex } = await seal(data, secrets)
      expect(keyIndex).toBe(0)
    })

    it('Should unseal with any valid secret', async () => {
      // Seal with new secret (first in array)
      const newSecrets = [TEST_SECRET_2]
      const data = { test: 'data' }
      const { sealed } = await seal(data, newSecrets)

      // Unseal with both secrets available (old secret is now second)
      const allSecrets = [TEST_SECRET, TEST_SECRET_2]
      const { payload, keyIndex } = await unseal(sealed, allSecrets)
      expect(payload).toEqual(data)
      expect(keyIndex).toBe(1) // Found at index 1
    })

    it('Should re-encrypt with new secret on modification', async () => {
      // Create app with single secret
      const app1 = new Hono()
      app1.use('*', secureSession({ secret: TEST_SECRET }))
      app1.get('/set', (c) => {
        getSession(c).set('data', 'test')
        return c.text('OK')
      })

      const res1 = await app1.request('/set')
      const oldCookie = extractCookieValue(res1.headers.get('set-cookie'), 'session')

      // Create app with rotated secrets (new first, old second)
      const app2 = new Hono()
      app2.use('*', secureSession({ secret: [TEST_SECRET_2, TEST_SECRET] }))
      app2.get('/modify', (c) => {
        const session = getSession(c)
        session.set('modified', true)
        return c.json({ data: session.get('data'), modified: session.get('modified') })
      })

      const res2 = await app2.request(requestWithCookie('http://localhost/modify', `session=${oldCookie}`))
      expect(res2.status).toBe(200)
      expect(await res2.json()).toEqual({ data: 'test', modified: true })

      // New cookie should be different (re-encrypted with new key)
      const newCookie = extractCookieValue(res2.headers.get('set-cookie'), 'session')
      expect(newCookie).toBeTruthy()
      expect(newCookie).not.toBe(oldCookie)
    })
  })

  describe('Cookie Size Limit', () => {
    it('Should throw SessionSizeError when limit exceeded', async () => {
      const app = new Hono()
      let caughtError: Error | null = null

      app.use(
        '*',
        secureSession({
          secret: TEST_SECRET,
          cookieSizeLimit: 100, // Very small for testing
        })
      )
      app.get('/', (c) => {
        getSession(c).set('largeData', 'x'.repeat(200))
        return c.text('OK')
      })
      app.onError((err) => {
        caughtError = err
        throw err
      })

      try {
        await app.request('/')
      } catch {
        // Expected
      }

      expect(caughtError).toBeInstanceOf(SessionSizeError)
    })

    it('SessionSizeError should contain size details', async () => {
      const app = new Hono()
      let caughtError: SessionSizeError | null = null

      app.use(
        '*',
        secureSession({
          secret: TEST_SECRET,
          cookieSizeLimit: 100,
        })
      )
      app.get('/', (c) => {
        getSession(c).set('largeData', 'x'.repeat(200))
        return c.text('OK')
      })
      app.onError((err) => {
        if (err instanceof SessionSizeError) {
          caughtError = err
        }
        throw err
      })

      try {
        await app.request('/')
      } catch {
        // Expected
      }

      expect(caughtError).not.toBeNull()
      expect(caughtError!.size).toBeGreaterThan(100)
      expect(caughtError!.limit).toBe(100)
      expect(caughtError!.reduction).toBe(caughtError!.size - caughtError!.limit)
      expect(caughtError!.message).toContain(`Reduce session data by ${caughtError!.reduction} bytes`)
    })

    it('Should enforce absolute 4KB limit', async () => {
      const app = new Hono()
      let caughtError: Error | null = null

      app.use(
        '*',
        secureSession({
          secret: TEST_SECRET,
          cookieSizeLimit: 10000, // Try to set higher than 4KB
        })
      )
      app.get('/', (c) => {
        // Try to store data that would exceed 4KB
        getSession(c).set('largeData', 'x'.repeat(5000))
        return c.text('OK')
      })
      app.onError((err) => {
        caughtError = err
        throw err
      })

      try {
        await app.request('/')
      } catch {
        // Expected
      }

      expect(caughtError).toBeInstanceOf(SessionSizeError)
    })
  })

  describe('Cookie Options', () => {
    it('Should use custom cookie name', async () => {
      const app = new Hono()
      app.use(
        '*',
        secureSession({
          secret: TEST_SECRET,
          cookie: { name: 'custom-session' },
        })
      )
      app.get('/', (c) => {
        getSession(c).set('data', 'test')
        return c.text('OK')
      })

      const res = await app.request('/')
      expect(res.headers.get('set-cookie')).toContain('custom-session=')
    })

    it('Should set HttpOnly flag', async () => {
      const app = new Hono()
      app.use('*', secureSession({ secret: TEST_SECRET }))
      app.get('/', (c) => {
        getSession(c).set('data', 'test')
        return c.text('OK')
      })

      const res = await app.request('/')
      expect(res.headers.get('set-cookie')).toContain('HttpOnly')
    })

    it('Should set Secure flag', async () => {
      const app = new Hono()
      app.use('*', secureSession({ secret: TEST_SECRET, cookie: { secure: true } }))
      app.get('/', (c) => {
        getSession(c).set('data', 'test')
        return c.text('OK')
      })

      const res = await app.request('/')
      expect(res.headers.get('set-cookie')).toContain('Secure')
    })

    it('Should set SameSite attribute', async () => {
      const app = new Hono()
      app.use('*', secureSession({ secret: TEST_SECRET, cookie: { sameSite: 'Strict' } }))
      app.get('/', (c) => {
        getSession(c).set('data', 'test')
        return c.text('OK')
      })

      const res = await app.request('/')
      expect(res.headers.get('set-cookie')).toContain('SameSite=Strict')
    })

    it('Should set path correctly', async () => {
      const app = new Hono()
      app.use('*', secureSession({ secret: TEST_SECRET, cookie: { path: '/app' } }))
      app.get('/', (c) => {
        getSession(c).set('data', 'test')
        return c.text('OK')
      })

      const res = await app.request('/')
      expect(res.headers.get('set-cookie')).toContain('Path=/app')
    })
  })

  describe('Cryptographic Security', () => {
    it('Should produce different seals for same data', async () => {
      const data = { test: 'data' }
      const { sealed: seal1 } = await seal(data, TEST_SECRET)
      const { sealed: seal2 } = await seal(data, TEST_SECRET)

      // Different random IV/salt means different output
      expect(seal1).not.toBe(seal2)

      // But both should unseal to same data
      const { payload: payload1 } = await unseal(seal1, TEST_SECRET)
      const { payload: payload2 } = await unseal(seal2, TEST_SECRET)
      expect(payload1).toEqual(data)
      expect(payload2).toEqual(data)
    })

    it('Should reject tampered cookies', async () => {
      const data = { test: 'data' }
      const { sealed } = await seal(data, TEST_SECRET)

      // Tamper with the sealed data
      const tamperedChars = sealed.split('')
      tamperedChars[50] = tamperedChars[50] === 'a' ? 'b' : 'a'
      const tampered = tamperedChars.join('')

      await expect(unseal(tampered, TEST_SECRET)).rejects.toThrow()
    })

    it('Should reject truncated cookies', async () => {
      const data = { test: 'data' }
      const { sealed } = await seal(data, TEST_SECRET)

      const truncated = sealed.slice(0, sealed.length - 10)
      await expect(unseal(truncated, TEST_SECRET)).rejects.toThrow()
    })

    it('Should reject cookies with wrong key', async () => {
      const data = { test: 'data' }
      const { sealed } = await seal(data, TEST_SECRET)

      await expect(unseal(sealed, TEST_SECRET_2)).rejects.toThrow()
    })
  })

  describe('Edge Cases', () => {
    it('Should handle empty session data', async () => {
      const app = new Hono()
      app.use('*', secureSession({ secret: TEST_SECRET }))

      app.get('/set', (c) => {
        getSession(c).set('empty', true)
        return c.text('OK')
      })

      app.get('/get', (c) => {
        const session = getSession(c)
        return c.json({ keys: Object.keys(session.getData()) })
      })

      const res1 = await app.request('/set')
      const cookie = extractCookieValue(res1.headers.get('set-cookie'), 'session')

      const res2 = await app.request(requestWithCookie('http://localhost/get', `session=${cookie}`))
      expect(await res2.json()).toEqual({ keys: ['empty'] })
    })

    it('Should handle complex nested objects', async () => {
      const app = new Hono()
      app.use('*', secureSession({ secret: TEST_SECRET }))

      const complexData = {
        level1: {
          level2: {
            level3: {
              array: [1, 2, { nested: true }],
              date: '2024-01-01',
            },
          },
        },
      }

      app.get('/set', (c) => {
        getSession(c).set('complex', complexData)
        return c.text('OK')
      })

      app.get('/get', (c) => {
        return c.json({ complex: getSession(c).get('complex') })
      })

      const res1 = await app.request('/set')
      const cookie = extractCookieValue(res1.headers.get('set-cookie'), 'session')

      const res2 = await app.request(requestWithCookie('http://localhost/get', `session=${cookie}`))
      expect(await res2.json()).toEqual({ complex: complexData })
    })

    it('Should handle special characters in data', async () => {
      const app = new Hono()
      app.use('*', secureSession({ secret: TEST_SECRET }))

      const specialData = {
        unicode: '你好世界 🌍',
        quotes: '"hello"',
        newlines: 'line1\nline2',
        tabs: 'col1\tcol2',
      }

      app.get('/set', (c) => {
        const session = getSession(c)
        session.set('unicode', specialData.unicode)
        session.set('quotes', specialData.quotes)
        session.set('newlines', specialData.newlines)
        session.set('tabs', specialData.tabs)
        return c.text('OK')
      })

      app.get('/get', (c) => {
        const session = getSession(c)
        return c.json({
          unicode: session.get('unicode'),
          quotes: session.get('quotes'),
          newlines: session.get('newlines'),
          tabs: session.get('tabs'),
        })
      })

      const res1 = await app.request('/set')
      const cookie = extractCookieValue(res1.headers.get('set-cookie'), 'session')

      const res2 = await app.request(requestWithCookie('http://localhost/get', `session=${cookie}`))
      expect(await res2.json()).toEqual(specialData)
    })

    it('Should handle invalid cookie gracefully', async () => {
      const app = new Hono()
      app.use('*', secureSession({ secret: TEST_SECRET }))
      app.get('/', (c) => {
        const session = getSession(c)
        return c.json({ isNew: session.isNew })
      })

      const req = requestWithCookie('http://localhost/', 'session=invalid-cookie-data')
      const res = await app.request(req)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ isNew: true })
    })

    it('Should handle concurrent modifications', async () => {
      const app = new Hono()
      app.use('*', secureSession({ secret: TEST_SECRET }))
      app.get('/', async (c) => {
        const session = getSession(c)
        session.set('a', 1)
        session.set('b', 2)
        await Promise.resolve() // Simulate async
        session.set('c', 3)
        return c.json({ a: session.get('a'), b: session.get('b'), c: session.get('c') })
      })

      const res = await app.request('/')
      expect(await res.json()).toEqual({ a: 1, b: 2, c: 3 })
    })
  })

  describe('Seal/Unseal Functions', () => {
    it('Should seal and unseal data correctly', async () => {
      const data = { user: { id: 1, name: 'Test' }, token: 'abc123' }
      const { sealed, keyIndex } = await seal(data, TEST_SECRET)

      expect(sealed).toBeTruthy()
      expect(typeof sealed).toBe('string')
      expect(keyIndex).toBe(0)

      const { payload, keyIndex: unsealedKeyIndex } = await unseal(sealed, TEST_SECRET)
      expect(payload).toEqual(data)
      expect(unsealedKeyIndex).toBe(0)
    })

    it('Should throw on empty secrets array', async () => {
      await expect(seal({ test: 'data' }, [])).rejects.toThrow('No secrets provided')
    })

    it('Should throw on invalid base64', async () => {
      await expect(unseal('!!!invalid!!!', TEST_SECRET)).rejects.toThrow()
    })
  })

  describe('Performance', () => {
    it('Should seal and unseal in under 1ms on average', async () => {
      if (!crypto.subtle?.deriveBits) {
        return
      }

      const data = { test: 'data' }
      const iterations = 50
      const seals: string[] = []
      const now = typeof performance === 'undefined' ? () => Date.now() : () => performance.now()

      const sealStart = now()
      for (let i = 0; i < iterations; i++) {
        const { sealed } = await seal(data, TEST_SECRET, false)
        seals.push(sealed)
      }
      const sealAvg = (now() - sealStart) / iterations

      const unsealStart = now()
      for (const sealed of seals) {
        await unseal(sealed, TEST_SECRET)
      }
      const unsealAvg = (now() - unsealStart) / iterations

      expect(sealAvg).toBeLessThan(1)
      expect(unsealAvg).toBeLessThan(1)
    })
  })
})
