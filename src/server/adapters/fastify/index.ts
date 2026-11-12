import fastifyCookie from '@fastify/cookie'
import fastifyCors from '@fastify/cors'
import fastifyFormBody from '@fastify/formbody'
import fastifyHelmet from '@fastify/helmet'
import fastifyMultipart from '@fastify/multipart'
import fastifyRateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
// import fastifySlowDown from 'fastify-slow-down'
import qs from 'qs'

import { ValidationError } from '../../../errors/index.js'
import { Instance } from '../../../instance/index.js'
import { configurable, getMediaDuration } from '../../../utilities/index.js'
import type { Response } from '../../requests.js'
import { Request } from '../../requests.js'
import { StatusCodes, type IncomingFile, type MethodsEnum } from '../../types.js'
import { type RawResponder, Server, serverConfigPipe } from '../base.js'

export class FastifyServer extends configurable(serverConfigPipe, Server) {
	#app: ReturnType<typeof Fastify>

	protected constructor(config: typeof FastifyServer.Config) {
		super(config)
		const instance = Instance.get()
		const app = Fastify({
			disableRequestLogging: !config.requests.log,
			loggerInstance: config.requests.log ? instance.log : undefined,
			ajv: { customOptions: { coerceTypes: false } },
			routerOptions: {
				ignoreTrailingSlash: true,
				caseSensitive: false,
			},
			schemaErrorFormatter: (errors, data) =>
				new ValidationError(
					errors.map((error) => ({
						messages: [error.message ?? ''],
						field: `${data}${error.instancePath}`.replaceAll('/', '.'),
					})),
				),
		})
		this.#app = app

		this.setup(app.server, config)

		app.decorateRequest('savedReq', null)
		app.setValidatorCompiler(() => () => true)
		app.setSerializerCompiler(() => (data) => JSON.stringify(data))
		if (config.publicPath) app.register(fastifyStatic, { root: config.publicPath })
		app.register(fastifyCookie, {})
		app.register(fastifyCors, this.cors)
		app.register(fastifyFormBody, { parser: (str) => qs.parse(str) })
		app.register(fastifyHelmet, {
			crossOriginResourcePolicy: { policy: 'cross-origin' },
			contentSecurityPolicy: false,
		})
		app.register(fastifyMultipart, {
			attachFieldsToBody: 'keyValues',
			throwFileSizeLimit: false,
			limits: { fileSize: instance.settings.utils.maxFileUploadSizeInMb * 1024 * 1024 },
			onFile: async (f) => {
				const buffer = await f.toBuffer()
				const parsed: IncomingFile = {
					name: f.filename,
					type: f.mimetype,
					size: buffer.byteLength,
					isTruncated: f.file.truncated,
					data: buffer,
					duration: await getMediaDuration(buffer),
				}
				// @ts-ignore
				f.value = parsed
			},
		})
		/* if (this.settings.slowdown.enabled) app.register(fastifySlowDown, {
				timeWindow: this.settings.slowdown.periodInMs,
				delayAfter: this.settings.slowdown.delayAfter,
				delay: this.settings.slowdown.delayInMs
			}) */
		if (config.requests.rateLimit.enabled)
			app.register(fastifyRateLimit, {
				max: config.requests.rateLimit.limit,
				timeWindow: config.requests.rateLimit.periodInMs,
				errorResponseBuilder: (_, context) => ({
					statusCode: StatusCodes.TooManyRequests,
					message: JSON.stringify([{ message: `Too Many Requests. Retry in ${context.after}` }]),
				}),
			})
	}

	protected async parseRequest(req: any) {
		const { body, files } = excludeBufferKeys(req.body ?? {})

		return new Request({
			ip: req.ip,
			body,
			cookies: req.cookies ?? {},
			params: req.params ?? <any>{},
			query: req.query ?? {},
			method: <any>req.method,
			path: req.url,
			headers: req.headers,
			files,
		})
	}

	protected async handleResponse(res: any, response: Response<any>) {
		for (const [key, { value, ...opts }] of Object.entries(response.cookies)) res = res.setCookie(key, value, opts)
		const reply = res.status(response.status).headers(response.headers)
		await (response.status === StatusCodes.NoContent ? reply.send() : reply.send(response.body))
	}

	protected createRawResponder(req: FastifyRequest, res: FastifyReply): RawResponder {
		return this.createNodeRawResponder({ request: req.raw, response: res.raw, beforeHandle: () => res.hijack() })
	}

	protected registerRoute(method: MethodsEnum, path: string, cb: (req: any, res: any) => Promise<void>) {
		this.#app.register(async (inst) => {
			inst.route({ url: path, method, handler: cb })
		})
	}

	protected registerErrorHandler(cb: (error: Error, req: any, res: any) => Promise<void>) {
		this.#app.setErrorHandler(cb)
	}

	protected registerNotFoundHandler(cb: (req: any, res: any) => Promise<void>) {
		this.#app.setNotFoundHandler(cb)
	}

	protected async startServer(port: number) {
		await this.#app.ready()
		await this.#app.listen({ port, host: '0.0.0.0' })
		Instance.on('close', this.#app.close)
		return true
	}
}

function excludeBufferKeys<T>(body: T) {
	if (typeof body !== 'object') return { body, files: {} }
	const entries = Object.entries(body ?? {})
	const isFile = (val: any) => (Array.isArray(val) ? isFile(val.at(0)) : Buffer.isBuffer(val?.data))
	const fileEntries = entries
		.filter(([_, value]) => isFile(value))
		.map(([key, value]) => [key, Array.isArray(value) ? value : [value]])
	const nonFileEntries = entries.filter(([_, value]) => !isFile(value))
	return {
		body: <T>Object.fromEntries(nonFileEntries),
		files: <Record<string, IncomingFile[]>>Object.fromEntries(fileEntries),
	}
}

if (import.meta.vitest) {
	const { describe, expect, test, vi } = import.meta.vitest

	const testInstanceState = globalThis as typeof globalThis & { __equippedTestInstanceAliased?: boolean }

	function ensureTestInstance() {
		const instance =
			Instance.maybeGet() ?? Instance.create({ app: { name: 'equipped-test' }, log: { level: 'silent' } })
		if (!testInstanceState.__equippedTestInstanceAliased) {
			instance.alias('equipped-test')
			testInstanceState.__equippedTestInstanceAliased = true
		}
	}

	function createRawResponse() {
		return {
			statusCode: 200,
			headersSent: false,
			writableEnded: false,
			setHeader: vi.fn(),
			end(chunk?: unknown) {
				void chunk
				this.headersSent = true
				this.writableEnded = true
			},
		}
	}

	class TestFastifyServer extends FastifyServer {
		exposeRawResponder(req: FastifyRequest, res: FastifyReply) {
			return this.createRawResponder(req, res)
		}
	}

	describe('FastifyServer raw responder', () => {
		test('hijacks the Fastify reply before passing Node raw request and response to the handler', async () => {
			ensureTestInstance()
			const server = TestFastifyServer.create({ port: 0, requests: { log: false } })
			const rawRequest = { marker: 'request' }
			const rawResponse = createRawResponse()
			const reply = { raw: rawResponse, hijack: vi.fn() } as unknown as FastifyReply
			const request = { raw: rawRequest } as unknown as FastifyRequest
			let received: { request: unknown; response: unknown } | null = null

			await server.exposeRawResponder(
				request,
				reply,
			)(async (req, res) => {
				received = { request: req, response: res }
				res.end('ok')
			})

			expect(reply.hijack).toHaveBeenCalledOnce()
			expect(received).toEqual({ request: rawRequest, response: rawResponse })
		})
	})
}
