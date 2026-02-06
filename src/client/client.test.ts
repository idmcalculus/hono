/* eslint-disable @typescript-eslint/no-unused-vars */

/* eslint-disable @typescript-eslint/ban-ts-comment */
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { expectTypeOf, vi } from 'vitest'
import { upgradeWebSocket } from '../adapter/deno/websocket'
import { Hono } from '../hono'
import { parse } from '../utils/cookie'
import type { Equal, Expect, JSONValue, SimplifyDeepArray } from '../utils/types'
import { validator } from '../validator'
import { hc, TimeoutError } from './client'
import type { ClientResponse, InferRequestType, InferResponseType } from './types'

class SafeBigInt {
  unsafe = BigInt(42)

  toJSON() {
    return {
      value: '42n',
    }
  }
}

describe('Basic - JSON', () => {
  const app = new Hono()

  const route = app
    .post(
      '/posts',
      validator('cookie', () => {
        return {} as {
          debug: string
        }
      }),
      validator('header', () => {
        return {} as {
          'x-message': string
        }
      }),
      validator('json', () => {
        return {} as {
          id: number
          title: string
        }
      }),
      (c) => {
        return c.json({
          success: true,
          message: 'dummy',
          requestContentType: 'dummy',
          requestHono: 'dummy',
          requestMessage: 'dummy',
          requestBody: {
            id: 123,
            title: 'dummy',
          },
        })
      }
    )
    .get('/hello-not-found', (c) => c.notFound())
    .get('/null', (c) => c.json(null))
    .get('/empty', (c) => c.json({}))
    .get('/bigint', (c) => c.json({ value: BigInt(42) }))
    .get('/safe-bigint', (c) => c.json(new SafeBigInt()))

  type AppType = typeof route

  const server = setupServer(
    http.post('http://localhost/posts', async ({ request }) => {
      const requestContentType = request.headers.get('content-type')
      const requestHono = request.headers.get('x-hono')
      const requestMessage = request.headers.get('x-message')
      const requestBody = await request.json()
      const payload = {
        message: 'Hello!',
        success: true,
        requestContentType,
        requestHono,
        requestMessage,
        requestBody,
      }
      return HttpResponse.json(payload)
    }),
    http.get('http://localhost/hello-not-found', () => {
      return HttpResponse.text(null, {
        status: 404,
      })
    }),
    http.get('http://localhost/null', () => {
      return HttpResponse.json(null)
    }),
    http.get('http://localhost/empty', () => {
      return HttpResponse.json({})
    }),
    http.get('http://localhost/bigint', () => {
      return HttpResponse.json({ value: BigInt(42) })
    }),
    http.get('http://localhost/safe-bigint', () => {
      return HttpResponse.json(new SafeBigInt())
    }),
    http.get('http://localhost/api/string', () => {
      return HttpResponse.json('a-string')
    }),
    http.get('http://localhost/api/number', async () => {
      return HttpResponse.json(37)
    }),
    http.get('http://localhost/api/boolean', async () => {
      return HttpResponse.json(true)
    }),
    http.get('http://localhost/api/generic', async () => {
      return HttpResponse.json(Math.random() > 0.5 ? Boolean(Math.random()) : Math.random())
    })
  )

  beforeAll(() => server.listen())
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  const payload = {
    id: 123,
    title: 'Hello! Hono!',
  }

  const client = hc<AppType>('http://localhost', { headers: { 'x-hono': 'hono' } })

  it('Should get 200 response', async () => {
    const res = await client.posts.$post(
      {
        json: payload,
        header: {
          'x-message': 'foobar',
        },
        cookie: {
          debug: 'true',
        },
      },
      {}
    )

    expect(res.ok).toBe(true)
    const data = await res.json()
    expect(data.success).toBe(true)
    expect(data.message).toBe('Hello!')
    expect(data.requestContentType).toBe('application/json')
    expect(data.requestHono).toBe('hono')
    expect(data.requestMessage).toBe('foobar')
    expect(data.requestBody).toEqual(payload)
  })

  it('Should get 404 response', async () => {
    const res = await client['hello-not-found'].$get()
    expect(res.status).toBe(404)
  })

  it('Should get a `null` content', async () => {
    const client = hc<AppType>('http://localhost')
    const res = await client.null.$get()
    const data = await res.json()
    expectTypeOf(data).toMatchTypeOf<null>()
    expect(data).toBe(null)
  })

  it('Should get a `{}` content', async () => {
    const client = hc<AppType>('http://localhost')
    const res = await client.empty.$get()
    const data = await res.json()
    expectTypeOf(data).toMatchTypeOf<{}>()
    expect(data).toStrictEqual({})
  })

  it('Should get a `{}` content', async () => {
    const client = hc<AppType>('http://localhost')
    const res = await client['safe-bigint'].$get()
    const data = await res.json()
    expectTypeOf(data).toMatchTypeOf<{ value: string }>()
    expect(data).toStrictEqual({ value: '42n' })
  })

  it('Should get an error response', async () => {
    const client = hc<AppType>('http://localhost')
    const res = await client.bigint.$get()
    const data = await res.json()
    expectTypeOf(data).toMatchTypeOf<never>()
    expect(res.status).toBe(500)
    expect(data).toMatchObject({
      message: 'Do not know how to serialize a BigInt',
      name: 'TypeError',
    })
  })

  it('Should have correct types - primitives', async () => {
    const app = new Hono()
    const route = app
      .get('/api/string', (c) => c.json('a-string'))
      .get('/api/number', (c) => c.json(37))
      .get('/api/boolean', (c) => c.json(true))
      .get('/api/generic', (c) =>
        c.json(Math.random() > 0.5 ? Boolean(Math.random()) : Math.random())
      )
    type AppType = typeof route
    const client = hc<AppType>('http://localhost')
    const stringFetch = await client.api.string.$get()
    const stringRes = await stringFetch.json()
    const numberFetch = await client.api.number.$get()
    const numberRes = await numberFetch.json()
    const booleanFetch = await client.api.boolean.$get()
    const booleanRes = await booleanFetch.json()
    const genericFetch = await client.api.generic.$get()
    const genericRes = await genericFetch.json()
    type stringVerify = Expect<Equal<'a-string', typeof stringRes>>
    expect(stringRes).toBe('a-string')
    type numberVerify = Expect<Equal<37, typeof numberRes>>
    expect(numberRes).toBe(37)
    type booleanVerify = Expect<Equal<true, typeof booleanRes>>
    expect(booleanRes).toBe(true)
    type genericVerify = Expect<Equal<number | boolean, typeof genericRes>>
    expect(typeof genericRes === 'number' || typeof genericRes === 'boolean').toBe(true)

    // using .text() on json endpoint should return string
    type textTest = Expect<Equal<Promise<string>, ReturnType<typeof genericFetch.text>>>
  })
})

describe('Basic - query, queries, form, path params, header and cookie', () => {
  const app = new Hono()

  const route = app
    .get(
      '/search',
      validator('query', () => {
        return {} as { q: string; tag: string[]; filter: string }
      }),
      (c) => {
        return c.json({
          q: 'fake',
          tag: ['fake'],
          filter: 'fake',
        })
      }
    )
    .put(
      '/posts/:id',
      validator('form', () => {
        return {
          title: 'Hello',
        }
      }),
      (c) => {
        const data = c.req.valid('form')
        return c.json(data)
      }
    )
    .get(
      '/header',
      validator('header', () => {
        return {
          'x-message-id': 'Hello',
        }
      }),
      (c) => {
        const data = c.req.valid('header')
        return c.json(data)
      }
    )
    .get(
      '/cookie',
      validator('cookie', () => {
        return {
          hello: 'world',
        }
      }),
      (c) => {
        const data = c.req.valid('cookie')
        return c.json(data)
      }
    )

  const server = setupServer(
    http.get('http://localhost/api/search', ({ request }) => {
      const url = new URL(request.url)
      const query = url.searchParams.get('q')
      const tag = url.searchParams.getAll('tag')
      const filter = url.searchParams.get('filter')
      return HttpResponse.json({
        q: query,
        tag,
        filter,
      })
    }),
    http.get('http://localhost/api/posts', ({ request }) => {
      const url = new URL(request.url)
      const tags = url.searchParams.getAll('tags')
      return HttpResponse.json({
        tags: tags,
      })
    }),
    http.put('http://localhost/api/posts/123', async ({ request }) => {
      const buffer = await request.arrayBuffer()
      // @ts-ignore
      const string = String.fromCharCode.apply('', new Uint8Array(buffer))
      return HttpResponse.text(string)
    }),
    http.get('http://localhost/api/header', async ({ request }) => {
      const message = await request.headers.get('x-message-id')
      return HttpResponse.json({ 'x-message-id': message })
    }),
    http.get('http://localhost/api/cookie', async ({ request }) => {
      const obj = parse(request.headers.get('cookie') || '')
      const value = obj['hello']
      return HttpResponse.json({ hello: value })
    })
  )

  beforeAll(() => server.listen())
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  type AppType = typeof route

  const client = hc<AppType>('http://localhost/api')

  it('Should get 200 response - query', async () => {
    const res = await client.search.$get({
      query: {
        q: 'foobar',
        tag: ['a', 'b'],
        // @ts-expect-error
        filter: undefined,
      },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      q: 'foobar',
      tag: ['a', 'b'],
      filter: null,
    })
  })

  it('Should get 200 response - form, params', async () => {
    const res = await client.posts[':id'].$put({
      form: {
        title: 'Good Night',
      },
      param: {
        id: '123',
      },
    })

    expect(res.status).toBe(200)
    expect(await res.text()).toMatch('Good Night')
  })

  it('Should get 200 response - header', async () => {
    const header = {
      'x-message-id': 'Hello',
    }
    const res = await client.header.$get({
      header,
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(header)
  })

  it('Should get 200 response - cookie', async () => {
    const cookie = {
      hello: 'world',
    }
    const res = await client.cookie.$get({
      cookie,
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cookie)
  })
})

describe('Basic - $url()', () => {
  const api = new Hono().get('/', (c) => c.text('API')).get('/posts/:id', (c) => c.text('Post'))
  const content = new Hono().get(
    '/search',
    validator('query', () => {
      return { page: '1', limit: '10' }
    }),
    (c) => c.text('Search')
  )
  const app = new Hono()
    .get('/', (c) => c.text('Index'))
    .route('/api', api)
    .route('/content', content)

  it('Should return a correct url via $url().href', async () => {
    const client = hc<typeof app>('http://fake')
    expect(client.index.$url().href).toBe('http://fake/')
    expect(
      client.index.$url({
        query: {
          page: '123',
          limit: '20',
        },
      }).href
    ).toBe('http://fake/?page=123&limit=20')
    expect(client.api.$url().href).toBe('http://fake/api')
    expect(
      client.api.posts[':id'].$url({
        param: {
          id: '123',
        },
      }).href
    ).toBe('http://fake/api/posts/123')
    expect(
      client.content.search.$url({
        query: {
          page: '123',
          limit: '20',
        },
      }).href
    ).toBe('http://fake/content/search?page=123&limit=20')
  })
})

describe('Form - Multiple Values', () => {
  const server = setupServer(
    http.post('http://localhost/multiple-values', async ({ request }) => {
      const data = await request.formData()
      return HttpResponse.json(data.getAll('key'))
    })
  )

  beforeAll(() => server.listen())
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  const client = hc('http://localhost/')

  it('Should get 200 response - query', async () => {
    // @ts-expect-error `client['multiple-values'].$post` is not typed
    const res = await client['multiple-values'].$post({
      form: {
        key: ['foo', 'bar'],
      },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(['foo', 'bar'])
  })
})

describe('Infer the response/request type', () => {
  const app = new Hono()
  const route = app.get(
    '/',
    validator('query', () => {
      return {
        name: 'dummy',
        age: 'dummy',
      }
    }),
    validator('header', () => {
      return {
        'x-request-id': 'dummy',
      }
    }),
    validator('cookie', () => {
      return {
        name: 'dummy',
      }
    }),
    (c) =>
      c.json({
        id: 123,
        title: 'Morning!',
      })
  )

  type AppType = typeof route

  it('Should infer response type the type correctly', () => {
    const client = hc<AppType>('/')
    const req = client.index.$get

    type Actual = InferResponseType<typeof req>
    type Expected = {
      id: number
      title: string
    }
    type verify = Expect<Equal<Expected, Actual>>
  })

  it('Should infer request type the type correctly', () => {
    const client = hc<AppType>('/')
    const req = client.index.$get

    type Actual = InferRequestType<typeof req>
    type Expected = {
      age: string | string[]
      name: string | string[]
    }
    type verify = Expect<Equal<Expected, Actual['query']>>
  })

  it('Should infer request header type the type correctly', () => {
    const client = hc<AppType>('/')
    const req = client.index.$get
    type c = typeof req

    type Actual = InferRequestType<c>
    type Expected = {
      'x-request-id': string
    }
    type verify = Expect<Equal<Expected, Actual['header']>>
  })

  it('Should infer request cookie type the type correctly', () => {
    const client = hc<AppType>('/')
    const req = client.index.$get
    type c = typeof req

    type Actual = InferRequestType<c>
    type Expected = {
      name: string
    }
    type verify = Expect<Equal<Expected, Actual['cookie']>>
  })

  describe('Without input', () => {
    const route = app.get('/', (c) => c.json({ ok: true }))
    type AppType = typeof route

    it('Should infer response type the type correctly', () => {
      const client = hc<AppType>('/')
      const req = client.index.$get

      type Actual = InferResponseType<typeof req>
      type Expected = { ok: true }
      type verify = Expect<Equal<Expected, Actual>>
    })

    it('Should infer request type the type correctly', () => {
      const client = hc<AppType>('/')
      const req = client.index.$get

      type Actual = InferRequestType<typeof req>
      type Expected = {}
      type verify = Expect<Equal<Expected, Actual>>
    })
  })
})

describe('Merge path with `app.route()`', () => {
  const server = setupServer(
    http.get('http://localhost/api/search', async () => {
      return HttpResponse.json({
        ok: true,
      })
    }),
    http.get('http://localhost/api/searchArray', async () => {
      return HttpResponse.json([
        {
          ok: true,
        },
      ])
    }),
    http.get('http://localhost/api/foo', async () => {
      return HttpResponse.json({
        ok: true,
      })
    }),
    http.post('http://localhost/api/bar', async () => {
      return HttpResponse.json({
        ok: true,
      })
    }),
    http.get('http://localhost/v1/book', async () => {
      return HttpResponse.json({
        ok: true,
      })
    })
  )

  beforeAll(() => server.listen())
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  type Env = {
    Bindings: {
      TOKEN: string
    }
  }

  it('Should have correct types', async () => {
    const api = new Hono<Env>().get('/search', (c) => c.json({ ok: true }))
    const app = new Hono<Env>().route('/api', api)
    type AppType = typeof app
    const client = hc<AppType>('http://localhost')
    const res = await client.api.search.$get()
    const data = await res.json()
    type verify = Expect<Equal<true, typeof data.ok>>
    expect(data.ok).toBe(true)
  })

  it('Should have correct types - basePath() then get()', async () => {
    const base = new Hono<Env>().basePath('/api')
    const app = base.get('/search', (c) => c.json({ ok: true }))
    type AppType = typeof app
    const client = hc<AppType>('http://localhost')
    const res = await client.api.search.$get()
    const data = await res.json()
    type verify = Expect<Equal<true, typeof data.ok>>
    expect(data.ok).toBe(true)
  })

  it('Should have correct types - basePath(), route(), get()', async () => {
    const book = new Hono().get('/', (c) => c.json({ ok: true }))
    const app = new Hono().basePath('/v1').route('/book', book)
    type AppType = typeof app
    const client = hc<AppType>('http://localhost')
    const res = await client.v1.book.$get()
    const data = await res.json()
    type verify = Expect<Equal<true, typeof data.ok>>
    expect(data.ok).toBe(true)
  })

  it('Should have correct types - with interface', async () => {
    interface Result {
      ok: boolean
      okUndefined?: boolean
    }
    const result: Result = { ok: true }
    const base = new Hono<Env>().basePath('/api')
    const app = base.get('/search', (c) => c.json(result))
    type AppType = typeof app
    const client = hc<AppType>('http://localhost')
    const res = await client.api.search.$get()
    const data = await res.json()
    type verify = Expect<Equal<Result, typeof data>>
    expect(data.ok).toBe(true)

    // A few more types only tests
    interface DeepInterface {
      l2: {
        l3: Result
      }
    }
    interface ExtraDeepInterface {
      l4: DeepInterface
    }
    type verifyDeepInterface = Expect<
      Equal<SimplifyDeepArray<DeepInterface> extends JSONValue ? true : false, true>
    >
    type verifyExtraDeepInterface = Expect<
      Equal<SimplifyDeepArray<ExtraDeepInterface> extends JSONValue ? true : false, true>
    >
  })

  it('Should have correct types - with array of interfaces', async () => {
    interface Result {
      ok: boolean
      okUndefined?: boolean
    }
    type Results = Result[]

    const results: Results = [{ ok: true }]
    const base = new Hono<Env>().basePath('/api')
    const app = base.get('/searchArray', (c) => c.json(results))
    type AppType = typeof app
    const client = hc<AppType>('http://localhost')
    const res = await client.api.searchArray.$get()
    const data = await res.json()
    type verify = Expect<Equal<Results, typeof data>>
    expect(data[0].ok).toBe(true)

    // A few more types only tests
    type verifyNestedArrayTyped = Expect<
      Equal<SimplifyDeepArray<[string, Results]> extends JSONValue ? true : false, true>
    >
    type verifyNestedArrayInterfaceArray = Expect<
      Equal<SimplifyDeepArray<[string, Result[]]> extends JSONValue ? true : false, true>
    >
    type verifyExtraNestedArrayTyped = Expect<
      Equal<SimplifyDeepArray<[string, Results[]]> extends JSONValue ? true : false, true>
    >
    type verifyExtraNestedArrayInterfaceArray = Expect<
      Equal<SimplifyDeepArray<[string, Result[][]]> extends JSONValue ? true : false, true>
    >
  })

  it('Should allow a Date object and return it as a string', async () => {
    const app = new Hono()
    const route = app.get('/api/foo', (c) => c.json({ datetime: new Date() }))
    type AppType = typeof route
    const client = hc<AppType>('http://localhost')
    const res = await client.api.foo.$get()
    const { datetime } = await res.json()
    type verify = Expect<Equal<string, typeof datetime>>
  })

  describe('Multiple endpoints', () => {
    const api = new Hono()
      .get('/foo', (c) => c.json({ foo: '' }))
      .post('/bar', (c) => c.json({ bar: 0 }))
    const app = new Hono().route('/api', api)
    type AppType = typeof app
    const client = hc<typeof app>('http://localhost')

    it('Should return correct types - GET /api/foo', async () => {
      const res = await client.api.foo.$get()
      const data = await res.json()
      type verify = Expect<Equal<string, typeof data.foo>>
    })

    it('Should return correct types - POST /api/bar', async () => {
      const res = await client.api.bar.$post()
      const data = await res.json()
      type verify = Expect<Equal<number, typeof data.bar>>
    })
    it('Should work with $url', async () => {
      const url = client.api.bar.$url()
      expect(url.href).toBe('http://localhost/api/bar')
    })
  })

  describe('With a blank path', () => {
    const app = new Hono().basePath('/api/v1')
    const routes = app.route(
      '/me',
      new Hono().route(
        '',
        new Hono().get('', async (c) => {
          return c.json({ name: 'hono' })
        })
      )
    )
    const client = hc<typeof routes>('http://localhost')

    it('Should infer paths correctly', async () => {
      // Should not a throw type error
      const url = client.api.v1.me.$url()
      expectTypeOf<URL>(url)
      expect(url.href).toBe('http://localhost/api/v1/me')
    })
  })
})

describe('Use custom fetch method', () => {
  it('Should call the custom fetch method when provided', async () => {
    const fetchMock = vi.fn()

    const api = new Hono().get('/search', (c) => c.json({ ok: true }))
    const app = new Hono().route('/api', api)
    type AppType = typeof app
    const client = hc<AppType>('http://localhost', { fetch: fetchMock })
    await client.api.search.$get()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('Should return Response from custom fetch method', async () => {
    const fetchMock = vi.fn()
    const returnValue = new Response(null, { status: 200 })
    fetchMock.mockReturnValueOnce(returnValue)

    const api = new Hono().get('/search', (c) => c.json({ ok: true }))
    const app = new Hono().route('/api', api)
    type AppType = typeof app
    const client = hc<AppType>('http://localhost', { fetch: fetchMock })
    const res = await client.api.search.$get()
    expect(res.ok).toBe(true)
    expect(res).toEqual(returnValue)
  })
})

describe('Use custom fetch (app.request) method', () => {
  it('Should return Response from app request method', async () => {
    const app = new Hono().get('/search', (c) => c.json({ ok: true }))
    type AppType = typeof app
    const client = hc<AppType>('', { fetch: app.request })
    const res = await client.search.$get()
    expect(res.ok).toBe(true)
  })
})

describe('Optional parameters in JSON response', () => {
  it('Should return the correct type', async () => {
    const app = new Hono().get('/', (c) => {
      return c.json({ message: 'foo' } as { message?: string })
    })
    type AppType = typeof app
    const client = hc<AppType>('', { fetch: app.request })
    const res = await client.index.$get()
    const data = await res.json()
    expectTypeOf(data).toEqualTypeOf<{
      message?: string
    }>()
  })
})

describe('ClientResponse<T>.json() returns a Union type correctly', () => {
  const condition = () => true
  const app = new Hono().get('/', async (c) => {
    const ok = condition()
    if (ok) {
      return c.json({ data: 'foo' })
    }
    return c.json({ message: 'error' })
  })

  const client = hc<typeof app>('', { fetch: app.request })
  it('Should be a Union type', async () => {
    const res = await client.index.$get()
    const json = await res.json()
    expectTypeOf(json).toEqualTypeOf<{ data: string } | { message: string }>()
  })
})

describe('Response with different status codes', () => {
  const condition = () => true
  const app = new Hono().get('/', async (c) => {
    const ok = condition()
    if (ok) {
      return c.json({ data: 'foo' }, 200)
    }
    if (!ok) {
      return c.json({ message: 'error' }, 400)
    }
    return c.json(null)
  })

  const client = hc<typeof app>('', { fetch: app.request })

  it('all', async () => {
    const res = await client.index.$get()
    const json = await res.json()
    expectTypeOf(json).toEqualTypeOf<{ data: string } | { message: string } | null>()
  })

  it('status 200', async () => {
    const res = await client.index.$get()
    if (res.status === 200) {
      const json = await res.json()
      expectTypeOf(json).toEqualTypeOf<{ data: string } | null>()
    }
  })

  it('status 400', async () => {
    const res = await client.index.$get()
    if (res.status === 400) {
      const json = await res.json()
      expectTypeOf(json).toEqualTypeOf<{ message: string } | null>()
    }
  })

  it('response is ok', async () => {
    const res = await client.index.$get()
    if (res.ok) {
      const json = await res.json()
      expectTypeOf(json).toEqualTypeOf<{ data: string } | null>()
    }
  })

  it('response is not ok', async () => {
    const res = await client.index.$get()
    if (!res.ok) {
      const json = await res.json()
      expectTypeOf(json).toEqualTypeOf<{ message: string } | null>()
    }
  })
})

describe('Infer the response type with different status codes', () => {
  const condition = () => true
  const app = new Hono().get('/', async (c) => {
    const ok = condition()
    if (ok) {
      return c.json({ data: 'foo' }, 200)
    }
    if (!ok) {
      return c.json({ message: 'error' }, 400)
    }
    return c.json(null)
  })

  const client = hc<typeof app>('', { fetch: app.request })

  it('Should infer response type correctly', () => {
    const req = client.index.$get

    type Actual = InferResponseType<typeof req>
    type Expected =
      | {
          data: string
        }
      | {
          message: string
        }
      | null
    type verify = Expect<Equal<Expected, Actual>>
  })

  it('Should infer response type of status 200 correctly', () => {
    const req = client.index.$get

    type Actual = InferResponseType<typeof req, 200>
    type Expected = {
      data: string
    } | null
    type verify = Expect<Equal<Expected, Actual>>
  })
})

describe('Infer the response types from middlewares', () => {
  const app = new Hono()
    .get(
      '/',
      validator('query', (input, c) => {
        if (!input.page || typeof input.page !== 'string') {
          return c.json({ error: 'Bad request' as const }, 400)
        }

        return input as { page: string }
      }),
      async (c) => {
        const query = c.req.valid('query')
        return c.json({ data: 'foo', page: query.page }, 200)
      }
    )
    .post(
      '/posts',
      async (c, next) => {
        const auth = c.req.header('authorization')
        if (!auth || !auth.startsWith('Bearer ')) {
          return c.json({ error: 'Unauthorized' as const }, 401)
        }
        return next()
      },
      validator('json', (input, c) => {
        if (!input.title) {
          return c.json({ error: 'Bad request' as const }, 400)
        }

        return input as { title: string }
      }),
      (c) => {
        const data = c.req.valid('json')
        return c.json(data, 200)
      }
    )

  type AppType = typeof app
  const client = hc<AppType>('', { fetch: app.request })

  it('Should infer response type of status 200 correctly', () => {
    const req = client.posts.$post

    type Actual = InferResponseType<typeof req, 200>
    type Expected = {
      title: string
    }
    type verify = Expect<Equal<Expected, Actual>>
  })

  it('Should infer response type of status 400 correctly', () => {
    const req = client.posts.$post

    type Actual = InferResponseType<typeof req, 400>
    type Expected = {
      error: 'Bad request'
    }
    type verify = Expect<Equal<Expected, Actual>>
  })

  it('Should infer response type of status 401 correctly', () => {
    const req = client.posts.$post

    type Actual = InferResponseType<typeof req, 401>
    type Expected = {
      error: 'Unauthorized'
    }
    type verify = Expect<Equal<Expected, Actual>>
  })

  it('Should infer all possible response statuses', async () => {
    const req = await client.posts.$post({
      json: {
        title: 'hello',
      },
    })

    type Actual = typeof req.status
    type Expected = 200 | 400 | 401
    type verify = Expect<Equal<Expected, Actual>>
  })

  it('Should properly assign response to corresponding status', async () => {
    const req = await client.posts.$post({
      json: {
        title: 'hello',
      },
    })

    if (req.status === 200) {
      const data = await req.json()

      expectTypeOf(data).toEqualTypeOf<{ title: string }>()
    } else if (req.status === 400) {
      const data = await req.json()

      expectTypeOf(data).toEqualTypeOf<{ error: 'Bad request' }>()
    } else if (req.status === 401) {
      const data = await req.json()

      expectTypeOf(data).toEqualTypeOf<{ error: 'Unauthorized' }>()
    }
  })
})

describe('$url() with a param option', () => {
  const app = new Hono()
    .get('/posts/:id/comments', (c) => c.json({ ok: true }))
    .get('/something/:firstId/:secondId/:version?', (c) => c.json({ ok: true }))
  type AppType = typeof app
  const client = hc<AppType>('http://localhost')

  it('Should return the correct path - /posts/123/comments', async () => {
    const url = client.posts[':id'].comments.$url({
      param: {
        id: '123',
      },
    })
    expect(url.pathname).toBe('/posts/123/comments')
  })

  it('Should return the correct path - /posts/:id/comments', async () => {
    const url = client.posts[':id'].comments.$url()
    expect(url.pathname).toBe('/posts/:id/comments')
  })

  it('Should return the correct path - /something/123/456', async () => {
    const url = client.something[':firstId'][':secondId'][':version?'].$url({
      param: {
        firstId: '123',
        secondId: '456',
        version: undefined,
      },
    })
    expect(url.pathname).toBe('/something/123/456')
  })
})

describe('$url() with a query option', () => {
  const app = new Hono().get(
    '/posts',
    validator('query', () => {
      return {} as { filter: 'test' }
    }),
    (c) => c.json({ ok: true })
  )
  type AppType = typeof app
  const client = hc<AppType>('http://localhost')

  it('Should return the correct path - /posts?filter=test', async () => {
    const url = client.posts.$url({
      query: {
        filter: 'test',
      },
    })
    expect(url.search).toBe('?filter=test')
  })
})

describe('Client can be awaited', () => {
  it('Can be awaited without side effects', async () => {
    const client = hc('http://localhost')

    const awaited = await client

    expect(awaited).toEqual(client)
  })
})

describe('Dynamic headers', () => {
  const app = new Hono()

  const route = app.post('/posts', (c) => {
    return c.json({
      requestDynamic: 'dummy',
    })
  })

  type AppType = typeof route

  const server = setupServer(
    http.post('http://localhost/posts', async ({ request }) => {
      const requestDynamic = request.headers.get('x-dynamic')
      const payload = {
        requestDynamic,
      }
      return HttpResponse.json(payload)
    })
  )

  beforeAll(() => server.listen())
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  let dynamic = ''

  const client = hc<AppType>('http://localhost', {
    headers: () => ({ 'x-hono': 'hono', 'x-dynamic': dynamic }),
  })

  it('Should have "x-dynamic": "one"', async () => {
    dynamic = 'one'

    const res = await client.posts.$post()

    expect(res.ok).toBe(true)
    const data = await res.json()
    expect(data.requestDynamic).toEqual('one')
  })

  it('Should have "x-dynamic": "two"', async () => {
    dynamic = 'two'

    const res = await client.posts.$post()

    expect(res.ok).toBe(true)
    const data = await res.json()
    expect(data.requestDynamic).toEqual('two')
  })
})

describe('RequestInit work as expected', () => {
  const app = new Hono()

  const route = app
    .get('/credentials', (c) => {
      return c.text('' as RequestCredentials)
    })
    .get('/headers', (c) => {
      return c.json({} as Record<string, string>)
    })
    .post('/headers', (c) => c.text('Not found', 404))

  type AppType = typeof route

  const server = setupServer(
    http.get('http://localhost/credentials', ({ request }) => {
      return HttpResponse.text(request.credentials)
    }),
    http.get('http://localhost/headers', ({ request }) => {
      const allHeaders: Record<string, string> = {}
      for (const [k, v] of request.headers.entries()) {
        allHeaders[k] = v
      }

      return HttpResponse.json(allHeaders)
    }),
    http.post('http://localhost/headers', () => {
      return HttpResponse.text('Should not be here', {
        status: 400,
      })
    })
  )

  beforeAll(() => server.listen())
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  const client = hc<AppType>('http://localhost', {
    headers: { 'x-hono': 'fire' },
    init: {
      credentials: 'include',
    },
  })

  it('Should overwrite method and fail', async () => {
    const res = await client.headers.$get(undefined, { init: { method: 'POST' } })

    expect(res.ok).toBe(false)
  })

  it('Should clear headers', async () => {
    const res = await client.headers.$get(undefined, { init: { headers: undefined } })

    expect(res.ok).toBe(true)
    const data = await res.json()
    expect(data).toEqual({})
  })

  it('Should overwrite headers', async () => {
    const res = await client.headers.$get(undefined, {
      init: { headers: new Headers({ 'x-hono': 'awesome' }) },
    })

    expect(res.ok).toBe(true)
    const data = await res.json()
    expect(data).toEqual({ 'x-hono': 'awesome' })
  })

  it('credentials is include', async () => {
    const res = await client.credentials.$get()

    expect(res.ok).toBe(true)
    const data = await res.text()
    expect(data).toEqual('include')
  })

  it('deepMerge should works and not unset credentials', async () => {
    const res = await client.credentials.$get(undefined, { init: { headers: { hi: 'hello' } } })

    expect(res.ok).toBe(true)
    const data = await res.text()
    expect(data).toEqual('include')
  })

  it('Should unset credentials', async () => {
    const res = await client.credentials.$get(undefined, { init: { credentials: undefined } })

    expect(res.ok).toBe(true)
    const data = await res.text()
    expect(data).toEqual('same-origin')
  })
})

describe('WebSocket URL Protocol Translation', () => {
  const app = new Hono()
  const route = app.get(
    '/',
    upgradeWebSocket((c) => ({
      onMessage(event, ws) {
        console.log(`Message from client: ${event.data}`)
        ws.send('Hello from server!')
      },
      onClose: () => {
        console.log('Connection closed')
      },
    }))
  )

  type AppType = typeof route

  const server = setupServer()
  const webSocketMock = vi.fn()

  beforeAll(() => server.listen())
  beforeEach(() => {
    vi.stubGlobal('WebSocket', webSocketMock)
  })
  afterEach(() => {
    vi.clearAllMocks()
    server.resetHandlers()
  })
  afterAll(() => server.close())

  it('Translates HTTP to ws', async () => {
    const client = hc<AppType>('http://localhost')
    client.index.$ws()
    expect(webSocketMock).toHaveBeenCalledWith('ws://localhost/index')
  })

  it('Translates HTTPS to wss', async () => {
    const client = hc<AppType>('https://localhost')
    client.index.$ws()
    expect(webSocketMock).toHaveBeenCalledWith('wss://localhost/index')
  })

  it('Keeps ws unchanged', async () => {
    const client = hc<AppType>('ws://localhost')
    client.index.$ws()
    expect(webSocketMock).toHaveBeenCalledWith('ws://localhost/index')
  })

  it('Keeps wss unchanged', async () => {
    const client = hc<AppType>('wss://localhost')
    client.index.$ws()
    expect(webSocketMock).toHaveBeenCalledWith('wss://localhost/index')
  })
})

describe('WebSocket URL Protocol Translation with Query Parameters', () => {
  const app = new Hono()
  const route = app.get(
    '/',
    upgradeWebSocket((c) => ({
      onMessage(event, ws) {
        ws.send('Hello from server!')
      },
      onClose: () => {
        console.log('Connection closed')
      },
    }))
  )

  type AppType = typeof route

  const server = setupServer()
  const webSocketMock = vi.fn()

  beforeAll(() => server.listen())
  beforeEach(() => {
    vi.stubGlobal('WebSocket', webSocketMock)
  })
  afterEach(() => {
    vi.clearAllMocks()
    server.resetHandlers()
  })
  afterAll(() => server.close())

  it('Translates HTTP to ws and includes query parameters', async () => {
    const client = hc<AppType>('http://localhost')
    client.index.$ws({
      query: {
        id: '123',
        type: 'test',
        tag: ['a', 'b'],
      },
    })
    expect(webSocketMock).toHaveBeenCalledWith('ws://localhost/index?id=123&type=test&tag=a&tag=b')
  })

  it('Translates HTTPS to wss and includes query parameters', async () => {
    const client = hc<AppType>('https://localhost')
    client.index.$ws({
      query: {
        id: '456',
        type: 'secure',
      },
    })
    expect(webSocketMock).toHaveBeenCalledWith('wss://localhost/index?id=456&type=secure')
  })

  it('Keeps ws unchanged and includes query parameters', async () => {
    const client = hc<AppType>('ws://localhost')
    client.index.$ws({
      query: {
        id: '789',
        type: 'plain',
      },
    })
    expect(webSocketMock).toHaveBeenCalledWith('ws://localhost/index?id=789&type=plain')
  })

  it('Keeps wss unchanged and includes query parameters', async () => {
    const client = hc<AppType>('wss://localhost')
    client.index.$ws({
      query: {
        id: '1011',
        type: 'secure',
      },
    })
    expect(webSocketMock).toHaveBeenCalledWith('wss://localhost/index?id=1011&type=secure')
  })
})

describe('Client can be console.log in react native', () => {
  it('Returns a function name with function.name.toString', async () => {
    const client = hc('http://localhost')
    // @ts-ignore
    expect(client.posts.name.toString()).toEqual('posts')
  })

  it('Returns a function name with function.name.valueOf', async () => {
    const client = hc('http://localhost')
    // @ts-ignore
    expect(client.posts.name.valueOf()).toEqual('posts')
  })

  it('Returns a function with function.valueOf', async () => {
    const client = hc('http://localhost')
    expect(typeof client.posts.valueOf()).toEqual('function')
  })

  it('Returns a function source with function.toString', async () => {
    const client = hc('http://localhost')
    expect(client.posts.toString()).toMatch('function proxyCallback')
  })
})

describe('Text response', () => {
  const text = 'My name is Hono'
  const obj = { ok: true }
  const server = setupServer(
    http.get('http://localhost/about/me', async () => {
      return HttpResponse.text(text)
    }),
    http.get('http://localhost/api', async ({ request }) => {
      return HttpResponse.json(obj)
    })
  )

  beforeAll(() => server.listen())
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  const app = new Hono().get('/about/me', (c) => c.text(text)).get('/api', (c) => c.json(obj))
  const client = hc<typeof app>('http://localhost/')

  it('Should be never with res.json() - /about/me', async () => {
    const res = await client.about.me.$get()
    type Actual = ReturnType<typeof res.json>
    type Expected = Promise<never>
    type verify = Expect<Equal<Expected, Actual>>
  })

  it('Should be "Hello, World!" with res.text() - /about/me', async () => {
    const res = await client.about.me.$get()
    const data = await res.text()
    expectTypeOf(data).toEqualTypeOf<'My name is Hono'>()
    expect(data).toBe(text)
  })

  /**
   * Also check the type of JSON response with res.text().
   */
  it('Should be string with res.text() - /api', async () => {
    const res = await client.api.$get()
    type Actual = ReturnType<typeof res.text>
    type Expected = Promise<string>
    type verify = Expect<Equal<Expected, Actual>>
  })
})

describe('Redirect response - only types', () => {
  const server = setupServer(
    http.get('http://localhost/', async () => {
      return HttpResponse.redirect('/')
    })
  )

  beforeAll(() => server.listen())
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  const condition = () => true
  const app = new Hono().get('/', async (c) => {
    const ok = condition()
    const temporary = condition()
    if (ok) {
      return c.json({ ok: true }, 200)
    }
    if (temporary) {
      return c.redirect('/302')
    }
    return c.redirect('/301', 301)
  })

  const client = hc<typeof app>('http://localhost/')
  const req = client.index.$get

  it('Should infer request type the type correctly', () => {
    type Actual = InferResponseType<typeof req>
    type Expected =
      | {
          ok: true
        }
      | undefined
    type verify = Expect<Equal<Expected, Actual>>
  })

  it('Should infer response type correctly', async () => {
    const res = await req()
    if (res.ok) {
      const data = await res.json()
      expectTypeOf(data).toMatchTypeOf({ ok: true })
    }
    if (res.status === 301) {
      type Expected = ClientResponse<undefined, 301, 'redirect'>
      type verify = Expect<Equal<Expected, typeof res>>
    }
    if (res.status === 302) {
      type Expected = ClientResponse<undefined, 302, 'redirect'>
      type verify = Expect<Equal<Expected, typeof res>>
    }
  })
})

describe('WebSocket Provider Integration', () => {
  const app = new Hono()
  const route = app.get(
    '/',
    upgradeWebSocket((c) => ({
      onMessage(event, ws) {
        ws.send('Hello from server!')
      },
      onClose() {
        console.log('Connection closed')
      },
    }))
  )

  type AppType = typeof route

  const server = setupServer()
  beforeAll(() => server.listen())
  afterEach(() => {
    vi.clearAllMocks()
    server.resetHandlers()
  })
  afterAll(() => server.close())

  it.each([
    {
      description: 'should initialize the WebSocket provider correctly',
      url: 'http://localhost',
      query: undefined,
      expectedUrl: 'ws://localhost/index',
    },
    {
      description: 'should correctly add query parameters to the WebSocket URL',
      url: 'http://localhost',
      query: { id: '123', type: 'test', tag: ['a', 'b'] },
      expectedUrl: 'ws://localhost/index?id=123&type=test&tag=a&tag=b',
    },
  ])('$description', ({ url, expectedUrl, query }) => {
    const webSocketMock = vi.fn()
    const client = hc<AppType>(url, {
      webSocket(url, options) {
        return webSocketMock(url, options)
      },
    })
    client.index.$ws({ query })
    expect(webSocketMock).toHaveBeenCalledWith(expectedUrl, undefined)
  })
})

describe('Custom buildSearchParams', () => {
  const app = new Hono()
  const route = app.get(
    '/search',
    validator('query', () => {
      return {} as { q: string; tags: string[] }
    }),
    (c) => {
      return c.json({
        message: 'success',
        queryString: '',
      })
    }
  )

  type AppType = typeof route

  const server = setupServer(
    http.get('http://localhost/search', ({ request }) => {
      const url = new URL(request.url)
      return HttpResponse.json({
        message: 'success',
        queryString: url.search,
      })
    })
  )

  beforeAll(() => server.listen())
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  // Custom buildSearchParams that uses bracket notation for arrays (key[]=value)
  const customBuildSearchParams = (query: Record<string, string | string[]>) => {
    const searchParams = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue
      if (Array.isArray(v)) {
        v.forEach((item) => searchParams.append(`${k}[]`, item))
      } else {
        searchParams.set(k, v)
      }
    }
    return searchParams
  }

  it('Should use custom buildSearchParams for query serialization', async () => {
    const client = hc<AppType>('http://localhost', { buildSearchParams: customBuildSearchParams })
    const res = await client.search.$get({ query: { q: 'test', tags: ['tag1', 'tag2', 'tag3'] } })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.queryString).toBe('?q=test&tags%5B%5D=tag1&tags%5B%5D=tag2&tags%5B%5D=tag3')
  })

  it('Should use default buildSearchParams when custom one is not provided', async () => {
    const client = hc<AppType>('http://localhost')
    const res = await client.search.$get({ query: { q: 'test', tags: ['tag1', 'tag2'] } })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.queryString).toBe('?q=test&tags=tag1&tags=tag2')
  })

  it('Should use custom buildSearchParams in $url() method', () => {
    const client = hc<AppType>('http://localhost', { buildSearchParams: customBuildSearchParams })
    const url = client.search.$url({ query: { q: 'test', tags: ['tag1', 'tag2'] } })

    expect(url.href).toBe('http://localhost/search?q=test&tags%5B%5D=tag1&tags%5B%5D=tag2')
  })

  it('Should use default buildSearchParams in $url() when custom one is not provided', () => {
    const client = hc<AppType>('http://localhost')
    const url = client.search.$url({ query: { q: 'test', tags: ['tag1', 'tag2'] } })

    expect(url.href).toBe('http://localhost/search?q=test&tags=tag1&tags=tag2')
  })
})

describe('Timeout', () => {
  const app = new Hono()
    .get('/fast', (c) => c.json({ ok: true }))
    .get('/slow', (c) => c.json({ ok: true }))

  type AppType = typeof app

  const server = setupServer(
    http.get('http://localhost/fast', async () => {
      return HttpResponse.json({ ok: true })
    }),
    http.get('http://localhost/slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 500))
      return HttpResponse.json({ ok: true })
    })
  )

  beforeAll(() => server.listen())
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  it('Should succeed when request completes before timeout', async () => {
    const client = hc<AppType>('http://localhost', { timeout: 1000 })
    const res = await client.fast.$get()
    expect(res.ok).toBe(true)
    const data = await res.json()
    expect(data.ok).toBe(true)
  })

  it('Should throw TimeoutError when request exceeds timeout', async () => {
    const client = hc<AppType>('http://localhost', { timeout: 100 })
    await expect(client.slow.$get()).rejects.toThrow(TimeoutError)
    await expect(client.slow.$get()).rejects.toThrow('Request timed out after 100ms')
  })

  it('Should allow per-request timeout override', async () => {
    const client = hc<AppType>('http://localhost', { timeout: 1000 })
    await expect(client.slow.$get(undefined, { timeout: 100 })).rejects.toThrow(TimeoutError)
  })

  it('Should work without global timeout but with per-request timeout', async () => {
    const client = hc<AppType>('http://localhost')
    await expect(client.slow.$get(undefined, { timeout: 100 })).rejects.toThrow(TimeoutError)
  })
})

describe('Retry', () => {
  const app = new Hono()
    .get('/success', (c) => c.json({ ok: true }))
    .get('/fail-503', (c) => c.json({ error: 'Service Unavailable' }, 503))
    .get('/fail-once', (c) => c.json({ ok: true }))
    .get('/fail-twice', (c) => c.json({ ok: true }))
    .get('/fail-always', (c) => c.json({ error: 'Always fails' }, 500))

  type AppType = typeof app

  let failOnceCount = 0
  let failTwiceCount = 0

  const server = setupServer(
    http.get('http://localhost/success', () => {
      return HttpResponse.json({ ok: true })
    }),
    http.get('http://localhost/fail-503', () => {
      return HttpResponse.json({ error: 'Service Unavailable' }, { status: 503 })
    }),
    http.get('http://localhost/fail-once', () => {
      failOnceCount++
      if (failOnceCount === 1) {
        return HttpResponse.json({ error: 'Temporary error' }, { status: 503 })
      }
      return HttpResponse.json({ ok: true })
    }),
    http.get('http://localhost/fail-twice', () => {
      failTwiceCount++
      if (failTwiceCount <= 2) {
        return HttpResponse.json({ error: 'Temporary error' }, { status: 503 })
      }
      return HttpResponse.json({ ok: true })
    }),
    http.get('http://localhost/fail-always', () => {
      return HttpResponse.json({ error: 'Always fails' }, { status: 500 })
    })
  )

  beforeAll(() => server.listen())
  afterEach(() => {
    failOnceCount = 0
    failTwiceCount = 0
    server.resetHandlers()
  })
  afterAll(() => server.close())

  it('Should succeed without retry when request is successful', async () => {
    const client = hc<AppType>('http://localhost', {
      retry: { maxRetries: 3 },
    })
    const res = await client.success.$get()
    expect(res.ok).toBe(true)
  })

  it('Should retry on 503 status and eventually succeed', async () => {
    const client = hc<AppType>('http://localhost', {
      retry: {
        maxRetries: 3,
        initialDelayMs: 10,
        retryOn: [503],
      },
    })
    const res = await client['fail-once'].$get()
    expect(res.ok).toBe(true)
    expect(failOnceCount).toBe(2) // First attempt + 1 retry
  })

  it('Should retry multiple times and succeed', async () => {
    const client = hc<AppType>('http://localhost', {
      retry: {
        maxRetries: 3,
        initialDelayMs: 10,
        retryOn: [503],
      },
    })
    const res = await client['fail-twice'].$get()
    expect(res.ok).toBe(true)
    expect(failTwiceCount).toBe(3) // First attempt + 2 retries
  })

  it('Should return last response when retries are exhausted', async () => {
    const client = hc<AppType>('http://localhost', {
      retry: {
        maxRetries: 2,
        initialDelayMs: 10,
        retryOn: [500],
      },
    })
    const res = await client['fail-always'].$get()
    expect(res.ok).toBe(false)
    expect(res.status).toBe(500)
  })

  it('Should not retry when retry is set to false', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Service Unavailable' }), { status: 503 })
    )
    const client = hc<AppType>('http://localhost', {
      fetch: fetchMock,
      retry: false,
    })
    const res = await client['fail-503'].$get()
    expect(res.status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('Should use custom shouldRetry function', async () => {
    let attemptCount = 0
    const fetchMock = vi.fn().mockImplementation(() => {
      attemptCount++
      if (attemptCount < 3) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'Custom error' }), { status: 418 })
        )
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    })

    const client = hc<AppType>('http://localhost', {
      fetch: fetchMock,
      retry: {
        maxRetries: 5,
        initialDelayMs: 10,
        shouldRetry: (response) => response.status === 418,
      },
    })
    const res = await client.success.$get()
    expect(res.ok).toBe(true)
    expect(attemptCount).toBe(3)
  })

  it('Should apply exponential backoff', async () => {
    const delays: number[] = []
    const originalSetTimeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, delay) => {
      if (typeof delay === 'number' && delay > 0) {
        delays.push(delay)
      }
      return originalSetTimeout(fn, 1) // Execute immediately for test speed
    })

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'error' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'error' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'error' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))

    const client = hc<AppType>('http://localhost', {
      fetch: fetchMock,
      retry: {
        maxRetries: 3,
        initialDelayMs: 100,
        backoffMultiplier: 2,
        maxDelayMs: 1000,
        retryOn: [503],
      },
    })

    await client.success.$get()

    // Check that delays follow exponential pattern: 100, 200, 400
    expect(delays).toEqual([100, 200, 400])

    vi.restoreAllMocks()
  })

  it('Should respect maxDelayMs cap', async () => {
    const delays: number[] = []
    const originalSetTimeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, delay) => {
      if (typeof delay === 'number' && delay > 0) {
        delays.push(delay)
      }
      return originalSetTimeout(fn, 1)
    })

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'error' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'error' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'error' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))

    const client = hc<AppType>('http://localhost', {
      fetch: fetchMock,
      retry: {
        maxRetries: 3,
        initialDelayMs: 100,
        backoffMultiplier: 10, // Would be 100, 1000, 10000 without cap
        maxDelayMs: 500,
        retryOn: [503],
      },
    })

    await client.success.$get()

    // All delays should be capped at 500
    expect(delays).toEqual([100, 500, 500])

    vi.restoreAllMocks()
  })

  it('Should allow per-request retry options', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'error' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))

    const client = hc<AppType>('http://localhost', { fetch: fetchMock })
    const res = await client.success.$get(undefined, {
      retry: {
        maxRetries: 1,
        initialDelayMs: 10,
        retryOn: [503],
      },
    })
    expect(res.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('Should not retry on network errors when timeout is exceeded', async () => {
    const client = hc<AppType>('http://localhost', {
      timeout: 50,
      retry: {
        maxRetries: 3,
        initialDelayMs: 10,
      },
    })

    // Mock a slow endpoint
    server.use(
      http.get('http://localhost/success', async () => {
        await new Promise((resolve) => setTimeout(resolve, 200))
        return HttpResponse.json({ ok: true })
      })
    )

    await expect(client.success.$get()).rejects.toThrow(TimeoutError)
  })
})

describe('Retry with Timeout', () => {
  const app = new Hono().get('/intermittent', (c) => c.json({ ok: true }))

  type AppType = typeof app

  const server = setupServer()

  beforeAll(() => server.listen())
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  it('Should retry and succeed with both timeout and retry configured', async () => {
    let attemptCount = 0

    server.use(
      http.get('http://localhost/intermittent', async () => {
        attemptCount++
        if (attemptCount < 3) {
          return HttpResponse.json({ error: 'error' }, { status: 503 })
        }
        return HttpResponse.json({ ok: true })
      })
    )

    const client = hc<AppType>('http://localhost', {
      timeout: 5000,
      retry: {
        maxRetries: 3,
        initialDelayMs: 10,
        retryOn: [503],
      },
    })

    const res = await client.intermittent.$get()
    expect(res.ok).toBe(true)
    expect(attemptCount).toBe(3)
  })
})

describe('onRetry callback', () => {
  const app = new Hono()
    .get('/fail-twice', (c) => c.json({ ok: true }))
    .get('/network-error', (c) => c.json({ ok: true }))

  type AppType = typeof app

  let failCount = 0

  const server = setupServer(
    http.get('http://localhost/fail-twice', () => {
      failCount++
      if (failCount <= 2) {
        return HttpResponse.json({ error: 'error' }, { status: 503 })
      }
      return HttpResponse.json({ ok: true })
    })
  )

  beforeAll(() => server.listen())
  afterEach(() => {
    failCount = 0
    server.resetHandlers()
  })
  afterAll(() => server.close())

  it('Should call onRetry with correct context for retryable responses', async () => {
    const retryCalls: Array<{ attempt: number; delayMs: number; hasResponse: boolean }> = []

    const client = hc<AppType>('http://localhost', {
      retry: {
        maxRetries: 3,
        initialDelayMs: 10,
        retryOn: [503],
        onRetry: ({ attempt, response, delayMs }) => {
          retryCalls.push({ attempt, delayMs, hasResponse: !!response })
        },
      },
    })

    const res = await client['fail-twice'].$get()
    expect(res.ok).toBe(true)
    expect(retryCalls).toHaveLength(2)
    expect(retryCalls[0]).toEqual({ attempt: 1, delayMs: 10, hasResponse: true })
    expect(retryCalls[1]).toEqual({ attempt: 2, delayMs: 20, hasResponse: true })
  })

  it('Should call onRetry with error context for network errors', async () => {
    const retryCalls: Array<{ attempt: number; hasError: boolean; errorMessage?: string }> = []

    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('Network failure'))
      .mockRejectedValueOnce(new Error('Connection reset'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))

    const client = hc<AppType>('http://localhost', {
      fetch: fetchMock,
      retry: {
        maxRetries: 3,
        initialDelayMs: 10,
        onRetry: ({ attempt, error }) => {
          retryCalls.push({ attempt, hasError: !!error, errorMessage: error?.message })
        },
      },
    })

    const res = await client['network-error'].$get()
    expect(res.ok).toBe(true)
    expect(retryCalls).toHaveLength(2)
    expect(retryCalls[0]).toEqual({ attempt: 1, hasError: true, errorMessage: 'Network failure' })
    expect(retryCalls[1]).toEqual({ attempt: 2, hasError: true, errorMessage: 'Connection reset' })
  })

  it('Should support async onRetry callback', async () => {
    const asyncOperations: number[] = []

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'error' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))

    const client = hc<AppType>('http://localhost', {
      fetch: fetchMock,
      retry: {
        maxRetries: 2,
        initialDelayMs: 10,
        retryOn: [503],
        onRetry: async ({ attempt }) => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          asyncOperations.push(attempt)
        },
      },
    })

    await client['fail-twice'].$get()
    expect(asyncOperations).toEqual([1])
  })
})

describe('Backoff strategies', () => {
  const app = new Hono().get('/test', (c) => c.json({ ok: true }))

  type AppType = typeof app

  it('Should use linear backoff when specified', async () => {
    const delays: number[] = []
    const originalSetTimeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, delay) => {
      if (typeof delay === 'number' && delay > 0) {
        delays.push(delay)
      }
      return originalSetTimeout(fn, 1)
    })

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'error' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'error' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'error' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))

    const client = hc<AppType>('http://localhost', {
      fetch: fetchMock,
      retry: {
        maxRetries: 3,
        initialDelayMs: 100,
        backoff: 'linear',
        retryOn: [503],
      },
    })

    await client.test.$get()

    // Linear: 100 * (0+1), 100 * (1+1), 100 * (2+1) = 100, 200, 300
    expect(delays).toEqual([100, 200, 300])

    vi.restoreAllMocks()
  })

  it('Should use exponential backoff by default', async () => {
    const delays: number[] = []
    const originalSetTimeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, delay) => {
      if (typeof delay === 'number' && delay > 0) {
        delays.push(delay)
      }
      return originalSetTimeout(fn, 1)
    })

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'error' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'error' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'error' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))

    const client = hc<AppType>('http://localhost', {
      fetch: fetchMock,
      retry: {
        maxRetries: 3,
        initialDelayMs: 100,
        backoffMultiplier: 2,
        // backoff not specified, should default to 'exponential'
        retryOn: [503],
      },
    })

    await client.test.$get()

    // Exponential: 100 * 2^0, 100 * 2^1, 100 * 2^2 = 100, 200, 400
    expect(delays).toEqual([100, 200, 400])

    vi.restoreAllMocks()
  })

  it('Should respect maxDelayMs with linear backoff', async () => {
    const delays: number[] = []
    const originalSetTimeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, delay) => {
      if (typeof delay === 'number' && delay > 0) {
        delays.push(delay)
      }
      return originalSetTimeout(fn, 1)
    })

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'error' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'error' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'error' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))

    const client = hc<AppType>('http://localhost', {
      fetch: fetchMock,
      retry: {
        maxRetries: 3,
        initialDelayMs: 100,
        maxDelayMs: 150,
        backoff: 'linear',
        retryOn: [503],
      },
    })

    await client.test.$get()

    // Linear would be 100, 200, 300 but capped at 150
    expect(delays).toEqual([100, 150, 150])

    vi.restoreAllMocks()
  })
})

describe('External AbortSignal with timeout', () => {
  const app = new Hono()
    .get('/slow', (c) => c.json({ ok: true }))
    .get('/fast', (c) => c.json({ ok: true }))

  type AppType = typeof app

  const server = setupServer(
    http.get('http://localhost/slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 500))
      return HttpResponse.json({ ok: true })
    }),
    http.get('http://localhost/fast', async () => {
      return HttpResponse.json({ ok: true })
    })
  )

  beforeAll(() => server.listen())
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  it('Should abort request when external signal is aborted', async () => {
    const controller = new AbortController()

    const client = hc<AppType>('http://localhost', {
      timeout: 5000, // Long timeout
      init: {
        signal: controller.signal,
      },
    })

    // Abort after a short delay
    setTimeout(() => controller.abort(), 50)

    await expect(client.slow.$get()).rejects.toThrow()
  })

  it('Should propagate external abort even with timeout configured', async () => {
    const controller = new AbortController()

    const client = hc<AppType>('http://localhost', {
      timeout: 5000,
    })

    // Abort immediately
    controller.abort()

    await expect(
      client.slow.$get(undefined, { init: { signal: controller.signal } })
    ).rejects.toThrow()
  })

  it('Should succeed when neither timeout nor external abort triggers', async () => {
    const controller = new AbortController()

    const client = hc<AppType>('http://localhost', {
      timeout: 5000,
      init: {
        signal: controller.signal,
      },
    })

    const res = await client.fast.$get()
    expect(res.ok).toBe(true)
  })

  it('Should not retry on external abort', async () => {
    const controller = new AbortController()
    let attemptCount = 0

    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      attemptCount++
      // Check if signal is aborted
      if (init?.signal?.aborted) {
        const error = new Error('Aborted')
        error.name = 'AbortError'
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })

    const client = hc<AppType>('http://localhost', {
      fetch: fetchMock,
      retry: {
        maxRetries: 3,
        initialDelayMs: 10,
      },
    })

    // Abort immediately
    controller.abort()

    await expect(
      client.slow.$get(undefined, { init: { signal: controller.signal } })
    ).rejects.toThrow()
    expect(attemptCount).toBe(1) // Should not retry
  })
})
