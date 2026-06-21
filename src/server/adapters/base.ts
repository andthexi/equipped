import http, { type IncomingMessage, type ServerResponse } from 'node:http'

import { type FastifyCorsOptions } from '@fastify/cors'
import { type CorsOptions } from 'cors'
import { Server as SocketServer } from 'socket.io'
import supertest from 'supertest'
import type TestAgent from 'supertest/lib/agent'
import { type Pipe, PipeError, v, type PipeOutput } from 'valleyed'

import { EquippedError, NotFoundError, RequestError } from '../../errors'
import { EventBus } from '../../events'
import { Instance } from '../../instance'
import type { AuthUser } from '../../types'
import { pipeErrorToValidationError } from '../../validations'
import { requestLocalStorage, responseLocalStorage } from '../../validations/valleyed'
import { openapi, type OpenApiSchemaDef } from '../openapi'
import { Request, Response } from '../requests'
import { BaseRequestAuthMethod } from '../requests-auth-methods'
import { Router } from '../routes'
import { SocketEmitter } from '../sockets'
import {
	Methods,
	type MergeRouteContracts,
	type RejectDuplicateRoutes,
	type Route,
	type RouteContractHost,
	type RouteContractOf,
	type RouteDef,
	type RouteOutput,
	type RouteRegistryOf,
	StatusCodes,
	type MethodsEnum,
	type routeContractSymbol,
	type routeRegistrySymbol,
} from '../types'

export const serverConfigPipe = () =>
	v.object({
		port: v.number(),
		cors: v.optional(
			v.object({
				origin: v.optional(v.or([v.array(v.string()), v.is(true as const)])),
				methods: v.optional(v.array(v.in(Object.values(Methods)))),
				credentials: v.optional(v.boolean()),
			}),
		),
		eventBus: v.optional(v.instanceOf(EventBus)),
		publicPath: v.optional(v.string()),
		healthPath: v.optional(v.string()),
		openapi: v.defaults(
			v.object({
				docsVersion: v.defaults(v.string(), '1.0.0'),
				docsBaseUrl: v.defaults(v.array(v.string()), ['/']),
				docsPath: v.defaults(v.string(), '/__docs'),
			}),
			{},
		),
		requests: v.defaults(
			v.object({
				log: v.defaults(v.boolean(), true),
				rateLimit: v.defaults(
					v.object({
						enabled: v.defaults(v.boolean(), false),
						periodInMs: v.defaults(v.number(), 60 * 60 * 1000),
						limit: v.defaults(v.number(), 5000),
					}),
					{},
				),
				slowdown: v.defaults(
					v.object({
						enabled: v.defaults(v.boolean(), false),
						periodInMs: v.defaults(v.number(), 10 * 60 * 1000),
						delayAfter: v.defaults(v.number(), 2000),
						delayInMs: v.defaults(v.number(), 500),
					}),
					{},
				),
			}),
			{},
		),
		socketsAuthMethods: v.defaults(v.array(v.instanceOf(BaseRequestAuthMethod<AuthUser>)), []),
	})

export type ServerConfig = PipeOutput<ReturnType<typeof serverConfigPipe>>

type RequestValidator = (req: Request<any>) => Promise<Request<any>>
type ResponseValidator = (res: Response<any>) => Promise<Response<any>>

const rawResponseHandledSymbol: unique symbol = Symbol('rawResponseHandled')
export type RawResponseHandled = { readonly [rawResponseHandledSymbol]: true }
export type RawResponseHandler = (request: IncomingMessage, response: ServerResponse) => unknown | Promise<unknown>
export type RawResponder = (handler: RawResponseHandler) => Promise<RawResponseHandled>
export type ServerBeforeListenContext = { httpServer: http.Server; port: number }
export type ServerBeforeListenHandler = (context: ServerBeforeListenContext) => void | Promise<void>
export type ServerNotFoundContext = { request: Request<any>; respondWithRaw: RawResponder }
export type ServerNotFoundHandler = (
	context: ServerNotFoundContext,
) => Response<any> | RawResponseHandled | Promise<Response<any> | RawResponseHandled>

const rawResponseHandled: RawResponseHandled = Object.freeze({ [rawResponseHandledSymbol]: true })
const rawResponseNotStartedMessage = 'Raw not-found handler did not start or complete a response'

function isRawResponseHandled(input: unknown): input is RawResponseHandled {
	return Boolean(input && typeof input === 'object' && rawResponseHandledSymbol in input)
}

function hasRawResponseStarted(response: ServerResponse): boolean {
	return response.headersSent || response.writableEnded
}

function writeRawHandlerError(response: ServerResponse, error: unknown) {
	if (hasRawResponseStarted(response)) return
	response.statusCode = StatusCodes.BadRequest
	response.setHeader('Content-Type', 'application/json')
	const message = error instanceof Error ? error.message : `${error}`
	response.end(JSON.stringify([{ message }]))
}

const errorsSchemas = Object.entries(StatusCodes)
	.filter(([, value]) => value > 399)
	.map(([key, value]) => ({
		status: value,
		contentType: 'application/json',
		pipe: v.meta(v.array(v.object({ message: v.string(), field: v.optional(v.string()) })), {
			$refId: `Errors.${key}Response`,
			description: `${key} Response`,
		}) as Pipe<any, any>,
	}))

export abstract class Server<PublicContract = {}, Registry = PublicContract> implements RouteContractHost<PublicContract, Registry> {
	declare readonly [routeContractSymbol]?: PublicContract
	declare readonly [routeRegistrySymbol]?: Registry
	socket!: SocketEmitter
	cors!: CorsOptions & FastifyCorsOptions
	#httpServer!: http.Server
	#oai!: ReturnType<typeof openapi>
	#serverConfig!: ServerConfig
	#queue: (() => void | Promise<void>)[] = []
	#routesByKey = new Set<string>()
	#started = false
	#beforeListenHandlers: ServerBeforeListenHandler[] = []
	#notFoundHandler: ServerNotFoundHandler | null = null

	protected abstract parseRequest(req: any): Promise<Request<any>>
	protected abstract handleResponse(res: any, response: Response<any>): Promise<void>
	protected abstract createRawResponder(req: any, res: any): RawResponder
	protected abstract registerRoute(method: MethodsEnum, path: string, cb: (req: any, res: any) => Promise<void>): void
	protected abstract registerErrorHandler(cb: (error: Error, req: any, res: any) => Promise<void>): void
	protected abstract registerNotFoundHandler(cb: (req: any, res: any) => Promise<void>): void
	protected abstract startServer(port: number): Promise<boolean>

	protected setup(httpServer: http.Server, config: ServerConfig) {
		this.#httpServer = httpServer
		this.#serverConfig = config
		this.cors = {
			origin: config.cors?.origin ? (_, cb) => cb(null, true) : config.cors?.origin,
			methods: (config.cors?.methods ?? Object.values(Methods)).filter((m) => m !== Methods.options).map((m) => m.toUpperCase()),
			credentials: config.cors?.credentials,
		}
		this.#oai = openapi(config)
		const socketInstance = new SocketServer(httpServer, { cors: this.cors })
		this.socket = new SocketEmitter(socketInstance, config)
		this.addRouter(this.#oai.router)
	}

	addRouter<R extends Router<any, any, any, any, any>>(
		router: R & RejectDuplicateRoutes<Registry, RouteRegistryOf<R>>,
	): Server<MergeRouteContracts<PublicContract, RouteContractOf<R>>, MergeRouteContracts<Registry, RouteRegistryOf<R>>> {
		this.addRoute(...router.routes)
		return this as unknown as Server<MergeRouteContracts<PublicContract, RouteContractOf<R>>, MergeRouteContracts<Registry, RouteRegistryOf<R>>>
	}

	/** @deprecated Prefer registering routes through a Router and adding it with addRouter() so Route Contracts stay tracked. */
	addRoute<T extends RouteDef>(...routes: Route<T>[]) {
		routes.forEach((route) => {
			this.#queue.push(async () => {
				const { method, path, schema = {}, onError, middlewares = [], responseMiddlewares = [] } = route

				const key = `(${method.toUpperCase()}) ${this.#oai.cleanPath(path)}`
				if (this.#routesByKey.has(key))
					throw new EquippedError(`Route key ${key} already registered. All route keys must be unique`, { route, key })

				middlewares.forEach((m) => m.onSetup?.(route as any))
				onError?.onSetup?.(route as any)
				responseMiddlewares.forEach((m) => m.onSetup?.(route as any))

				const { validateRequest, validateResponse, jsonSchema } = this.#resolveSchema(method, schema)

				this.#routesByKey.add(key)
				await this.#oai.register(route, jsonSchema)
				this.registerRoute(method, this.#oai.cleanPath(path), async (req, res) => {
					const request = await validateRequest(await this.parseRequest(req))
					try {
						for (const middleware of middlewares) await middleware.cb(request)
						const rawRes = await route.handler(request)
						const response =
							rawRes instanceof Response
								? rawRes
								: new Response<any>({ body: rawRes, status: StatusCodes.Ok, headers: {}, cookies: {}, contentType: 'application/json', piped: false })
						for (const middleware of responseMiddlewares) await middleware.cb(request, response)
						return await this.handleResponse(res, await validateResponse(response))
					} catch (error) {
						if (onError?.cb) {
							const rawResponse = await onError.cb(request, error as Error)
							const response =
								rawResponse instanceof Response
									? rawResponse
									: new Response<any>({ body: rawResponse, status: StatusCodes.BadRequest, headers: {}, cookies: {}, contentType: 'application/json' })
							return await this.handleResponse(res, await validateResponse(response))
						}
						throw error
					}
				})
			})
		})
		return this
	}

	setNotFoundHandler(handler: ServerNotFoundHandler): this {
		if (this.#started) throw new EquippedError('Cannot set not-found handler after server has started', {})
		this.#notFoundHandler = handler
		return this
	}

	onBeforeListen(handler: ServerBeforeListenHandler): this {
		if (this.#started) throw new EquippedError('Cannot add before-listen handler after server has started', {})
		this.#beforeListenHandlers.push(handler)
		return this
	}

	test(): TestAgent {
		return supertest(this.#httpServer)
	}

	async start(): Promise<boolean> {
		this.#started = true
		const config = this.#serverConfig
		const instance = Instance.get()
		const { app } = instance.settings
		if (config.healthPath)
			this.addRoute({
				method: Methods.get,
				path: config.healthPath,
				schema: { defaultContentType: 'text/plain' },
				handler: async (req) =>
					req.res({
						body: `${instance.id}(${app.name}) service running`,
						contentType: 'text/plain',
						headers: {},
						cookies: {},
					}),
			})

		await Promise.all(this.#queue.map((cb) => cb()))

		this.registerNotFoundHandler(async (req, res) => await this.#handleNotFound(req, res))
		this.registerErrorHandler(async (error, _, res) => {
			if (!(error instanceof EquippedError)) Instance.get().log.error({ error }, 'Uncaught error in route handler')
			const response =
				error instanceof RequestError
					? new Response<any>({
							body: error.serializedErrors,
							status: error.statusCode,
							headers: {},
							cookies: {},
							contentType: 'application/json',
						})
					: error instanceof EquippedError
						? new Response<any>({
								body: [{ message: error.message }],
								status: StatusCodes.BadRequest,
								headers: {},
								cookies: {},
								contentType: 'application/json',
							})
						: new Response<any>({
								body: [{ message: 'Something went wrong', data: error.message }],
								status: StatusCodes.BadRequest,
								headers: {},
								cookies: {},
								contentType: 'application/json',
							})
			return await this.handleResponse(res, response)
		})

		for (const handler of this.#beforeListenHandlers) await handler({ httpServer: this.#httpServer, port: config.port })

		const started = await this.startServer(config.port)
		if (started) Instance.get().log.info(`${instance.id}(${app.name}) service listening on port ${config.port}`)
		return started
	}

	protected createNodeRawResponder(input: {
		request: IncomingMessage
		response: ServerResponse
		beforeHandle?: () => void
	}): RawResponder {
		return async (handler) => {
			input.beforeHandle?.()
			try {
				await handler(input.request, input.response)
			} catch (error) {
				if (!hasRawResponseStarted(input.response)) {
					writeRawHandlerError(input.response, error)
					return rawResponseHandled
				}
				throw error
			}
			if (!hasRawResponseStarted(input.response))
				writeRawHandlerError(input.response, new EquippedError(rawResponseNotStartedMessage, {}))
			return rawResponseHandled
		}
	}

	async #handleNotFound(req: any, res: any) {
		const request = await this.parseRequest(req)
		if (!this.#notFoundHandler) throw new NotFoundError(`Route ${request.path} not found`)
		const result = await this.#notFoundHandler({ request, respondWithRaw: this.createRawResponder(req, res) })
		if (isRawResponseHandled(result)) return
		if (result instanceof Response) return await this.handleResponse(res, result)
		throw new EquippedError('Not-found handler must return a Response or respondWithRaw(...)', {})
	}

	#resolveSchema(method: MethodsEnum, schema: RouteDef) {
		const defaultStatusCode = schema?.defaultStatusCode ?? StatusCodes.Ok
		const defaultContentType = schema?.defaultContentType ?? 'application/json'
		let status = defaultStatusCode
		let contentType = defaultContentType
		const jsonSchema: OpenApiSchemaDef = { response: {}, request: {} }
		const requestPipeDefs: Pick<RouteDef, 'body' | 'headers' | 'query' | 'params' | 'cookies'> = {}
		const responsePipeDefs: Pick<RouteDef, 'response' | 'responseHeaders' | 'responseCookies'> = {}

		const defs: {
			key: Exclude<keyof RouteDef, `default${string}` | 'context'>
			type: keyof OpenApiSchemaDef
			skip?: boolean
		}[] = [
			{ key: 'params', type: 'request' },
			{ key: 'headers', type: 'request' },
			{ key: 'cookies', type: 'request' },
			{ key: 'query', type: 'request' },
			{ key: 'body', type: 'request', skip: !(<MethodsEnum[]>[Methods.post, Methods.put, Methods.patch]).includes(method) },
			{ key: 'response', type: 'response' },
			{ key: 'responseHeaders', type: 'response' },
			{ key: 'responseCookies', type: 'response' },
		]
		defs.forEach((def) => {
			const pipe = schema[def.key] ?? v.any()
			if (def.skip) return

			if (def.type === 'request') {
				requestPipeDefs[def.key] = pipe
				jsonSchema.request[def.key as keyof typeof jsonSchema.request] = v.schema(pipe)
			}
			if (def.type === 'response') {
				const pipeRecords = errorsSchemas.concat({ status: defaultStatusCode, contentType, pipe })
				responsePipeDefs[def.key] = v.any().pipe((input) => {
					const p = pipeRecords.find((rec) => rec.status === status)?.pipe
					if (!p) throw PipeError.root(`schema not defined for status code: ${status}`, input)
					const r = v.validate(p, input)
					if (!r.valid) throw r.error
					return r.value
				})
				jsonSchema.response[def.key as keyof typeof jsonSchema.response] = pipeRecords.map((record) => ({
					status: record.status,
					contentType: record.contentType,
					schema: v.schema(record.pipe),
				}))
			}
		})
		const requestPipe = v.object(requestPipeDefs)
		v.compile(requestPipe, { allErrors: true })
		const responsePipe = v.object(responsePipeDefs)
		v.compile(responsePipe, { allErrors: true })
		const validateRequest: RequestValidator = async (request) => {
			if (!Object.keys(requestPipeDefs)) return request
			const validity = requestLocalStorage.run(request, () =>
				v.validate(requestPipe, {
					params: request.params,
					headers: request.headers,
					query: request.query,
					body: request.body,
					cookies: request.cookies,
				}),
			)

			if (!validity.valid) throw pipeErrorToValidationError(validity.error)
			request.params = validity.value.params!
			request.headers = validity.value.headers!
			request.query = validity.value.query!
			request.body = validity.value.body!
			request.cookies = validity.value.cookies!
			return request
		}
		const validateResponse: ResponseValidator = async (response) => {
			if (!Object.keys(responsePipeDefs)) return response
			status = response.status
			contentType = response.contentType

			const validity = responseLocalStorage.run(response, () =>
				v.validate(responsePipe, {
					responseHeaders: response.headers,
					responseCookies: Object.fromEntries(Object.entries(response.cookies).map(([key, val]) => [key, val.value] as const)),
					response: response.body,
				}),
			)

			if (!validity.valid) throw pipeErrorToValidationError(validity.error)
			response.body = validity.value.response!
			response.headers = validity.value.responseHeaders!
			response.cookieValues = validity.value.responseCookies!
			return response
		}
		return {
			jsonSchema,
			validateRequest,
			validateResponse,
		}
	}
}

if (import.meta.vitest) {
	const { describe, expect, expectTypeOf, test } = import.meta.vitest

	const testInstanceState = globalThis as typeof globalThis & { __equippedTestInstanceAliased?: boolean }

	function ensureTestInstance() {
		const instance = Instance.maybeGet() ?? Instance.create({ app: { name: 'equipped-test' }, log: { level: 'silent' } })
		if (!testInstanceState.__equippedTestInstanceAliased) {
			instance.alias('equipped-test')
			testInstanceState.__equippedTestInstanceAliased = true
		}
	}

	function createRawResponse() {
		const chunks: string[] = []
		return {
			statusCode: 200,
			headersSent: false,
			writableEnded: false,
			headers: {} as Record<string, string>,
			setHeader(key: string, value: string) {
				this.headers[key] = value
			},
			end(chunk?: unknown) {
				if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk))
				this.headersSent = true
				this.writableEnded = true
			},
			body() {
				return chunks.join('')
			},
		}
	}

	class TestServer extends Server {
		handledResponse: Response<any> | null = null
		startedPorts: number[] = []
		private notFoundHandler: ((req: any, res: any) => Promise<void>) | null = null

		constructor() {
			super()
			this.setup(http.createServer(), {
				port: 0,
				cors: undefined,
				eventBus: undefined,
				publicPath: undefined,
				healthPath: undefined,
				openapi: { docsVersion: '1.0.0', docsBaseUrl: ['/'], docsPath: '/__docs' },
				requests: {
					log: false,
					rateLimit: { enabled: false, periodInMs: 1, limit: 1 },
					slowdown: { enabled: false, periodInMs: 1, delayAfter: 1, delayInMs: 1 },
				},
				socketsAuthMethods: [],
			})
		}

		protected async parseRequest(req: any) {
			return new Request<any>({
				ip: '127.0.0.1',
				body: {},
				cookies: {},
				params: {},
				query: {},
				method: Methods.get,
				path: req.path,
				headers: {},
				files: {},
			})
		}

		protected async handleResponse(_: any, response: Response<any>) {
			this.handledResponse = response
		}

		protected createRawResponder(req: any, res: any): RawResponder {
			return this.createNodeRawResponder({ request: req.rawRequest, response: res.rawResponse })
		}

		protected registerRoute() {}
		protected registerErrorHandler() {}

		protected registerNotFoundHandler(cb: (req: any, res: any) => Promise<void>) {
			this.notFoundHandler = cb
		}

		protected async startServer(port: number) {
			this.startedPorts.push(port)
			return true
		}

		async dispatchNotFound(
			path: string,
		): Promise<{ handledResponse: Response<any> | null; rawResponse: ReturnType<typeof createRawResponse> }> {
			if (!this.notFoundHandler) throw new Error('not-found handler was not registered')
			this.handledResponse = null
			const rawResponse = createRawResponse()
			await this.notFoundHandler({ path, rawRequest: {} }, { rawResponse })
			return { handledResponse: this.handledResponse, rawResponse }
		}
	}

	describe('Server Route Contracts', () => {
		test('addRouter returns a server widened with public router routes', () => {
			ensureTestInstance()
			const router = new Router({ path: '/api' }).get('/ping', {
				schema: {
					response: v.object({ ok: v.boolean() }),
				},
			})(() => ({ ok: true }))

			const _server = new TestServer().addRouter(router)
			type Contract = RouteContractOf<typeof _server>

			expectTypeOf<RouteOutput<Contract, 'get', '/api/ping'>['body']>().toEqualTypeOf<{ ok: boolean }>()
		})

		test('addRouter excludes hidden routes from the public route contract but keeps them in duplicate checks', () => {
			ensureTestInstance()
			const hidden = new Router().get('/internal', { hide: true })(() => null)
			const visibleDuplicate = new Router().get('/internal')(() => null)
			const server = new TestServer().addRouter(hidden)

			expectTypeOf<RouteContractOf<typeof server>>().toEqualTypeOf<{}>()
			// @ts-expect-error duplicate route identity: get /internal
			server.addRouter(visibleDuplicate)
		})
	})

	describe('Server before-listen handlers', () => {
		test('runs before-listen handlers before adapter listen in registration order', async () => {
			ensureTestInstance()
			const server = new TestServer()
			const calls: string[] = []
			let receivedServer: http.Server | null = null

			server
				.onBeforeListen(({ httpServer, port }) => {
					calls.push(`first:${port}`)
					receivedServer = httpServer
					expect(server.startedPorts).toEqual([])
				})
				.onBeforeListen(({ httpServer, port }) => {
					calls.push(`second:${port}`)
					expect(httpServer).toBe(receivedServer)
					expect(server.startedPorts).toEqual([])
				})

			await server.start()

			expect(calls).toEqual(['first:0', 'second:0'])
			expect(receivedServer).toBeInstanceOf(http.Server)
			expect(server.startedPorts).toEqual([0])
		})

		test('rejects startup when a before-listen handler fails before adapter listen', async () => {
			ensureTestInstance()
			const server = new TestServer()
			server.onBeforeListen(async () => {
				throw new Error('before-listen failed')
			})

			await expect(server.start()).rejects.toThrow('before-listen failed')
			expect(server.startedPorts).toEqual([])
		})

		test('rejects adding before-listen handlers after server startup', async () => {
			ensureTestInstance()
			const server = new TestServer()
			await server.start()

			expect(() => server.onBeforeListen(() => {})).toThrow('Cannot add before-listen handler after server has started')
		})
	})

	describe('Server not-found handler', () => {
		test('throws the default Equipped not-found error when no custom handler is set', async () => {
			ensureTestInstance()
			const server = new TestServer()
			await server.start()

			await expect(server.dispatchNotFound('/missing')).rejects.toBeInstanceOf(NotFoundError)
		})

		test('allows a custom not-found handler to return an Equipped response', async () => {
			ensureTestInstance()
			const server = new TestServer()
			server.setNotFoundHandler(
				({ request }) =>
					new Response<any>({
						body: [{ message: `No route for ${request.path}` }],
						status: StatusCodes.NotFound,
						headers: {},
						cookies: {},
						contentType: 'application/json',
					}),
			)
			await server.start()

			const result = await server.dispatchNotFound('/custom')

			expect(result.handledResponse?.status).toBe(StatusCodes.NotFound)
			expect(result.handledResponse?.body).toEqual([{ message: 'No route for /custom' }])
		})

		test('allows a custom not-found handler to complete the response through a raw Node listener', async () => {
			ensureTestInstance()
			const server = new TestServer()
			server.setNotFoundHandler(({ respondWithRaw }) =>
				respondWithRaw((_, response) => {
					response.statusCode = 203
					response.end('raw fallback')
				}),
			)
			await server.start()

			const result = await server.dispatchNotFound('/page')

			expect(result.handledResponse).toBeNull()
			expect(result.rawResponse.statusCode).toBe(203)
			expect(result.rawResponse.body()).toBe('raw fallback')
		})

		test('writes a clear raw error when a raw not-found handler does not start a response', async () => {
			ensureTestInstance()
			const server = new TestServer()
			server.setNotFoundHandler(({ respondWithRaw }) => respondWithRaw(() => {}))
			await server.start()

			const result = await server.dispatchNotFound('/page')

			expect(result.handledResponse).toBeNull()
			expect(result.rawResponse.statusCode).toBe(StatusCodes.BadRequest)
			expect(result.rawResponse.body()).toContain(rawResponseNotStartedMessage)
		})

		test('rejects a custom not-found handler result that is neither an Equipped response nor raw completion', async () => {
			ensureTestInstance()
			const server = new TestServer()
			server.setNotFoundHandler((() => undefined) as unknown as ServerNotFoundHandler)
			await server.start()

			await expect(server.dispatchNotFound('/bad')).rejects.toThrow('Not-found handler must return a Response or respondWithRaw(...)')
		})

		test('rejects setting the custom not-found handler after server startup', async () => {
			ensureTestInstance()
			const server = new TestServer()
			await server.start()

			expect(() =>
				server.setNotFoundHandler(
					() =>
						new Response<any>({
							body: null,
							status: StatusCodes.NotFound,
							headers: {},
							cookies: {},
							contentType: 'application/json',
						}),
				),
			).toThrow('Cannot set not-found handler after server has started')
		})
	})
}
