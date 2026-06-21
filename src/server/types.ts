import type { IsInTypeList, Pipe, PipeInput, PipeOutput, Prettify } from 'valleyed'

import type { RequestError } from '../errors'
import type { Enum } from '../types'
import type { Request, Response } from './requests'

export const Methods = {
	head: 'head',
	get: 'get',
	post: 'post',
	put: 'put',
	patch: 'patch',
	delete: 'delete',
	options: 'options',
} as const

export const StatusCodes = {
	Ok: 200,
	NoContent: 204,
	Found: 302,
	BadRequest: 400,
	NotAuthenticated: 401,
	NotAuthorized: 403,
	NotFound: 404,
	ValidationError: 422,
	PreconditionRequired: 428,
	TooManyRequests: 429,
	TokenExpired: 461,
} satisfies Record<string, StatusCode>

export type MethodsEnum = Enum<typeof Methods>

type Enumerate<N extends number, Acc extends number[] = []> = Acc['length'] extends N ? Acc[number] : Enumerate<N, [...Acc, Acc['length']]>
type IntRange<From extends number, To extends number> = Exclude<Enumerate<To>, Enumerate<From>>

export type StatusCode = IntRange<100, 600>

export type ArrayOrValue<T> = T | T[] | undefined
export type DefaultBody = unknown
export type DefaultParams = Record<string, ArrayOrValue<string>>
export type DefaultQuery = Record<string, ArrayOrValue<unknown>>
export type DefaultHeaders = Record<string, ArrayOrValue<string>>
export type DefaultCookies = Record<string, string | undefined>

export type IncomingFile = {
	name: string
	type: string
	size: number
	isTruncated: boolean
	data: Buffer
	duration: number
}

type DefaultRouteDef = {
	params: Pipe<DefaultParams, DefaultParams>
	query: Pipe<DefaultQuery, DefaultQuery>
	headers: Pipe<DefaultHeaders, DefaultHeaders>
	cookies: Pipe<DefaultCookies, DefaultCookies>
	body: Pipe<DefaultBody, DefaultBody>
	response: Pipe<unknown, unknown>
	responseHeaders: Pipe<DefaultHeaders, DefaultHeaders>
	responseCookies: Pipe<DefaultCookies, DefaultCookies>
	defaultStatusCode: typeof StatusCodes.Ok
	defaultContentType: 'application/json'
}

export type RouteDef = {
	params?: Pipe<any, any>
	query?: Pipe<any, any>
	headers?: Pipe<any, any>
	cookies?: Pipe<any, any>
	body?: Pipe<any, any>
	response?: Pipe<any, any>
	responseHeaders?: Pipe<any, any>
	responseCookies?: Pipe<any, any>
	defaultStatusCode?: StatusCode
	defaultContentType?: string
}

type RouteGroup = { name: string; description?: string }
type HandlerSetup<T extends RouteDef> = (route: Route<T>) => void

export type RouteConfig<T extends RouteDef = {}> = {
	middlewares?: ReturnType<typeof makeMiddleware<RouteDef>>[]
	responseMiddlewares?: ReturnType<typeof makeResponseMiddleware<RouteDef>>[]
	onError?: ReturnType<typeof makeErrorMiddleware<RouteDef>>
	groups?: (RouteGroup | RouteGroup['name'])[]
	title?: string
	descriptions?: string[]
	security?: Record<string, string[]>[]
	schema?: T
	hide?: boolean
}

export type RouterConfig<T extends RouteDef = {}, Path extends string = string> = RouteConfig<T> & { path: Path }
export type Route<T extends RouteDef> = RouteConfig<T> & {
	path: string
	method: MethodsEnum
	handler: RouteDefHandler<T>
}

type RouteDefValue<T, K extends keyof RouteDef> = T extends RouteDef ? T[K] : K extends keyof T ? T[K] : unknown
type GetApiPart<T, K extends keyof RouteDef> = NonNullable<
	[RouteDefValue<T, K>] extends [undefined]
		? DefaultRouteDef[K]
		: IsInTypeList<RouteDefValue<T, K>, [unknown]> extends true
			? DefaultRouteDef[K]
			: RouteDefValue<T, K>
>

type Defined<T> = Exclude<T, undefined>
type ArePipes<A, B> = Defined<A> extends Pipe<any, any> ? (Defined<B> extends Pipe<any, any> ? true : false) : false
type Compare<K extends keyof RouteDef, A, B> = [Defined<B>] extends [never]
	? A
	: [Defined<A>] extends [never]
		? B
		: K extends `default${string}` | 'context'
			? B
			: ArePipes<A, B> extends true
				? Pipe<PipeInput<Defined<A>> & PipeInput<Defined<B>>, PipeOutput<Defined<A>> & PipeOutput<Defined<B>>>
				: B

export type MergeRouteDefs<A extends RouteDef, B extends RouteDef> = {
	[K in keyof RouteDef]: Compare<K, A[K], B[K]>
}

export type RouteReqRes = {
	body: unknown
	params: unknown
	requestHeaders: unknown
	requestCookies: unknown
	query: unknown
	response: unknown
	responseHeaders: unknown
	responseCookies: unknown
	statusCode: unknown
	contentType: unknown
}

type DefaultIfUnknown<T, Default> = unknown extends T ? Default : T

type PipeInputOrDefault<T, K extends keyof RouteDef, Default> = DefaultIfUnknown<PipeInput<GetApiPart<T, K>>, Default>
type PipeOutputOrDefault<T, K extends keyof RouteDef, Default> = DefaultIfUnknown<PipeOutput<GetApiPart<T, K>>, Default>
type StatusCodeOf<T> = DefaultIfUnknown<GetApiPart<T, 'defaultStatusCode'>, typeof StatusCodes.Ok>
type ContentTypeOf<T> = DefaultIfUnknown<GetApiPart<T, 'defaultContentType'>, 'application/json'>
type ResponseBodyOf<T> = StatusCodeOf<T> extends typeof StatusCodes.NoContent ? undefined : PipeOutput<GetApiPart<T, 'response'>>

export type RouteDefToReqRes<T> = Prettify<{
	body: PipeOutput<GetApiPart<T, 'body'>>
	params: PipeOutputOrDefault<T, 'params', DefaultParams>
	requestHeaders: PipeOutputOrDefault<T, 'headers', DefaultHeaders>
	requestCookies: PipeOutputOrDefault<T, 'cookies', DefaultCookies>
	query: PipeOutputOrDefault<T, 'query', DefaultQuery>
	response: ResponseBodyOf<T>
	responseHeaders: PipeOutputOrDefault<T, 'responseHeaders', DefaultHeaders>
	responseCookies: PipeOutputOrDefault<T, 'responseCookies', DefaultCookies>
	statusCode: StatusCodeOf<T>
	contentType: ContentTypeOf<T>
}>

type BodyMethods = typeof Methods.post | typeof Methods.put | typeof Methods.patch
export type RouteContractEntry<Input, Output> = { input: Input; output: Output }
export type RouteContract = Partial<Record<MethodsEnum, Record<string, RouteContractEntry<any, any>>>>
export declare const routeContractSymbol: unique symbol
export declare const routeRegistrySymbol: unique symbol

export type RouteContractHost<Public, Registry = Public> = {
	readonly [routeContractSymbol]?: Public
	readonly [routeRegistrySymbol]?: Registry
}

export type RouteContractOf<T> = T extends RouteContractHost<infer Public, any> ? Public : {}
export type RouteRegistryOf<T> = T extends RouteContractHost<any, infer Registry> ? Registry : {}
export type RouteInput<C, M extends keyof C, P extends keyof C[M]> = C[M][P] extends { input: infer I } ? I : never
export type RouteOutput<C, M extends keyof C, P extends keyof C[M]> = C[M][P] extends { output: infer O } ? O : never

export type RouteDefToContractEntry<M extends MethodsEnum, T> = RouteContractEntry<
	Prettify<
		{
			params: PipeInputOrDefault<T, 'params', DefaultParams>
			query: PipeInputOrDefault<T, 'query', DefaultQuery>
			headers: PipeInputOrDefault<T, 'headers', DefaultHeaders>
			cookies: PipeInputOrDefault<T, 'cookies', DefaultCookies>
		} & (M extends BodyMethods ? { body: PipeInput<GetApiPart<T, 'body'>> } : {})
	>,
	Prettify<{
		body: ResponseBodyOf<T>
		headers: PipeOutputOrDefault<T, 'responseHeaders', DefaultHeaders>
		cookies: PipeOutputOrDefault<T, 'responseCookies', DefaultCookies>
		statusCode: StatusCodeOf<T>
		contentType: ContentTypeOf<T>
	}>
>

type CollapseSlashes<S extends string> = S extends `${infer Head}//${infer Tail}` ? CollapseSlashes<`${Head}/${Tail}`> : S
type EnsureLeadingSlash<S extends string> = S extends `/${string}` ? S : `/${S}`
type RemoveTrailingSlash<S extends string> = S extends '/' ? S : S extends `${infer Rest}/` ? RemoveTrailingSlash<Rest> : S
export type CleanPath<S extends string> = string extends S ? string : RemoveTrailingSlash<CollapseSlashes<EnsureLeadingSlash<S>>>
export type JoinPath<A extends string, B extends string> = CleanPath<`${A}/${B}`>

type MethodRecord<C, M extends MethodsEnum> = M extends keyof C ? (C[M] extends Record<string, any> ? C[M] : {}) : {}
type SetMethodRecord<C, M extends MethodsEnum, R> = Prettify<Omit<C, M> & { [K in M]: R }>
export type AddRouteToContract<C, M extends MethodsEnum, Path extends string, Entry> = string extends Path
	? C
	: SetMethodRecord<C, M, Prettify<MethodRecord<C, M> & { [P in Path]: Entry }>>

export type MergeRouteContracts<A, B> = Prettify<{
	[M in keyof A | keyof B]: M extends keyof A
		? M extends keyof B
			? Prettify<A[M] & B[M]>
			: A[M]
		: M extends keyof B
			? B[M]
			: never
}>

export type PrefixRouteContract<C, Prefix extends string> = string extends Prefix
	? {}
	: Prettify<{
			[M in keyof C]: C[M] extends Record<string, any>
				? { [P in keyof C[M] & string as JoinPath<Prefix, P>]: C[M][P] }
				: C[M]
		}>

type DuplicateInMethod<A, B, M extends keyof A & keyof B> = A[M] extends Record<string, any>
	? B[M] extends Record<string, any>
		? Extract<keyof A[M], keyof B[M]> extends infer Path
			? Path extends string
				? DuplicateRouteIdentity<Extract<M, string>, Path>
				: never
			: never
		: never
	: never
export type DuplicateRouteIdentity<Method extends string, Path extends string> = {
	readonly __duplicateRouteIdentity__: `${Method} ${Path}`
}
export type DuplicateRouteIdentities<A, B> = {
	[M in keyof A & keyof B]: DuplicateInMethod<A, B, M>
}[keyof A & keyof B]
export type RejectDuplicateRoutes<A, B> = [DuplicateRouteIdentities<A, B>] extends [never] ? unknown : DuplicateRouteIdentities<A, B>
export type RejectDuplicateRoute<C, M extends MethodsEnum, Path extends string> = string extends Path
	? unknown
	: M extends keyof C
		? Path extends keyof MethodRecord<C, M>
			? DuplicateRouteIdentity<M, Path>
			: unknown
		: unknown

export type RouteDefOfConfig<Cfg> = 'schema' extends keyof Cfg
	? Cfg extends { schema?: infer S }
		? Extract<NonNullable<S>, RouteDef>
		: {}
	: {}
export type EffectiveHide<ParentHide, Cfg> = 'hide' extends keyof Cfg ? (Cfg extends { hide?: infer Hide } ? Hide : ParentHide) : ParentHide
export type AddRouteToPublicContract<C, M extends MethodsEnum, Path extends string, Entry, Hide> = Hide extends true
	? C
	: AddRouteToContract<C, M, Path, Entry>

type Awaitable<T> = Promise<T> | T
type Res<T extends RouteReqRes> = Awaitable<
	IsInTypeList<T['statusCode'], [StatusCode, 200]> extends true
		? IsInTypeList<T['responseHeaders'], [DefaultHeaders]> extends true
			? IsInTypeList<T['responseCookies'], [DefaultCookies]> extends true
				? Response<T> | T['response']
				: Response<T>
			: Response<T>
		: Response<T>
>
export type RouteDefHandler<Def> = (req: Request<RouteDefToReqRes<Def>>) => Res<RouteDefToReqRes<Def>>
type RouteMiddlewareHandler<_Def extends RouteDef> = (req: Request<RouteDefToReqRes<RouteDef>>) => Awaitable<void>
type RouteResponseMiddlewareHandler<_Def extends RouteDef> = (
	req: Request<RouteDefToReqRes<RouteDef>>,
	res: Response<RouteDefToReqRes<RouteDef>>,
) => Awaitable<void>
type ErrorHandler<Def extends RouteDef> = (
	req: Request<RouteDefToReqRes<Def>>,
	err: Error,
) => Res<
	Omit<RouteDefToReqRes<Def>, 'response' | 'statusCode' | 'responseHeaders' | 'responseCookies' | 'contentType'> & {
		response: RequestError['serializedErrors']
		statusCode: RequestError['statusCode']
		responseHeaders: DefaultHeaders
		responseCookies: DefaultCookies
		contentType: 'application/json'
	}
>

function makeMiddlewareHandler<Cb extends Function, T extends RouteDef>(cb: Cb, onSetup?: HandlerSetup<T>) {
	return { cb, onSetup }
}

export const makeMiddleware = <Def extends RouteDef>(...args: Parameters<typeof makeMiddlewareHandler<RouteMiddlewareHandler<Def>, Def>>) =>
	makeMiddlewareHandler(...args)
export const makeResponseMiddleware = <Def extends RouteDef>(
	...args: Parameters<typeof makeMiddlewareHandler<RouteResponseMiddlewareHandler<Def>, Def>>
) => makeMiddlewareHandler(...args)
export const makeErrorMiddleware = <Def extends RouteDef>(...args: Parameters<typeof makeMiddlewareHandler<ErrorHandler<Def>, Def>>) =>
	makeMiddlewareHandler(...args)

if (import.meta.vitest) {
	const { describe, expectTypeOf, test } = import.meta.vitest

	describe('StatusCode', () => {
		test('accepts integer HTTP status-code literals in the 100-599 range', () => {
			expectTypeOf<100>().toExtend<StatusCode>()
			expectTypeOf<200>().toExtend<StatusCode>()
			expectTypeOf<599>().toExtend<StatusCode>()
		})

		test('rejects literals outside the HTTP status-code range', () => {
			// @ts-expect-error 99 is below the HTTP status-code range
			const below: StatusCode = 99
			// @ts-expect-error 600 is above the HTTP status-code range
			const above: StatusCode = 600
			// @ts-expect-error fractional numbers are not HTTP status-code integers
			const decimal: StatusCode = 200.5
			void [below, above, decimal]
		})
	})
}
