import http from 'http'

import cookie from 'cookie-parser'
import cors from 'cors'
import express from 'express'
import fileUpload from 'express-fileupload'
import { rateLimit } from 'express-rate-limit'
// import slowDown from 'express-slow-down'
import helmet from 'helmet'
import { pinoHttp } from 'pino-http'

import { Instance } from '../../../instance/index.js'
import { configurable, getMediaDuration } from '../../../utilities/index.js'
import type { Response } from '../../requests.js'
import { Request } from '../../requests.js'
import { StatusCodes, type IncomingFile, type MethodsEnum } from '../../types.js'
import { type RawResponder, Server, serverConfigPipe } from '../base.js'

export class ExpressServer extends configurable(serverConfigPipe, Server) {
	#app: express.Express
	#httpServer: http.Server

	protected constructor(config: typeof ExpressServer.Config) {
		super(config)
		const app = express()
		const instance = Instance.get()
		const httpServer = http.createServer(app)
		this.#app = app
		this.#httpServer = httpServer

		this.setup(httpServer, config)

		app.disable('x-powered-by')
		if (config.requests.log) app.use(pinoHttp({ logger: instance.log }))
		app.use(express.json())
		app.use(express.text())
		app.use(cookie())
		app.use(
			helmet({
				crossOriginResourcePolicy: { policy: 'cross-origin' },
				contentSecurityPolicy: false,
			}),
		)
		app.use(cors(this.cors))
		app.use(express.urlencoded({ extended: false }))
		if (config.publicPath) app.use(express.static(config.publicPath))
		app.use(
			fileUpload({
				limits: { fileSize: instance.settings.utils.maxFileUploadSizeInMb * 1024 * 1024 },
				useTempFiles: false,
			}),
		)
		if (config.requests.rateLimit.enabled)
			app.use(
				rateLimit({
					windowMs: config.requests.rateLimit.periodInMs,
					limit: config.requests.rateLimit.limit,
					handler: (_: express.Request, res: express.Response) =>
						res.status(StatusCodes.TooManyRequests).json([{ message: 'Too Many Requests' }]),
				}),
			)
		/* if (this.settings.slowdown.enabled) app.use(slowDown({
				windowMs: this.settings.slowdown.periodInMs,
				delayAfter: this.settings.slowdown.delayAfter,
				delayMs: this.settings.slowdown.delayInMs
			})) */
	}

	protected async parseRequest(req: any) {
		const files = Object.fromEntries(
			await Promise.all(
				Object.entries(req.files ?? {}).map(async ([key, file]) => {
					const uploads = Array.isArray(file) ? file : [file]
					const fileArray: IncomingFile[] = await Promise.all(
						uploads.map(async (f: any) => ({
							name: f.name,
							type: f.mimetype,
							size: f.size,
							isTruncated: f.truncated,
							data: f.data,
							duration: await getMediaDuration(f.data),
						})),
					)
					return <const>[key, fileArray]
				}),
			),
		)

		return new Request<any>({
			ip: req.ip,
			body: req.body ?? {},
			cookies: req.cookies ?? {},
			params: req.params ?? {},
			query: req.query ?? {},
			method: <any>req.method,
			path: req.path,
			headers: req.headers,
			files,
		})
	}

	protected async handleResponse(res: any, response: Response<any>) {
		if (!response.piped) {
			Object.entries(response.headers).forEach(([key, value]) => res.header(key, value as string))
			Object.entries(response.cookies).forEach(([key, { value, ...opts }]) => res.cookie(key, value, opts))
			if (response.status === StatusCodes.NoContent) {
				res.status(response.status).end()
				return
			}
			const type = response.body === null || response.body === undefined ? 'json' : 'send'
			res.status(response.status)[type](response.body).end()
		} else {
			response.body.pipe(res)
		}
	}

	protected createRawResponder(req: express.Request, res: express.Response): RawResponder {
		return this.createNodeRawResponder({ request: req, response: res })
	}

	protected registerRoute(method: MethodsEnum, path: string, cb: (req: any, res: any) => Promise<void>) {
		this.#app[method]?.(path, async (req: any, res: any) => cb(req, res))
	}

	protected registerErrorHandler(cb: (error: Error, req: any, res: any) => Promise<void>) {
		this.#app.use(async (err: any, req: any, res: any, _next: any) => cb(err, req, res))
	}

	protected registerNotFoundHandler(cb: (req: any, res: any) => Promise<void>) {
		this.#app.use(async (req: any, res: any, _next: any) => cb(req, res))
	}

	protected startServer(port: number) {
		return new Promise<boolean>((resolve: (s: boolean) => void, reject: (e: Error) => void) => {
			try {
				const server = this.#httpServer.listen({ host: '0.0.0.0', port }, async () => resolve(true))
				Instance.on('close', server.close)
			} catch (err) {
				reject(<Error>err)
			}
		})
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

	function createExpressResponse() {
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

	class TestExpressServer extends ExpressServer {
		exposeRawResponder(req: express.Request, res: express.Response) {
			return this.createRawResponder(req, res)
		}
	}

	describe('ExpressServer raw responder', () => {
		test('passes the Express request and response to the raw Node handler', async () => {
			ensureTestInstance()
			const server = TestExpressServer.create({ port: 0, requests: { log: false } })
			const req = { marker: 'request' } as unknown as express.Request
			const res = createExpressResponse() as unknown as express.Response
			let received: { request: unknown; response: unknown } | null = null

			await server.exposeRawResponder(
				req,
				res,
			)(async (request, response) => {
				received = { request, response }
				response.end('ok')
			})

			expect(received).toEqual({ request: req, response: res })
		})
	})
}
