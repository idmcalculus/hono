import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { setSignedCookie } from '../../helper/cookie'
import { Hono } from '../../hono'
import { HTTPException } from '../../http-exception'
import { encodeBase64Url } from '../../utils/encode'
import { Jwt } from '../../utils/jwt'
import type { HonoJsonWebKey } from '../../utils/jwt/jws'
import { signing } from '../../utils/jwt/jws'
import { clearJwksCache, verifyWithJwks } from '../../utils/jwt/jwt'
import type { JWTPayload } from '../../utils/jwt/types'
import { utf8Encoder } from '../../utils/jwt/utf8'
import * as test_keys from './keys.test.json'
import { jwk } from '.'

const verify_keys = test_keys.public_keys

describe('JWK', () => {
  const server = setupServer(
    http.get('http://localhost/.well-known/jwks.json', () => {
      return HttpResponse.json({ keys: verify_keys })
    }),
    http.get('http://localhost/.well-known/missing-jwks.json', () => {
      return HttpResponse.json({})
    }),
    http.get('http://localhost/.well-known/bad-jwks.json', () => {
      return HttpResponse.json({ keys: 'bad-keys' })
    }),
    http.get('http://localhost/.well-known/404-jwks.json', () => {
      return HttpResponse.text('Not Found', { status: 404 })
    })
  )
  beforeAll(() => server.listen())
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  describe('verifyWithJwks', () => {
    it('Should throw error on missing keys/jwks_uri options', async () => {
      const credential = await Jwt.sign({ message: 'hello world' }, test_keys.private_keys[0])
      await expect(verifyWithJwks(credential, { allowedAlgorithms: ['RS256'] })).rejects.toThrow(
        'verifyWithJwks requires options for either "keys" or "jwks_uri" or both'
      )
    })
  })

  describe('options.allow_anon = true', () => {
    let handlerExecuted: boolean

    beforeEach(() => {
      handlerExecuted = false
    })

    const app = new Hono()

    app.use('/backend-auth-or-anon/*', jwk({ keys: verify_keys, allow_anon: true, alg: ['RS256'] }))

    app.get('/backend-auth-or-anon/*', (c) => {
      handlerExecuted = true
      const payload = c.get('jwtPayload')
      return c.json(payload ?? { message: 'hello anon' })
    })

    it('Should skip JWK if no token is present', async () => {
      const req = new Request('http://localhost/backend-auth-or-anon/a')
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ message: 'hello anon' })
      expect(handlerExecuted).toBeTruthy()
    })

    it('Should authorize if token is present', async () => {
      const credential = await Jwt.sign({ message: 'hello world' }, test_keys.private_keys[0])
      const req = new Request('http://localhost/backend-auth-or-anon/a')
      req.headers.set('Authorization', `Bearer ${credential}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ message: 'hello world' })
      expect(handlerExecuted).toBeTruthy()
    })

    it('Should not authorize if bad token is present', async () => {
      const invalidToken =
        'ssyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJtZXNzYWdlIjoiaGVsbG8gd29ybGQifQ.B54pAqIiLbu170tGQ1rY06Twv__0qSHTA0ioQPIOvFE'
      const url = 'http://localhost/backend-auth-or-anon/a'
      const req = new Request(url)
      req.headers.set('Authorization', `Basic ${invalidToken}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toEqual(
        `Bearer realm="${url}",error="invalid_token",error_description="token verification failure"`
      )
      expect(handlerExecuted).toBeFalsy()
    })
  })

  describe('Credentials in header', () => {
    let handlerExecuted: boolean

    beforeEach(() => {
      handlerExecuted = false
    })

    const app = new Hono()

    app.use('/auth-with-keys/*', jwk({ keys: verify_keys, alg: ['RS256'] }))
    app.use('/auth-with-keys-unicode/*', jwk({ keys: verify_keys, alg: ['RS256'] }))
    app.use('/auth-with-keys-nested/*', async (c, next) => {
      const auth = jwk({ keys: verify_keys, alg: ['RS256'] })
      return auth(c, next)
    })
    app.use(
      '/auth-with-keys-fn/*',
      jwk({
        keys: async () => {
          const response = await fetch('http://localhost/.well-known/jwks.json')
          const data = await response.json()
          return data.keys
        },
        alg: ['RS256'],
      })
    )
    app.use(
      '/auth-with-jwks_uri/*',
      jwk({
        jwks_uri: 'http://localhost/.well-known/jwks.json',
        alg: ['RS256'],
      })
    )
    app.use(
      '/auth-with-keys-and-jwks_uri/*',
      jwk({
        keys: verify_keys,
        jwks_uri: () => 'http://localhost/.well-known/jwks.json',
        alg: ['RS256'],
      })
    )
    app.use(
      '/auth-with-missing-jwks_uri/*',
      jwk({
        jwks_uri: 'http://localhost/.well-known/missing-jwks.json',
        alg: ['RS256'],
      })
    )
    app.use(
      '/auth-with-404-jwks_uri/*',
      jwk({
        jwks_uri: 'http://localhost/.well-known/404-jwks.json',
        alg: ['RS256'],
      })
    )
    app.use(
      '/auth-with-bad-jwks_uri/*',
      jwk({
        jwks_uri: 'http://localhost/.well-known/bad-jwks.json',
        alg: ['RS256'],
      })
    )

    app.get('/auth-with-keys/*', (c) => {
      handlerExecuted = true
      const payload = c.get('jwtPayload')
      return c.json(payload)
    })
    app.get('/auth-with-keys-unicode/*', (c) => {
      handlerExecuted = true
      const payload = c.get('jwtPayload')
      return c.json(payload)
    })
    app.get('/auth-with-keys-nested/*', (c) => {
      handlerExecuted = true
      const payload = c.get('jwtPayload')
      return c.json(payload)
    })
    app.get('/auth-with-keys-fn/*', (c) => {
      handlerExecuted = true
      const payload = c.get('jwtPayload')
      return c.json(payload)
    })
    app.get('/auth-with-jwks_uri/*', (c) => {
      handlerExecuted = true
      const payload = c.get('jwtPayload')
      return c.json(payload)
    })
    app.get('/auth-with-keys-and-jwks_uri/*', (c) => {
      handlerExecuted = true
      const payload = c.get('jwtPayload')
      return c.json(payload)
    })
    app.get('/auth-with-missing-jwks_uri/*', (c) => {
      handlerExecuted = true
      const payload = c.get('jwtPayload')
      return c.json(payload)
    })
    app.get('/auth-with-404-jwks_uri/*', (c) => {
      handlerExecuted = true
      const payload = c.get('jwtPayload')
      return c.json(payload)
    })
    app.get('/auth-with-bad-jwks_uri/*', (c) => {
      handlerExecuted = true
      const payload = c.get('jwtPayload')
      return c.json(payload)
    })

    it('Should throw an error if the middleware is missing both keys and jwks_uri (empty)', async () => {
      // @ts-expect-error - Testing runtime error with missing required alg option
      expect(() => app.use('/auth-with-empty-middleware/*', jwk({}))).toThrow(
        'JWK auth middleware requires options for either "keys" or "jwks_uri"'
      )
    })

    it('Should throw an error when crypto.subtle is missing', async () => {
      const subtleSpy = vi.spyOn(global.crypto, 'subtle', 'get').mockReturnValue({
        importKey: undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      expect(() =>
        app.use('/auth-with-bad-env/*', jwk({ keys: verify_keys, alg: ['RS256'] }))
      ).toThrow()
      subtleSpy.mockRestore()
    })

    it('Should return a server error if options.jwks_uri returns a 404', async () => {
      const credential = await Jwt.sign({ message: 'hello world' }, test_keys.private_keys[0])
      const req = new Request('http://localhost/auth-with-404-jwks_uri/a')
      req.headers.set('Authorization', `Basic ${credential}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(500)
    })

    it('Should return a server error if the remotely fetched keys from options.jwks_uri are missing', async () => {
      const credential = await Jwt.sign({ message: 'hello world' }, test_keys.private_keys[0])
      const req = new Request('http://localhost/auth-with-missing-jwks_uri/a')
      req.headers.set('Authorization', `Basic ${credential}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(500)
    })

    it('Should return a server error if the remotely fetched keys from options.jwks_uri are malformed', async () => {
      const credential = await Jwt.sign({ message: 'hello world' }, test_keys.private_keys[0])
      const req = new Request('http://localhost/auth-with-bad-jwks_uri/a')
      req.headers.set('Authorization', `Basic ${credential}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(500)
    })

    it('Should not authorize requests with missing access token', async () => {
      const req = new Request('http://localhost/auth-with-keys/a')
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(401)
      expect(await res.text()).toBe('Unauthorized')
      expect(handlerExecuted).toBeFalsy()
    })

    it('Should authorize from a static array passed to options.keys (key 1)', async () => {
      const credential = await Jwt.sign({ message: 'hello world' }, test_keys.private_keys[0])
      const req = new Request('http://localhost/auth-with-keys/a')
      req.headers.set('Authorization', `Bearer ${credential}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ message: 'hello world' })
      expect(handlerExecuted).toBeTruthy()
    })

    it('Should authorize from a static array passed to options.keys (key 2)', async () => {
      const credential = await Jwt.sign({ message: 'hello world' }, test_keys.private_keys[1])
      const req = new Request('http://localhost/auth-with-keys/a')
      req.headers.set('Authorization', `Bearer ${credential}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ message: 'hello world' })
      expect(handlerExecuted).toBeTruthy()
      expect(res.status).toBe(200)
    })

    it('Should not authorize a token without header', async () => {
      const encodeJwtPart = (part: unknown): string =>
        encodeBase64Url(utf8Encoder.encode(JSON.stringify(part)).buffer).replace(/=/g, '')
      const encodeSignaturePart = (buf: ArrayBufferLike): string =>
        encodeBase64Url(buf).replace(/=/g, '')
      const jwtSignWithoutHeader = async (payload: JWTPayload, privateKey: HonoJsonWebKey) => {
        const encodedPayload = encodeJwtPart(payload)
        const signaturePart = await signing(
          privateKey,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          privateKey.alg as any,
          utf8Encoder.encode(encodedPayload)
        )
        const signature = encodeSignaturePart(signaturePart)
        return `${encodedPayload}.${signature}`
      }
      const credential = await jwtSignWithoutHeader(
        { message: 'hello world' },
        test_keys.private_keys[1]
      )
      const req = new Request('http://localhost/auth-with-keys/a')
      req.headers.set('Authorization', `Bearer ${credential}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(401)
    })

    it('Should not authorize a token with missing "kid" in header', async () => {
      const encodeJwtPart = (part: unknown): string =>
        encodeBase64Url(utf8Encoder.encode(JSON.stringify(part)).buffer).replace(/=/g, '')
      const encodeSignaturePart = (buf: ArrayBufferLike): string =>
        encodeBase64Url(buf).replace(/=/g, '')
      const jwtSignWithoutKid = async (payload: JWTPayload, privateKey: HonoJsonWebKey) => {
        const encodedPayload = encodeJwtPart(payload)
        const encodedHeader = encodeJwtPart({ alg: privateKey.alg, typ: 'JWT' })
        const partialToken = `${encodedHeader}.${encodedPayload}`
        const signaturePart = await signing(
          privateKey,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          privateKey.alg as any,
          utf8Encoder.encode(partialToken)
        )
        const signature = encodeSignaturePart(signaturePart)
        return `${partialToken}.${signature}`
      }
      const credential = await jwtSignWithoutKid(
        { message: 'hello world' },
        test_keys.private_keys[1]
      )
      const req = new Request('http://localhost/auth-with-keys/a')
      req.headers.set('Authorization', `Bearer ${credential}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(401)
    })

    it('Should not authorize a token with invalid "kid" in header', async () => {
      const copy = structuredClone(test_keys.private_keys[1])
      copy.kid = 'invalid-kid'
      const credential = await Jwt.sign({ message: 'hello world' }, copy)
      const req = new Request('http://localhost/auth-with-keys/a')
      req.headers.set('Authorization', `Bearer ${credential}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(401)
    })

    it('Should authorize with Unicode payload from a static array passed to options.keys', async () => {
      const credential = await Jwt.sign({ message: 'hello world' }, test_keys.private_keys[0])
      const req = new Request('http://localhost/auth-with-keys-unicode/a')
      req.headers.set('Authorization', `Basic ${credential}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ message: 'hello world' })
      expect(handlerExecuted).toBeTruthy()
    })

    it('Should authorize from a function passed to options.keys', async () => {
      const credential = await Jwt.sign({ message: 'hello world' }, test_keys.private_keys[0])
      const req = new Request('http://localhost/auth-with-keys-fn/a')
      req.headers.set('Authorization', `Basic ${credential}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ message: 'hello world' })
      expect(handlerExecuted).toBeTruthy()
    })

    it('Should authorize from keys remotely fetched from options.jwks_uri', async () => {
      const credential = await Jwt.sign({ message: 'hello world' }, test_keys.private_keys[0])
      const req = new Request('http://localhost/auth-with-jwks_uri/a')
      req.headers.set('Authorization', `Basic ${credential}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ message: 'hello world' })
      expect(handlerExecuted).toBeTruthy()
    })

    it('Should authorize from keys and hard-coded and remotely fetched from options.jwks_uri', async () => {
      const credential = await Jwt.sign({ message: 'hello world' }, test_keys.private_keys[0])
      const req = new Request('http://localhost/auth-with-keys-and-jwks_uri/a')
      req.headers.set('Authorization', `Basic ${credential}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ message: 'hello world' })
      expect(handlerExecuted).toBeTruthy()
    })

    it('Should not authorize requests with invalid Unicode payload in header', async () => {
      const invalidToken =
        'ssyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJtZXNzYWdlIjoiaGVsbG8gd29ybGQifQ.B54pAqIiLbu170tGQ1rY06Twv__0qSHTA0ioQPIOvFE'
      const url = 'http://localhost/auth-with-keys-unicode/a'
      const req = new Request(url)
      req.headers.set('Authorization', `Basic ${invalidToken}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toEqual(
        `Bearer realm="${url}",error="invalid_token",error_description="token verification failure"`
      )
      expect(handlerExecuted).toBeFalsy()
    })

    it('Should not authorize requests with malformed token structure in header', async () => {
      const invalid_token = 'invalid token'
      const url = 'http://localhost/auth-with-keys/a'
      const req = new Request(url)
      req.headers.set('Authorization', `Bearer ${invalid_token}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toEqual(
        `Bearer realm="${url}",error="invalid_request",error_description="invalid credentials structure"`
      )
      expect(handlerExecuted).toBeFalsy()
    })

    it('Should not authorize requests without authorization in nested JWK middleware', async () => {
      const req = new Request('http://localhost/auth-with-keys-nested/a')
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(401)
      expect(await res.text()).toBe('Unauthorized')
      expect(handlerExecuted).toBeFalsy()
    })

    it('Should authorize requests with authorization in nested JWK middleware', async () => {
      const credential = await Jwt.sign({ message: 'hello world' }, test_keys.private_keys[0])
      const req = new Request('http://localhost/auth-with-keys-nested/a')
      req.headers.set('Authorization', `Bearer ${credential}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ message: 'hello world' })
      expect(handlerExecuted).toBeTruthy()
    })
  })

  describe('Credentials in custom header', () => {
    let handlerExecuted: boolean

    beforeEach(() => {
      handlerExecuted = false
    })

    const app = new Hono()

    app.use(
      '/auth-with-keys/*',
      jwk({ keys: verify_keys, headerName: 'x-custom-auth-header', alg: ['RS256'] })
    )

    app.get('/auth-with-keys/*', (c) => {
      handlerExecuted = true
      const payload = c.get('jwtPayload')
      return c.json(payload)
    })

    it('Should not authorize', async () => {
      const req = new Request('http://localhost/auth-with-keys/a')
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(401)
      expect(await res.text()).toBe('Unauthorized')
      expect(handlerExecuted).toBeFalsy()
    })

    it('Should not authorize even if default authorization header present', async () => {
      const credential = await Jwt.sign({ message: 'hello world' }, test_keys.private_keys[0])

      const req = new Request('http://localhost/auth-with-keys/a')
      req.headers.set('Authorization', `Bearer ${credential}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(401)
      expect(await res.text()).toBe('Unauthorized')
      expect(handlerExecuted).toBeFalsy()
    })

    it('Should authorize', async () => {
      const credential = await Jwt.sign({ message: 'hello world' }, test_keys.private_keys[1])

      const req = new Request('http://localhost/auth-with-keys/a')
      req.headers.set('x-custom-auth-header', `Bearer ${credential}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ message: 'hello world' })
      expect(handlerExecuted).toBeTruthy()
    })
  })

  describe('Credentials in cookie', () => {
    let handlerExecuted: boolean

    beforeEach(() => {
      handlerExecuted = false
    })

    const app = new Hono()

    app.use('/auth-with-keys/*', jwk({ keys: verify_keys, cookie: 'access_token', alg: ['RS256'] }))
    app.use(
      '/auth-with-keys-unicode/*',
      jwk({ keys: verify_keys, cookie: 'access_token', alg: ['RS256'] })
    )
    app.use(
      '/auth-with-keys-prefixed/*',
      jwk({
        keys: verify_keys,
        cookie: { key: 'access_token', prefixOptions: 'host' },
        alg: ['RS256'],
      })
    )
    app.use(
      '/auth-with-keys-unprefixed/*',
      jwk({ keys: verify_keys, cookie: { key: 'access_token' }, alg: ['RS256'] })
    )

    app.get('/auth-with-keys/*', (c) => {
      handlerExecuted = true
      const payload = c.get('jwtPayload')
      return c.json(payload)
    })
    app.get('/auth-with-keys-prefixed/*', (c) => {
      handlerExecuted = true
      const payload = c.get('jwtPayload')
      return c.json(payload)
    })
    app.get('/auth-with-keys-unprefixed/*', (c) => {
      handlerExecuted = true
      const payload = c.get('jwtPayload')
      return c.json(payload)
    })
    app.get('/auth-with-keys-unicode/*', (c) => {
      handlerExecuted = true
      const payload = c.get('jwtPayload')
      return c.json(payload)
    })

    it('Should not authorize requests with missing access token', async () => {
      const req = new Request('http://localhost/auth-with-keys/a')
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(401)
      expect(await res.text()).toBe('Unauthorized')
      expect(handlerExecuted).toBeFalsy()
    })

    it('Should authorize cookie from a static array passed to options.keys', async () => {
      const url = 'http://localhost/auth-with-keys/a'
      const credential = await Jwt.sign({ message: 'hello world' }, test_keys.private_keys[0])
      const req = new Request(url, {
        headers: new Headers({
          Cookie: `access_token=${credential}`,
        }),
      })
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(await res.json()).toEqual({ message: 'hello world' })
      expect(res.status).toBe(200)
      expect(handlerExecuted).toBeTruthy()
    })

    it('Should authorize prefixed cookie from a static array passed to options.keys', async () => {
      const url = 'http://localhost/auth-with-keys-prefixed/a'
      const credential = await Jwt.sign({ message: 'hello world' }, test_keys.private_keys[0])
      const req = new Request(url, {
        headers: new Headers({
          Cookie: `__Host-access_token=${credential}`,
        }),
      })
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(await res.json()).toEqual({ message: 'hello world' })
      expect(res.status).toBe(200)
      expect(handlerExecuted).toBeTruthy()
    })

    it('Should authorize unprefixed cookie from a static array passed to options.keys', async () => {
      const url = 'http://localhost/auth-with-keys-unprefixed/a'
      const credential = await Jwt.sign({ message: 'hello world' }, test_keys.private_keys[0])
      const req = new Request(url, {
        headers: new Headers({
          Cookie: `access_token=${credential}`,
        }),
      })
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(await res.json()).toEqual({ message: 'hello world' })
      expect(res.status).toBe(200)
      expect(handlerExecuted).toBeTruthy()
    })

    it('Should authorize with Unicode payload from a static array passed to options.keys', async () => {
      const credential = await Jwt.sign({ message: 'hello world' }, test_keys.private_keys[0])
      const req = new Request('http://localhost/auth-with-keys-unicode/a', {
        headers: new Headers({
          Cookie: `access_token=${credential}`,
        }),
      })
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ message: 'hello world' })
      expect(handlerExecuted).toBeTruthy()
    })

    it('Should not authorize requests with invalid Unicode payload in cookie', async () => {
      const invalidToken =
        'ssyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJtZXNzYWdlIjoiaGVsbG8gd29ybGQifQ.B54pAqIiLbu170tGQ1rY06Twv__0qSHTA0ioQPIOvFE'

      const url = 'http://localhost/auth-with-keys-unicode/a'
      const req = new Request(url)
      req.headers.set('Cookie', `access_token=${invalidToken}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toEqual(
        `Bearer realm="${url}",error="invalid_token",error_description="token verification failure"`
      )
      expect(handlerExecuted).toBeFalsy()
    })

    it('Should not authorize requests with malformed token structure in cookie', async () => {
      const invalidToken = 'invalid token'
      const url = 'http://localhost/auth-with-keys/a'
      const req = new Request(url)
      req.headers.set('Cookie', `access_token=${invalidToken}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toEqual(
        `Bearer realm="${url}",error="invalid_token",error_description="token verification failure"`
      )
      expect(handlerExecuted).toBeFalsy()
    })
  })

  describe('Credentials in a signed cookie', () => {
    let handlerExecuted: boolean

    beforeEach(() => {
      handlerExecuted = false
    })

    const app = new Hono()
    const test_secret = 'Shhh'

    app.use(
      '/auth-with-signed-cookie/*',
      jwk({
        keys: verify_keys,
        cookie: { key: 'access_token', secret: test_secret },
        alg: ['RS256'],
      })
    )
    app.use(
      '/auth-with-signed-with-prefix-options-cookie/*',
      jwk({
        keys: verify_keys,
        cookie: { key: 'access_token', secret: test_secret, prefixOptions: 'host' },
        alg: ['RS256'],
      })
    )

    app.get('/sign-cookie', async (c) => {
      const credential = await Jwt.sign(
        { message: 'signed hello world' },
        test_keys.private_keys[0]
      )
      await setSignedCookie(c, 'access_token', credential, test_secret)
      return c.text('OK')
    })
    app.get('/sign-cookie-with-prefix', async (c) => {
      const credential = await Jwt.sign(
        { message: 'signed hello world' },
        test_keys.private_keys[0]
      )
      await setSignedCookie(c, 'access_token', credential, test_secret, { prefix: 'host' })
      return c.text('OK')
    })
    app.get('/auth-with-signed-cookie/*', async (c) => {
      handlerExecuted = true
      const payload = c.get('jwtPayload')
      return c.json(payload)
    })
    app.get('/auth-with-signed-with-prefix-options-cookie/*', async (c) => {
      handlerExecuted = true
      const payload = c.get('jwtPayload')
      return c.json(payload)
    })

    it('Should authorize signed cookie', async () => {
      const url = 'http://localhost/auth-with-signed-cookie/a'
      const sign_res = await app.request('http://localhost/sign-cookie')
      const cookieHeader = sign_res.headers.get('Set-Cookie') as string
      expect(cookieHeader).not.toBeNull()
      const req = new Request(url)
      req.headers.set('Cookie', cookieHeader)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ message: 'signed hello world' })
      expect(handlerExecuted).toBeTruthy()
    })

    it('Should authorize prefixed signed cookie', async () => {
      const url = 'http://localhost/auth-with-signed-with-prefix-options-cookie/a'
      const sign_res = await app.request('http://localhost/sign-cookie-with-prefix')
      const cookieHeader = sign_res.headers.get('Set-Cookie') as string
      expect(cookieHeader).not.toBeNull()
      const req = new Request(url)
      req.headers.set('Cookie', cookieHeader)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ message: 'signed hello world' })
      expect(handlerExecuted).toBeTruthy()
    })

    it('Should not authorize an unsigned cookie', async () => {
      const url = 'http://localhost/auth-with-signed-cookie/a'
      const credential = await Jwt.sign(
        { message: 'unsigned hello world' },
        test_keys.private_keys[0]
      )
      const unsignedCookie = `access_token=${credential}`
      const req = new Request(url)
      req.headers.set('Cookie', unsignedCookie)
      const res = await app.request(req)
      expect(res.status).toBe(401)
      expect(await res.text()).toBe('Unauthorized')
      expect(handlerExecuted).toBeFalsy()
    })
  })

  describe('Error handling with `cause`', () => {
    const app = new Hono()

    app.use('/auth-with-keys/*', jwk({ keys: verify_keys, alg: ['RS256'] }))
    app.get('/auth-with-keys/*', (c) => c.text('Authorized'))

    app.onError((e, c) => {
      if (e instanceof HTTPException && e.cause instanceof Error) {
        return c.json({ name: e.cause.name, message: e.cause.message }, 401)
      }
      return c.text(e.message, 401)
    })

    it('Should not authorize', async () => {
      const credential = 'abc.def.ghi'
      const req = new Request('http://localhost/auth-with-keys')
      req.headers.set('Authorization', `Bearer ${credential}`)
      const res = await app.request(req)
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({
        name: 'JwtTokenInvalid',
        message: `invalid JWT token: ${credential}`,
      })
    })
  })

  describe('Verification of token attributes', () => {
    let handlerExecuted: boolean

    beforeEach(() => {
      handlerExecuted = false
    })

    function inFuture() {
      return Date.now() / 1000 + 100
    }

    function inPast() {
      return Date.now() / 1000 - 100
    }

    const app = new Hono()

    app.use('/auth-with-keys-default/*', jwk({ keys: verify_keys, alg: ['RS256'] }))
    app.use(
      '/auth-with-keys-and-issuer/*',
      jwk({ keys: verify_keys, verification: { iss: 'http://issuer.test' }, alg: ['RS256'] })
    )

    app.get('/auth-with-keys-default/*', (c) => {
      handlerExecuted = true
      const payload = c.get('jwtPayload')
      return c.json(payload)
    })
    app.get('/auth-with-keys-and-issuer/*', (c) => {
      handlerExecuted = true
      const payload = c.get('jwtPayload')
      return c.json(payload)
    })

    it('Should validate exp/nbf/iat and pass when good by default', async () => {
      const payload = {
        exp: inFuture(),
        nbf: inPast(),
        iat: inPast(),
        iss: 'http://not-checked.test',
      }
      const credential = await Jwt.sign(payload, test_keys.private_keys[0])
      const req = new Request('http://localhost/auth-with-keys-default/a')
      req.headers.set('Authorization', `Basic ${credential}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(payload)
      expect(handlerExecuted).toBeTruthy()
    })

    it('Should validate exp and fail when bad', async () => {
      const payload = {
        exp: inPast(),
      }
      const credential = await Jwt.sign(payload, test_keys.private_keys[0])
      const req = new Request('http://localhost/auth-with-keys-default/a')
      req.headers.set('Authorization', `Basic ${credential}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(401)
      expect(handlerExecuted).toBeFalsy()
    })

    it('Should validate nbf and fail when bad', async () => {
      const payload = {
        nbf: inFuture(),
      }
      const credential = await Jwt.sign(payload, test_keys.private_keys[0])
      const req = new Request('http://localhost/auth-with-keys-default/a')
      req.headers.set('Authorization', `Basic ${credential}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(401)
      expect(handlerExecuted).toBeFalsy()
    })

    it('Should validate iat and fail when bad', async () => {
      const payload = {
        iat: inFuture(),
      }
      const credential = await Jwt.sign(payload, test_keys.private_keys[0])
      const req = new Request('http://localhost/auth-with-keys-default/a')
      req.headers.set('Authorization', `Basic ${credential}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(401)
      expect(handlerExecuted).toBeFalsy()
    })

    it('Should validate iss when supplied', async () => {
      const payload = {
        iss: 'http://issuer.test',
      }
      const credential = await Jwt.sign(payload, test_keys.private_keys[0])
      const req = new Request('http://localhost/auth-with-keys-and-issuer/a')
      req.headers.set('Authorization', `Basic ${credential}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(payload)
      expect(handlerExecuted).toBeTruthy()
    })

    it('Should reject missing iss when required', async () => {
      const payload = {
        // Nothing
      }
      const credential = await Jwt.sign(payload, test_keys.private_keys[0])
      const req = new Request('http://localhost/auth-with-keys-and-issuer/a')
      req.headers.set('Authorization', `Basic ${credential}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(401)
      expect(handlerExecuted).toBeFalsy()
    })

    it('Should reject iss when different', async () => {
      const payload = {
        iss: 'http://bad-issuer.test',
      }
      const credential = await Jwt.sign(payload, test_keys.private_keys[0])
      const req = new Request('http://localhost/auth-with-keys-and-issuer/a')
      req.headers.set('Authorization', `Basic ${credential}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(401)
      expect(handlerExecuted).toBeFalsy()
    })
  })

  describe('Algorithm whitelist (options.alg)', () => {
    let handlerExecuted: boolean

    beforeEach(() => {
      handlerExecuted = false
    })

    const app = new Hono()

    // Only allow RS256
    app.use('/auth-whitelist-rs256/*', jwk({ keys: verify_keys, alg: ['RS256'] }))
    app.get('/auth-whitelist-rs256/*', (c) => {
      handlerExecuted = true
      return c.json(c.get('jwtPayload'))
    })

    // Allow multiple algorithms
    app.use('/auth-whitelist-multi/*', jwk({ keys: verify_keys, alg: ['RS256', 'ES256'] }))
    app.get('/auth-whitelist-multi/*', (c) => {
      handlerExecuted = true
      return c.json(c.get('jwtPayload'))
    })

    // Note: Test for "no whitelist" was removed because alg is now required.
    // This is a breaking change that enforces explicit algorithm specification for security.

    it('Should authorize RS256 token when RS256 is in whitelist', async () => {
      const payload = { message: 'hello world' }
      const credential = await Jwt.sign(payload, test_keys.private_keys[0]) // RS256 key
      const req = new Request('http://localhost/auth-whitelist-rs256/a')
      req.headers.set('Authorization', `Bearer ${credential}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(payload)
      expect(handlerExecuted).toBeTruthy()
    })

    it('Should reject token when algorithm is not in whitelist', async () => {
      // Create a token with ES256 algorithm manually
      const kid = 'hono-test-kid-1' // Use existing kid but header will have different alg
      const payload = { message: 'hello world' }

      // Generate ES256 key pair for signing
      const keyPair = await crypto.subtle.generateKey(
        {
          name: 'ECDSA',
          namedCurve: 'P-256',
        },
        true,
        ['sign', 'verify']
      )

      // Create JWT with ES256
      const header = { alg: 'ES256', typ: 'JWT', kid }
      const encode = (obj: object) =>
        encodeBase64Url(utf8Encoder.encode(JSON.stringify(obj)).buffer)
      const encodedHeader = encode(header)
      const encodedPayload = encode(payload)
      const signingInput = `${encodedHeader}.${encodedPayload}`

      const signatureBuffer = await signing(
        keyPair.privateKey,
        'ES256',
        utf8Encoder.encode(signingInput)
      )
      const signature = encodeBase64Url(signatureBuffer)

      const token = `${encodedHeader}.${encodedPayload}.${signature}`

      const url = 'http://localhost/auth-whitelist-rs256/a'
      const req = new Request(url)
      req.headers.set('Authorization', `Bearer ${token}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toMatch(/token verification failure/)
      expect(handlerExecuted).toBeFalsy()
    })

    it('Should authorize RS256 token when multiple algorithms are in whitelist', async () => {
      const payload = { message: 'hello world' }
      const credential = await Jwt.sign(payload, test_keys.private_keys[0]) // RS256 key
      const req = new Request('http://localhost/auth-whitelist-multi/a')
      req.headers.set('Authorization', `Bearer ${credential}`)
      const res = await app.request(req)
      expect(res).not.toBeNull()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(payload)
      expect(handlerExecuted).toBeTruthy()
    })

    // Note: Test for "no whitelist" was removed because alg is now required.
    // This is a breaking change that enforces explicit algorithm specification for security.
  })

  describe('JWKS caching', () => {
    let fetchCount: number
    let fetchCountB: number

    beforeEach(() => {
      fetchCount = 0
      fetchCountB = 0
      clearJwksCache()
    })

    // Register handlers on the shared outer `server` so there is a single MSW
    // server instance for the entire test file.  Handlers added here are merged
    // with the top-level ones and are reset after each test via afterEach.
    beforeEach(() => {
      server.use(
        http.get('http://localhost/.well-known/cached-jwks.json', () => {
          fetchCount++
          return HttpResponse.json({ keys: verify_keys })
        }),
        http.get('http://localhost/.well-known/cached-jwks-b.json', () => {
          fetchCountB++
          return HttpResponse.json({ keys: verify_keys })
        })
      )
    })

    it('Should fetch JWKS on every request when cache is not configured', async () => {
      const app = new Hono()
      app.use(
        '/no-cache/*',
        jwk({
          jwks_uri: 'http://localhost/.well-known/cached-jwks.json',
          alg: ['RS256'],
        })
      )
      app.get('/no-cache/*', (c) => c.json(c.get('jwtPayload')))

      const credential = await Jwt.sign({ message: 'hello' }, test_keys.private_keys[0])

      const req1 = new Request('http://localhost/no-cache/a')
      req1.headers.set('Authorization', `Bearer ${credential}`)
      await app.request(req1)

      const req2 = new Request('http://localhost/no-cache/a')
      req2.headers.set('Authorization', `Bearer ${credential}`)
      await app.request(req2)

      expect(fetchCount).toBe(2)
    })

    it('Should reuse cached JWKS within TTL', async () => {
      const app = new Hono()
      app.use(
        '/cached/*',
        jwk({
          jwks_uri: 'http://localhost/.well-known/cached-jwks.json',
          alg: ['RS256'],
          cache: { ttl: 60 },
        })
      )
      app.get('/cached/*', (c) => c.json(c.get('jwtPayload')))

      const credential = await Jwt.sign({ message: 'hello' }, test_keys.private_keys[0])

      const req1 = new Request('http://localhost/cached/a')
      req1.headers.set('Authorization', `Bearer ${credential}`)
      const res1 = await app.request(req1)
      expect(res1.status).toBe(200)

      const req2 = new Request('http://localhost/cached/a')
      req2.headers.set('Authorization', `Bearer ${credential}`)
      const res2 = await app.request(req2)
      expect(res2.status).toBe(200)

      const req3 = new Request('http://localhost/cached/a')
      req3.headers.set('Authorization', `Bearer ${credential}`)
      const res3 = await app.request(req3)
      expect(res3.status).toBe(200)

      expect(fetchCount).toBe(1)
    })

    it('Should re-fetch JWKS after TTL expires', async () => {
      const app = new Hono()
      app.use(
        '/short-ttl/*',
        jwk({
          jwks_uri: 'http://localhost/.well-known/cached-jwks.json',
          alg: ['RS256'],
          cache: { ttl: 0.1 },
        })
      )
      app.get('/short-ttl/*', (c) => c.json(c.get('jwtPayload')))

      const credential = await Jwt.sign({ message: 'hello' }, test_keys.private_keys[0])

      const req1 = new Request('http://localhost/short-ttl/a')
      req1.headers.set('Authorization', `Bearer ${credential}`)
      const res1 = await app.request(req1)
      expect(res1.status).toBe(200)
      expect(fetchCount).toBe(1)

      // Wait for TTL to expire (100ms + small buffer)
      await new Promise((resolve) => setTimeout(resolve, 150))

      const req2 = new Request('http://localhost/short-ttl/a')
      req2.headers.set('Authorization', `Bearer ${credential}`)
      const res2 = await app.request(req2)
      expect(res2.status).toBe(200)
      expect(fetchCount).toBe(2)
    })

    it('Should force re-fetch when kid is not found in cached keys (key rotation)', async () => {
      // Start with only key 1 in the server response
      let rotationFetchCount = 0
      server.use(
        http.get('http://localhost/.well-known/cached-jwks.json', () => {
          rotationFetchCount++
          // After the first fetch, include both keys (simulates key rotation)
          const keys = rotationFetchCount === 1 ? [verify_keys[0]] : [verify_keys[0], verify_keys[1]]
          return HttpResponse.json({ keys })
        })
      )

      const app = new Hono()
      app.use(
        '/rotation/*',
        jwk({
          jwks_uri: 'http://localhost/.well-known/cached-jwks.json',
          alg: ['RS256'],
          cache: { ttl: 300 },
        })
      )
      app.get('/rotation/*', (c) => c.json(c.get('jwtPayload')))

      // First request with key 1 - should succeed and cache
      const cred1 = await Jwt.sign({ message: 'key1' }, test_keys.private_keys[0])
      const req1 = new Request('http://localhost/rotation/a')
      req1.headers.set('Authorization', `Bearer ${cred1}`)
      const res1 = await app.request(req1)
      expect(res1.status).toBe(200)
      expect(rotationFetchCount).toBe(1)

      // Request with key 2 - not in cache, should force re-fetch
      const cred2 = await Jwt.sign({ message: 'key2' }, test_keys.private_keys[1])
      const req2 = new Request('http://localhost/rotation/a')
      req2.headers.set('Authorization', `Bearer ${cred2}`)
      const res2 = await app.request(req2)
      expect(res2.status).toBe(200)
      // Should have fetched twice: once for initial, once for rotation re-fetch
      expect(rotationFetchCount).toBe(2)
    })

    it('Should still fail with 401 when kid is not found even after re-fetch', async () => {
      const app = new Hono()
      app.use(
        '/cached-miss/*',
        jwk({
          jwks_uri: 'http://localhost/.well-known/cached-jwks.json',
          alg: ['RS256'],
          cache: { ttl: 60 },
        })
      )
      app.get('/cached-miss/*', (c) => c.json(c.get('jwtPayload')))

      // Sign with a key that has a kid not in the JWKS
      const unknownKey = structuredClone(test_keys.private_keys[0])
      unknownKey.kid = 'unknown-kid'
      const credential = await Jwt.sign({ message: 'hello' }, unknownKey)

      const req = new Request('http://localhost/cached-miss/a')
      req.headers.set('Authorization', `Bearer ${credential}`)
      const res = await app.request(req)
      expect(res.status).toBe(401)
      // Should have fetched twice: initial (or cache miss) + re-fetch attempt
      expect(fetchCount).toBe(2)
    })

    it('Should work with both static keys and cached jwks_uri', async () => {
      const app = new Hono()
      app.use(
        '/cached-combined/*',
        jwk({
          keys: [verify_keys[0]],
          jwks_uri: 'http://localhost/.well-known/cached-jwks.json',
          alg: ['RS256'],
          cache: { ttl: 60 },
        })
      )
      app.get('/cached-combined/*', (c) => c.json(c.get('jwtPayload')))

      // Sign with key 1 (in static keys) - still fetches jwks_uri but result is cached
      const cred1 = await Jwt.sign({ message: 'from-static' }, test_keys.private_keys[0])
      const req1 = new Request('http://localhost/cached-combined/a')
      req1.headers.set('Authorization', `Bearer ${cred1}`)
      const res1 = await app.request(req1)
      expect(res1.status).toBe(200)

      // Sign with key 2 (only in remote JWKS, now cached)
      const cred2 = await Jwt.sign({ message: 'from-remote' }, test_keys.private_keys[1])
      const req2 = new Request('http://localhost/cached-combined/a')
      req2.headers.set('Authorization', `Bearer ${cred2}`)
      const res2 = await app.request(req2)
      expect(res2.status).toBe(200)

      // Only one fetch should have occurred (cached for second request)
      expect(fetchCount).toBe(1)
    })

    it('Should pass cache option through verifyWithJwks directly', async () => {
      const credential = await Jwt.sign({ message: 'hello' }, test_keys.private_keys[0])

      await verifyWithJwks(credential, {
        jwks_uri: 'http://localhost/.well-known/cached-jwks.json',
        allowedAlgorithms: ['RS256'],
        cache: { ttl: 60 },
      })
      await verifyWithJwks(credential, {
        jwks_uri: 'http://localhost/.well-known/cached-jwks.json',
        allowedAlgorithms: ['RS256'],
        cache: { ttl: 60 },
      })

      expect(fetchCount).toBe(1)
    })

    it('Should cache two different JWKS URIs independently', async () => {
      const app = new Hono()
      app.use(
        '/cached-a/*',
        jwk({
          jwks_uri: 'http://localhost/.well-known/cached-jwks.json',
          alg: ['RS256'],
          cache: { ttl: 60 },
        })
      )
      app.use(
        '/cached-b/*',
        jwk({
          jwks_uri: 'http://localhost/.well-known/cached-jwks-b.json',
          alg: ['RS256'],
          cache: { ttl: 60 },
        })
      )
      app.get('/cached-a/*', (c) => c.json(c.get('jwtPayload')))
      app.get('/cached-b/*', (c) => c.json(c.get('jwtPayload')))

      const credential = await Jwt.sign({ message: 'hello' }, test_keys.private_keys[0])

      // Two requests to URI A – second should be cached
      const reqA1 = new Request('http://localhost/cached-a/x')
      reqA1.headers.set('Authorization', `Bearer ${credential}`)
      await app.request(reqA1)

      const reqA2 = new Request('http://localhost/cached-a/x')
      reqA2.headers.set('Authorization', `Bearer ${credential}`)
      await app.request(reqA2)

      expect(fetchCount).toBe(1)

      // Two requests to URI B – second should be cached, independent of A
      const reqB1 = new Request('http://localhost/cached-b/x')
      reqB1.headers.set('Authorization', `Bearer ${credential}`)
      await app.request(reqB1)

      const reqB2 = new Request('http://localhost/cached-b/x')
      reqB2.headers.set('Authorization', `Bearer ${credential}`)
      await app.request(reqB2)

      expect(fetchCountB).toBe(1)

      // A's count should still be 1 – B didn't affect it
      expect(fetchCount).toBe(1)
    })

    it('Should clear only a single URI when clearJwksCache is given a URI', async () => {
      const app = new Hono()
      app.use(
        '/clear-a/*',
        jwk({
          jwks_uri: 'http://localhost/.well-known/cached-jwks.json',
          alg: ['RS256'],
          cache: { ttl: 60 },
        })
      )
      app.use(
        '/clear-b/*',
        jwk({
          jwks_uri: 'http://localhost/.well-known/cached-jwks-b.json',
          alg: ['RS256'],
          cache: { ttl: 60 },
        })
      )
      app.get('/clear-a/*', (c) => c.json(c.get('jwtPayload')))
      app.get('/clear-b/*', (c) => c.json(c.get('jwtPayload')))

      const credential = await Jwt.sign({ message: 'hello' }, test_keys.private_keys[0])

      // Populate both caches
      const reqA = new Request('http://localhost/clear-a/x')
      reqA.headers.set('Authorization', `Bearer ${credential}`)
      await app.request(reqA)
      expect(fetchCount).toBe(1)

      const reqB = new Request('http://localhost/clear-b/x')
      reqB.headers.set('Authorization', `Bearer ${credential}`)
      await app.request(reqB)
      expect(fetchCountB).toBe(1)

      // Clear only URI A
      clearJwksCache('http://localhost/.well-known/cached-jwks.json')

      // A should re-fetch
      const reqA2 = new Request('http://localhost/clear-a/x')
      reqA2.headers.set('Authorization', `Bearer ${credential}`)
      await app.request(reqA2)
      expect(fetchCount).toBe(2)

      // B should still be cached
      const reqB2 = new Request('http://localhost/clear-b/x')
      reqB2.headers.set('Authorization', `Bearer ${credential}`)
      await app.request(reqB2)
      expect(fetchCountB).toBe(1)
    })

    it('Should clear the entire cache when clearJwksCache is called without arguments', async () => {
      const app = new Hono()
      app.use(
        '/clearall-a/*',
        jwk({
          jwks_uri: 'http://localhost/.well-known/cached-jwks.json',
          alg: ['RS256'],
          cache: { ttl: 60 },
        })
      )
      app.use(
        '/clearall-b/*',
        jwk({
          jwks_uri: 'http://localhost/.well-known/cached-jwks-b.json',
          alg: ['RS256'],
          cache: { ttl: 60 },
        })
      )
      app.get('/clearall-a/*', (c) => c.json(c.get('jwtPayload')))
      app.get('/clearall-b/*', (c) => c.json(c.get('jwtPayload')))

      const credential = await Jwt.sign({ message: 'hello' }, test_keys.private_keys[0])

      // Populate both caches
      const reqA = new Request('http://localhost/clearall-a/x')
      reqA.headers.set('Authorization', `Bearer ${credential}`)
      await app.request(reqA)

      const reqB = new Request('http://localhost/clearall-b/x')
      reqB.headers.set('Authorization', `Bearer ${credential}`)
      await app.request(reqB)

      expect(fetchCount).toBe(1)
      expect(fetchCountB).toBe(1)

      // Clear everything
      clearJwksCache()

      // Both should re-fetch
      const reqA2 = new Request('http://localhost/clearall-a/x')
      reqA2.headers.set('Authorization', `Bearer ${credential}`)
      await app.request(reqA2)

      const reqB2 = new Request('http://localhost/clearall-b/x')
      reqB2.headers.set('Authorization', `Bearer ${credential}`)
      await app.request(reqB2)

      expect(fetchCount).toBe(2)
      expect(fetchCountB).toBe(2)
    })

    describe('backgroundRefresh', () => {
      it('Should trigger a background refresh on cache hit and update the cache', async () => {
        let bgFetchCount = 0
        server.use(
          http.get('http://localhost/.well-known/cached-jwks.json', () => {
            bgFetchCount++
            return HttpResponse.json({ keys: verify_keys })
          })
        )

        const app = new Hono()
        app.use(
          '/bg/*',
          jwk({
            jwks_uri: 'http://localhost/.well-known/cached-jwks.json',
            alg: ['RS256'],
            cache: { ttl: 60, backgroundRefresh: true },
          })
        )
        app.get('/bg/*', (c) => c.json(c.get('jwtPayload')))

        const credential = await Jwt.sign({ message: 'hello' }, test_keys.private_keys[0])

        // First request – cold cache, foreground fetch
        const req1 = new Request('http://localhost/bg/a')
        req1.headers.set('Authorization', `Bearer ${credential}`)
        const res1 = await app.request(req1)
        expect(res1.status).toBe(200)
        expect(bgFetchCount).toBe(1)

        // Second request – cache hit, triggers background refresh
        const req2 = new Request('http://localhost/bg/a')
        req2.headers.set('Authorization', `Bearer ${credential}`)
        const res2 = await app.request(req2)
        expect(res2.status).toBe(200)

        // Allow the background refresh microtask to settle
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(bgFetchCount).toBe(2)
      })

      it('Should not trigger a background refresh when backgroundRefresh is false', async () => {
        let bgFetchCount = 0
        server.use(
          http.get('http://localhost/.well-known/cached-jwks.json', () => {
            bgFetchCount++
            return HttpResponse.json({ keys: verify_keys })
          })
        )

        const app = new Hono()
        app.use(
          '/no-bg/*',
          jwk({
            jwks_uri: 'http://localhost/.well-known/cached-jwks.json',
            alg: ['RS256'],
            cache: { ttl: 60, backgroundRefresh: false },
          })
        )
        app.get('/no-bg/*', (c) => c.json(c.get('jwtPayload')))

        const credential = await Jwt.sign({ message: 'hello' }, test_keys.private_keys[0])

        const req1 = new Request('http://localhost/no-bg/a')
        req1.headers.set('Authorization', `Bearer ${credential}`)
        await app.request(req1)

        const req2 = new Request('http://localhost/no-bg/a')
        req2.headers.set('Authorization', `Bearer ${credential}`)
        await app.request(req2)

        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(bgFetchCount).toBe(1)
      })

      it('Should prevent concurrent background refreshes for the same URI', async () => {
        let bgFetchCount = 0
        // Gate that the test controls: the background fetch blocks until the
        // test resolves this promise, giving us a deterministic way to hold the
        // in-flight guard open while more requests arrive.
        let unblockFetch: () => void
        let fetchBlocked: Promise<void>
        const resetGate = () => {
          fetchBlocked = new Promise<void>((resolve) => {
            unblockFetch = resolve
          })
        }
        resetGate()

        // Track each time the handler is *entered* so we can assert even
        // before the response is sent.
        let handlerEnteredResolve: () => void
        let handlerEntered: Promise<void> = new Promise((r) => { handlerEnteredResolve = r })

        server.use(
          http.get('http://localhost/.well-known/cached-jwks.json', async () => {
            bgFetchCount++
            handlerEnteredResolve()
            // Block until the test explicitly unblocks – no wall-clock timer
            await fetchBlocked
            return HttpResponse.json({ keys: verify_keys })
          })
        )

        const app = new Hono()
        app.use(
          '/bg-dedup/*',
          jwk({
            jwks_uri: 'http://localhost/.well-known/cached-jwks.json',
            alg: ['RS256'],
            cache: { ttl: 60, backgroundRefresh: true },
          })
        )
        app.get('/bg-dedup/*', (c) => c.json(c.get('jwtPayload')))

        const credential = await Jwt.sign({ message: 'hello' }, test_keys.private_keys[0])

        // First request – foreground fetch (blocks until we unblock the gate)
        const foreground = app.request(
          new Request('http://localhost/bg-dedup/a', {
            headers: { Authorization: `Bearer ${credential}` },
          })
        )
        await handlerEntered
        expect(bgFetchCount).toBe(1)
        unblockFetch!()
        await foreground

        // Reset the gate so the background refresh will block
        resetGate()
        handlerEntered = new Promise((r) => { handlerEnteredResolve = r })

        // Fire five concurrent cache-hit requests.  All five should return
        // immediately from cache, and at most one background refresh should
        // be started.
        const concurrent = Array.from({ length: 5 }, (_, i) =>
          app.request(
            new Request(`http://localhost/bg-dedup/${i}`, {
              headers: { Authorization: `Bearer ${credential}` },
            })
          )
        )
        const responses = await Promise.all(concurrent)
        for (const res of responses) {
          expect(res.status).toBe(200)
        }

        // Wait for the single background handler to be entered, then unblock it
        await handlerEntered
        unblockFetch!()
        // Yield to let the .finally() clean-up run
        await new Promise((resolve) => setTimeout(resolve, 0))

        // 1 foreground + exactly 1 background, despite 5 concurrent cache hits
        expect(bgFetchCount).toBe(2)
      })

      it('Should call onRefreshError when a background refresh fails', async () => {
        let bgFetchCount = 0
        server.use(
          http.get('http://localhost/.well-known/cached-jwks.json', () => {
            bgFetchCount++
            // First call succeeds (foreground), second call fails (background)
            if (bgFetchCount === 1) {
              return HttpResponse.json({ keys: verify_keys })
            }
            return HttpResponse.text('Internal Server Error', { status: 500 })
          })
        )

        const errors: Error[] = []
        const app = new Hono()
        app.use(
          '/bg-err/*',
          jwk({
            jwks_uri: 'http://localhost/.well-known/cached-jwks.json',
            alg: ['RS256'],
            cache: {
              ttl: 60,
              backgroundRefresh: true,
              onRefreshError: (err) => errors.push(err),
            },
          })
        )
        app.get('/bg-err/*', (c) => c.json(c.get('jwtPayload')))

        const credential = await Jwt.sign({ message: 'hello' }, test_keys.private_keys[0])

        // First request – foreground fetch succeeds
        const req1 = new Request('http://localhost/bg-err/a')
        req1.headers.set('Authorization', `Bearer ${credential}`)
        const res1 = await app.request(req1)
        expect(res1.status).toBe(200)

        // Second request – cache hit, background refresh will fail
        const req2 = new Request('http://localhost/bg-err/a')
        req2.headers.set('Authorization', `Bearer ${credential}`)
        const res2 = await app.request(req2)
        // The current request still succeeds from cache
        expect(res2.status).toBe(200)

        // Wait for the background refresh to settle
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(errors).toHaveLength(1)
        expect(errors[0]).toBeInstanceOf(Error)
        expect(errors[0].message).toContain('failed to fetch JWKS')
      })

      it('Should not break the current request when background refresh fails and no onRefreshError is provided', async () => {
        let bgFetchCount = 0
        server.use(
          http.get('http://localhost/.well-known/cached-jwks.json', () => {
            bgFetchCount++
            if (bgFetchCount === 1) {
              return HttpResponse.json({ keys: verify_keys })
            }
            return HttpResponse.text('Internal Server Error', { status: 500 })
          })
        )

        const app = new Hono()
        app.use(
          '/bg-silent/*',
          jwk({
            jwks_uri: 'http://localhost/.well-known/cached-jwks.json',
            alg: ['RS256'],
            cache: { ttl: 60, backgroundRefresh: true },
          })
        )
        app.get('/bg-silent/*', (c) => c.json(c.get('jwtPayload')))

        const credential = await Jwt.sign({ message: 'hello' }, test_keys.private_keys[0])

        // First request – foreground
        const req1 = new Request('http://localhost/bg-silent/a')
        req1.headers.set('Authorization', `Bearer ${credential}`)
        const res1 = await app.request(req1)
        expect(res1.status).toBe(200)

        // Second request – triggers failing background refresh with no callback
        const req2 = new Request('http://localhost/bg-silent/a')
        req2.headers.set('Authorization', `Bearer ${credential}`)
        const res2 = await app.request(req2)
        expect(res2.status).toBe(200)

        // Let background settle – no unhandled rejection should occur
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(bgFetchCount).toBe(2)
      })

      it('Should allow background refresh in-flight guard to reset after completion', async () => {
        let bgFetchCount = 0
        server.use(
          http.get('http://localhost/.well-known/cached-jwks.json', () => {
            bgFetchCount++
            return HttpResponse.json({ keys: verify_keys })
          })
        )

        const app = new Hono()
        app.use(
          '/bg-reset/*',
          jwk({
            jwks_uri: 'http://localhost/.well-known/cached-jwks.json',
            alg: ['RS256'],
            cache: { ttl: 60, backgroundRefresh: true },
          })
        )
        app.get('/bg-reset/*', (c) => c.json(c.get('jwtPayload')))

        const credential = await Jwt.sign({ message: 'hello' }, test_keys.private_keys[0])

        // First request – foreground
        const req1 = new Request('http://localhost/bg-reset/a')
        req1.headers.set('Authorization', `Bearer ${credential}`)
        await app.request(req1)
        expect(bgFetchCount).toBe(1)

        // Second request – cache hit, starts background refresh
        const req2 = new Request('http://localhost/bg-reset/a')
        req2.headers.set('Authorization', `Bearer ${credential}`)
        await app.request(req2)
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(bgFetchCount).toBe(2)

        // Third request – in-flight guard should have been released, so a new
        // background refresh can start
        const req3 = new Request('http://localhost/bg-reset/a')
        req3.headers.set('Authorization', `Bearer ${credential}`)
        await app.request(req3)
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(bgFetchCount).toBe(3)
      })
    })
  })
})
