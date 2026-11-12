import { Cluster, Redis, type RedisOptions } from 'ioredis'
import { v } from 'valleyed'

import { EquippedError } from '../../../errors/index.js'
import { Instance } from '../../../instance/index.js'
import { configurable } from '../../../utilities/index.js'
import { Cache } from '../base.js'

export const redisConfigPipe = () =>
	v.meta(
		v.object({
			host: v.string(),
			port: v.optional(v.number()),
			password: v.optional(v.string()),
			username: v.optional(v.string()),
			tls: v.optional(v.boolean()),
			cluster: v.optional(v.boolean()),
		}),
		{ title: 'Redis Config', $refId: 'RedisConfig' },
	)

export class RedisCache extends configurable(redisConfigPipe, Cache) {
	#client: Cluster | Redis

	protected constructor(config: typeof RedisCache.Config, extraConfig?: Partial<RedisOptions>) {
		super(config)
		const node = {
			...(config.host ? { host: config.host } : {}),
			...(config.port ? { port: config.port } : {}),
		}
		const common = {
			...extraConfig,
			...(config.password ? { password: config.password } : {}),
			...(config.username ? { username: config.username } : {}),
			...(config.tls ? { tls: {} } : {}),
			lazyConnect: true,
		}
		this.#client = config.cluster
			? new Cluster([node], {
					...extraConfig,
					redisOptions: common,
					lazyConnect: true,
				})
			: new Redis({ ...common, ...node })
		this.#client.on('error', async (error) => {
			Instance.crash(new EquippedError(`Redis failed with error`, {}, error))
		})
		if (!extraConfig) Instance.on('start', async () => this.#client.connect(), { class: RedisCache })
		Instance.on('close', async () => this.#client.quit(), { class: RedisCache })
	}

	get connectionOptions() {
		return this.#client.options
	}

	async delete(key: string) {
		await this.#client.del(this.getScopedKey(key))
	}
	async get(key: string) {
		return await this.#client.get(this.getScopedKey(key))
	}
	async set(key: string, data: string, ttlInSecs?: number) {
		if (ttlInSecs) await this.#client.setex(this.getScopedKey(key), ttlInSecs, data)
		else this.#client.set(this.getScopedKey(key), data)
	}
}

if (import.meta.vitest) {
	const { describe, test, expect, expectTypeOf, vi, beforeEach, afterEach } = import.meta.vitest
	type PipeOutput<T> = import('valleyed').PipeOutput<T>

	let hookCalls: Array<{ event: string; options?: any }>

	beforeEach(() => {
		hookCalls = []
		vi.spyOn(Instance, 'on').mockImplementation((event, _cb, options) => {
			hookCalls.push({ event, options })
		})
		vi.spyOn(Instance, 'get').mockReturnValue({
			getScopedName: (_name: string, _sep: string) => `test:${_name}`,
		} as any)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe('RedisCache', () => {
		test('create() produces a working instance', () => {
			const cache = RedisCache.create({ host: 'localhost' })
			expect(cache).toBeInstanceOf(RedisCache)
		})

		test('new RedisCache() is a compile error', () => {
			// @ts-expect-error — external `new` on a class with protected constructor is a compile error
			void (() => new RedisCache({ host: 'localhost' }))
		})

		test('Instance.on calls use { class: RedisCache }', () => {
			RedisCache.create({ host: 'localhost' })
			const startHook = hookCalls.find((h) => h.event === 'start')
			const closeHook = hookCalls.find((h) => h.event === 'close')
			expect(startHook?.options).toEqual({ class: RedisCache })
			expect(closeHook?.options).toEqual({ class: RedisCache })
		})

		test('skips start hook when extraConfig is provided', () => {
			RedisCache.create({ host: 'localhost' }, { maxRetriesPerRequest: null })
			const startHooks = hookCalls.filter((h) => h.event === 'start')
			const closeHooks = hookCalls.filter((h) => h.event === 'close')
			expect(startHooks).toHaveLength(0)
			expect(closeHooks).toHaveLength(1)
		})

		test('Config type matches pipe output', () => {
			type Expected = PipeOutput<ReturnType<typeof redisConfigPipe>>
			expectTypeOf<typeof RedisCache.Config>().toEqualTypeOf<Expected>()
		})

		test('connectionOptions is accessible', () => {
			const cache = RedisCache.create({ host: 'localhost', port: 6379 })
			expect(cache.connectionOptions).toBeDefined()
		})
	})
}
