import { v } from 'valleyed'

import {
	Methods,
	StatusCodes,
	type AddRouteToContract,
	type DefaultCookies,
	type DefaultHeaders,
	type DefaultParams,
	type DefaultQuery,
	type AddRouteToPublicContract,
	type JoinPath,
	type MergeRouteContracts,
	type MergeRouteDefs,
	type MethodsEnum,
	type PrefixRouteContract,
	type RejectDuplicateRoute,
	type RejectDuplicateRoutes,
	type Route,
	type RouteConfig,
	type RouteContractHost,
	type RouteContractOf,
	type RouteDef,
	type RouteInput,
	type RouteOutput,
	type RouteDefHandler,
	type RouteDefToContractEntry,
	type RouteRegistryOf,
	type RouterConfig,
	type routeContractSymbol,
	type routeRegistrySymbol,
} from './types'

const cleanPath = (path: string) => {
	let cleaned = path.replace(/(\/\s*)+/g, '/')
	if (!cleaned.startsWith('/')) cleaned = `/${cleaned}`
	if (cleaned !== '/' && cleaned.endsWith('/')) cleaned = cleaned.slice(0, -1)
	return cleaned
}

function mergeSchemas(...schemas: RouteDef[]) {
	type Keys = Record<keyof RouteDef, string>
	const k: Keys = {
		params: '',
		headers: '',
		query: '',
		body: '',
		cookies: '',
		response: '',
		responseHeaders: '',
		responseCookies: '',
		defaultStatusCode: '',
		defaultContentType: '',
	}
	function merge<T extends RouteDef[keyof Keys]>(acc: T | null, cur: T) {
		if (!acc) return cur
		if (!cur) return acc
		if (typeof acc === 'number') return cur
		if (typeof acc === 'string') return cur
		if (typeof acc === 'function') return cur
		return v.merge(acc, cur as any)
	}
	return Object.fromEntries(
		Object.keys(k).map((key) => [
			key,
			schemas.map((s) => s[key] as RouteDef[keyof Keys]).reduce<RouteDef[keyof Keys] | null>(merge, null),
		]),
	) as RouteDef
}

type RouteConfigInput<Schema extends RouteDef, Hide extends boolean | undefined> = Omit<RouteConfig<Schema>, 'schema' | 'hide'> & {
	schema?: Schema
	hide?: Hide
}

type OverrideHide<ParentHide, Hide> = [Hide] extends [undefined] ? ParentHide : Hide

const groupRoutes = <T extends RouteDef, R extends RouteDef>(config: RouterConfig<T>, routes: Route<R>[]) =>
	routes.map((route) => ({
		...config,
		...route,
		path: cleanPath(`${config.path}/${route.path}`),
		groups: [...(config.groups ?? []), ...(route.groups ?? [])],
		middlewares: [...(config.middlewares ?? []), ...(route.middlewares ?? [])],
		responseMiddlewares: [...(config.responseMiddlewares ?? []), ...(route.responseMiddlewares ?? [])],
		schema: mergeSchemas(config.schema ?? {}, route.schema ?? {}),
		security: [...(config.security ?? []), ...(route.security ?? [])],
	})) as Route<MergeRouteDefs<T, R>>[]

export class Router<
	T extends RouteDef = {},
	Path extends string = '',
	PublicContract = {},
	Registry = PublicContract,
	Hide = undefined,
> implements RouteContractHost<PublicContract, Registry>
{
	declare readonly [routeContractSymbol]?: PublicContract
	declare readonly [routeRegistrySymbol]?: Registry

	#config: RouterConfig<T, Path> & { hide?: Hide } = { path: '' as Path }
	#routes: Route<any>[] = []
	#children: Router<any, any, any, any, any>[] = []

	constructor(config: (RouterConfig<T, Path> & { hide?: Hide }) = { path: '' as Path }) {
		this.#config = config
	}

	#wrap<const Method extends MethodsEnum>(method: Method) {
		return <const RoutePath extends string, const Schema extends RouteDef = {}, const RouteHide extends boolean | undefined = undefined>(
			path: RoutePath & RejectDuplicateRoute<Registry, Method, JoinPath<Path, RoutePath>>,
			config: RouteConfigInput<Schema, RouteHide> = {} as RouteConfigInput<Schema, RouteHide>,
		) =>
			(handler: RouteDefHandler<MergeRouteDefs<T, Schema>>) => {
				type EffectiveDef = MergeRouteDefs<T, Schema>
				type FullPath = JoinPath<Path, RoutePath>
				type Entry = RouteDefToContractEntry<Method, EffectiveDef>
				type EffectivePublic = AddRouteToPublicContract<PublicContract, Method, FullPath, Entry, OverrideHide<Hide, RouteHide>>
				type EffectiveRegistry = AddRouteToContract<Registry, Method, FullPath, Entry>
				const route = groupRoutes(this.#config, [{ ...config, path, method, handler: handler as any }])[0]
				this.#routes.push(route)
				return this as unknown as Router<T, Path, EffectivePublic, EffectiveRegistry, Hide>
			}
	}

	head = this.#wrap(Methods.head)
	get = this.#wrap(Methods.get)
	post = this.#wrap(Methods.post)
	put = this.#wrap(Methods.put)
	patch = this.#wrap(Methods.patch)
	delete = this.#wrap(Methods.delete)
	options = this.#wrap(Methods.options)

	nest<Child extends Router<any, any, any, any, any>>(
		router: Child & RejectDuplicateRoutes<Registry, PrefixRouteContract<RouteRegistryOf<Child>, Path>>,
	) {
		type ChildPublic = PrefixRouteContract<RouteContractOf<Child>, Path>
		type ChildRegistry = PrefixRouteContract<RouteRegistryOf<Child>, Path>
		this.#children.push(router)
		return this as unknown as Router<T, Path, MergeRouteContracts<PublicContract, ChildPublic>, MergeRouteContracts<Registry, ChildRegistry>, Hide>
	}

	get routes() {
		return [...this.#routes].concat(this.#children.flatMap((child) => groupRoutes(this.#config, child.routes)))
	}
}

if (import.meta.vitest) {
	const { describe, expect, expectTypeOf, test } = import.meta.vitest

	describe('Router', () => {
		test('route methods return the same router and register routes', () => {
			const router = new Router()
			const returned = router.get('/ping')(() => 'ok')

			expect(returned).toBe(router)
			expect(router.routes.map((route) => route.path)).toEqual(['/ping'])
		})

		test('nest returns the same router and prefixes child routes at runtime', () => {
			const users = new Router({ path: '/users' }).get('/:id')(() => ({ id: 'u1' }))
			const api = new Router({ path: '/api' })
			const returned = api.nest(users)

			expect(returned).toBe(api)
			expect(api.routes.map((route) => route.path)).toEqual(['/api/users/:id'])
		})

		test('route contracts accumulate chained public route IO types', () => {
			const _api = new Router({ path: '/api' })
				.get('/users/:id', {
					schema: {
						params: v.object({ id: v.string() }),
						response: v.object({ id: v.string() }),
					},
				})((req) => ({ id: req.params.id }))
				.post('/users', {
					schema: {
						body: v.object({ name: v.string() }),
						response: v.object({ id: v.string() }),
					},
				})((req) => ({ id: req.body.name }))

			type Contract = RouteContractOf<typeof _api>
			type GetUserInput = RouteInput<Contract, 'get', '/api/users/:id'>
			type CreateUserInput = RouteInput<Contract, 'post', '/api/users'>
			type CreateUserOutput = RouteOutput<Contract, 'post', '/api/users'>

			expectTypeOf<GetUserInput>().toEqualTypeOf<{
				params: { id: string }
				query: DefaultQuery
				headers: DefaultHeaders
				cookies: DefaultCookies
			}>()
			expectTypeOf<CreateUserInput>().toEqualTypeOf<{
				params: DefaultParams
				query: DefaultQuery
				headers: DefaultHeaders
				cookies: DefaultCookies
				body: { name: string }
			}>()
			expectTypeOf<CreateUserOutput>().toEqualTypeOf<{
				body: { id: string }
				headers: DefaultHeaders
				cookies: DefaultCookies
				statusCode: 200
				contentType: 'application/json'
			}>()
		})

		test('custom status-code route contracts preserve literal status and content type defaults', () => {
			const _api = new Router({ path: '/api' }).post('/created', {
				schema: {
					defaultStatusCode: 299,
					defaultContentType: 'text/plain',
					response: v.string(),
				},
			})((req) => req.res({ body: 'created' }))

			type Contract = RouteContractOf<typeof _api>
			type Output = RouteOutput<Contract, 'post', '/api/created'>

			expectTypeOf<Output['body']>().toEqualTypeOf<string>()
			expectTypeOf<Output['statusCode']>().toEqualTypeOf<299>()
			expectTypeOf<Output['contentType']>().toEqualTypeOf<'text/plain'>()
		})

		test('204 no-content route contracts have an undefined output body', () => {
			const _api = new Router({ path: '/api' }).delete('/users/:id', {
				schema: {
					params: v.object({ id: v.string() }),
					defaultStatusCode: StatusCodes.NoContent,
				},
			})((req) => req.res({ body: undefined, status: StatusCodes.NoContent }))

			type Contract = RouteContractOf<typeof _api>

			expectTypeOf<RouteOutput<Contract, 'delete', '/api/users/:id'>['body']>().toEqualTypeOf<undefined>()

			new Router().delete('/without-body-property', { schema: { defaultStatusCode: StatusCodes.NoContent } })((req) =>
				req.res({ status: StatusCodes.NoContent }),
			)

			new Router().delete('/bad', { schema: { defaultStatusCode: StatusCodes.NoContent } })(
				// @ts-expect-error 204 handlers must not return a response body
				(req) => req.res({ body: 'not allowed', status: StatusCodes.NoContent }),
			)
		})

		test('nested router contracts are prefixed by the parent router path', () => {
			const users = new Router({ path: '/users' }).get('/:id', {
				schema: {
					params: v.object({ id: v.string() }),
					response: v.object({ id: v.string() }),
				},
			})((req) => ({ id: req.params.id }))
			const _api = new Router({ path: '/api' }).nest(users)

			type Contract = RouteContractOf<typeof _api>

			expectTypeOf<RouteOutput<Contract, 'get', '/api/users/:id'>['body']>().toEqualTypeOf<{ id: string }>()
		})

		test('hidden routes are omitted from public route contracts', () => {
			const _routeHidden = new Router().get('/internal', { hide: true })(() => null)
			const _routerHidden = new Router({ path: '/internal', hide: true }).get('/status')(() => null)

			expectTypeOf<RouteContractOf<typeof _routeHidden>>().toEqualTypeOf<{}>()
			expectTypeOf<RouteContractOf<typeof _routerHidden>>().toEqualTypeOf<{}>()
		})

		test('literal duplicate route identities are type errors', () => {
			const router = new Router().get('/dupe')(() => null)

			// @ts-expect-error duplicate route identity: get /dupe
			router.get('/dupe')(() => null)
		})
	})
}
