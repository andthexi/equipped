import type { IncomingHttpHeaders } from 'node:http2'
import type { Readable } from 'node:stream'

import type { SerializeOptions } from '@fastify/cookie'
import type { DistributiveOmit, IsInTypeList } from 'valleyed'

import type { RequestError } from '../errors/index.js'
import type { AuthUser } from '../types/index.js'
import {
	StatusCodes,
	type DefaultCookies,
	type DefaultHeaders,
	type IncomingFile,
	type MethodsEnum,
	type RouteReqRes,
} from './types.js'

type ResponseCookies<C> = C extends DefaultCookies ? C : DefaultCookies

export type CookieVal<C> = {
	[K in keyof ResponseCookies<C>]: SerializeOptions & { value: ResponseCookies<C>[K] }
}

export class Request<Def extends RouteReqRes> {
	readonly ip: string | undefined
	readonly method: MethodsEnum
	readonly path: string
	#responseDefaults: { contentType?: Def['contentType']; status?: Def['statusCode'] } = {}
	body: Def['body']
	params: Def['params']
	query: Def['query']
	headers: IncomingHttpHeaders & Def['requestHeaders']
	cookies: Record<string, string | undefined> & Def['requestCookies']
	authUser: AuthUser | null = null

	constructor({
		ip,
		body,
		cookies,
		params,
		query,
		method,
		path,
		headers,
		files,
	}: {
		ip: string | undefined
		body: Def['body']
		params: Def['params']
		query: Def['query']
		cookies: Record<string, string | undefined> & Def['requestCookies']
		headers: IncomingHttpHeaders
		files: Record<string, IncomingFile[]>
		method: MethodsEnum
		path: string
	}) {
		this.ip = ip
		this.method = method
		this.path = path
		this.params = params
		this.cookies = cookies
		this.headers = headers
		const hasFiles = Object.keys(files).length > 0
		const bodyFields = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
		this.query = query
		this.body = <any>(hasFiles ? Object.assign({}, bodyFields, files) : body)
	}

	setResponseDefaults(defaults: { contentType: Def['contentType']; status: Def['statusCode'] }) {
		this.#responseDefaults = defaults
		return this
	}

	pipe(
		stream: Readable,
		opts: { headers?: Def['responseHeaders']; cookies?: Def['responseCookies']; status?: Def['statusCode'] } = {},
	) {
		return new Response<Omit<Def, 'response'> & { response: Readable }>(<any>{
			status: this.#responseDefaults.status,
			...opts,
			piped: true,
			body: stream,
		})
	}

	res(params: DistributiveOmit<RequestParams<Def>, 'piped'>) {
		return new Response<Def>(<any>{
			status: this.#responseDefaults.status,
			contentType: this.#responseDefaults.contentType,
			...params,
			piped: false,
		})
	}

	error<
		T extends Omit<Def, 'response' | 'statusCode' | 'responseHeaders' | 'responseCookies' | 'contentType'> & {
			response: RequestError['serializedErrors']
			statusCode: RequestError['statusCode']
			responseHeaders: DefaultHeaders
			responseCookies: DefaultCookies
			contentType: 'application/json'
		},
	>(params: DistributiveOmit<RequestParams<T>, 'piped'>) {
		return new Response<T>(<any>{ ...params, piped: false })
	}
}

type BodyParam<T> = [T] extends [undefined] ? { body?: T; piped?: boolean } : { body: T; piped?: boolean }

type RequestParams<Def extends RouteReqRes, T = Def['response']> = BodyParam<T> & {
	contentType?: Def['contentType']
	status?: Def['statusCode']
} & (IsInTypeList<Def['responseHeaders'], [DefaultHeaders]> extends true
		? { headers?: Def['responseHeaders'] }
		: { headers: Def['responseHeaders'] }) &
	(IsInTypeList<Def['responseCookies'], [DefaultCookies]> extends true
		? { cookies?: CookieVal<Def['responseCookies']> }
		: { cookies: CookieVal<Def['responseCookies']> })

export class Response<Def extends RouteReqRes> {
	body: Def['response'] | undefined
	headers: Def['responseHeaders']
	cookies: CookieVal<Def['responseCookies']>
	readonly status: Def['statusCode']
	readonly contentType: Def['contentType']
	readonly piped: boolean

	constructor({
		body,
		status = <any>200,
		headers = <any>{},
		cookies = <any>{},
		piped = false,
		contentType = <any>'application/json',
	}: RequestParams<Def>) {
		this.body = body
		this.status = status
		this.contentType = contentType
		this.headers = headers
		this.cookies = cookies
		this.piped = piped

		if (!this.piped && this.status !== StatusCodes.NoContent) {
			;(this.headers as DefaultHeaders)['Content-Type'] = contentType as string
		}
	}

	get cookieValues() {
		return Object.fromEntries(Object.entries(this.cookies).map(([key, val]) => [key, val] as const))
	}

	set cookieValues(values: DefaultCookies) {
		Object.entries(values).forEach(([key, val]) => {
			// @ts-expect-error indexing on generic
			if (this.cookies[key]) this.cookies[key].value = val
		})
	}
}

if (import.meta.vitest) {
	const { describe, expect, test } = import.meta.vitest

	describe('Response', () => {
		test('does not set content-type for 204 no-content responses', () => {
			const response = new Response<any>({
				body: undefined,
				status: StatusCodes.NoContent,
				contentType: 'application/json',
				headers: {},
				cookies: {},
			})

			expect(response.status).toBe(StatusCodes.NoContent)
			expect(response.body).toBeUndefined()
			expect(response.headers).not.toHaveProperty('Content-Type')
		})

		test('keeps default content-type for normal JSON responses', () => {
			const response = new Response<any>({
				body: { ok: true },
				status: StatusCodes.Ok,
				contentType: 'application/json',
				headers: {},
				cookies: {},
			})

			expect(response.status).toBe(StatusCodes.Ok)
			expect(response.headers).toHaveProperty('Content-Type', 'application/json')
		})

		test('uses request response defaults for res and pipe when values are omitted', () => {
			const request = new Request<any>({
				ip: undefined,
				body: {},
				cookies: {},
				params: {},
				query: {},
				method: 'post',
				path: '/created',
				headers: {},
				files: {},
			}).setResponseDefaults({ status: 299, contentType: 'text/plain' })

			const response = request.res({ body: 'created', headers: {}, cookies: {} })
			const piped = request.pipe({} as Readable)

			expect(response.status).toBe(299)
			expect(response.contentType).toBe('text/plain')
			expect(piped.status).toBe(299)
			expect(piped.contentType).toBe('application/json')
		})
	})

	describe('Request', () => {
		test('preserves adapter-provided query and body values without JSON normalization', () => {
			const query = {
				count: '10',
				active: 'true',
				filter: '{"name":"test"}',
				quoted: '"value"',
			}
			const body = {
				count: '10',
				active: 'false',
				payload: '{"nested":true}',
				quoted: '"value"',
			}

			const request = new Request<any>({
				ip: undefined,
				body,
				cookies: {},
				params: {},
				query,
				method: 'post',
				path: '/items',
				headers: {},
				files: {},
			})

			expect(request.query).toEqual(query)
			expect(request.body).toEqual(body)
		})

		test('continues merging uploaded files into body fields without parsing string fields', () => {
			const file: IncomingFile = {
				name: 'avatar.png',
				type: 'image/png',
				size: 4,
				isTruncated: false,
				data: Buffer.from('file'),
				duration: 0,
			}
			const body = { metadata: '{"alt":"avatar"}' }

			const request = new Request<any>({
				ip: undefined,
				body,
				cookies: {},
				params: {},
				query: {},
				method: 'post',
				path: '/upload',
				headers: {},
				files: { avatar: [file] },
			})

			expect(request.body).toEqual({ metadata: '{"alt":"avatar"}', avatar: [file] })
		})

		test('does not spread non-object body values when uploaded files are present', () => {
			const file: IncomingFile = {
				name: 'avatar.png',
				type: 'image/png',
				size: 4,
				isTruncated: false,
				data: Buffer.from('file'),
				duration: 0,
			}

			const request = new Request<any>({
				ip: undefined,
				body: 'raw text body',
				cookies: {},
				params: {},
				query: {},
				method: 'post',
				path: '/upload',
				headers: {},
				files: { avatar: [file] },
			})

			expect(request.body).toEqual({ avatar: [file] })
		})
	})
}
