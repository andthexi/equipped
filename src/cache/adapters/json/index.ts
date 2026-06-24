import { readFile, rename, writeFile } from 'node:fs/promises'

import { v } from 'valleyed'

import { EquippedError } from '../../../errors'
import { Instance } from '../../../instance'
import { configurable } from '../../../utilities'
import { Cache } from '../base'
import { InMemoryCacheStore } from '../in-memory/store'

const ADAPTER_NAME = 'json-cache'

export const jsonCacheConfigPipe = () => v.object({ filePath: v.string() })

const jsonCacheFilePipe = v.fromJson(
	v.object({
		entries: v.record(
			v.string(),
			v.object({
				data: v.string(),
				expiredAt: v.optional(v.number()),
			}),
		),
	}),
)
v.compile(jsonCacheFilePipe, { allErrors: true })

export class JsonCache extends configurable(jsonCacheConfigPipe, Cache) {
	readonly #store = new InMemoryCacheStore()
	#interval?: ReturnType<typeof setInterval>
	#started = false
	#writeQueue: Promise<void> = Promise.resolve()

	protected constructor(config: typeof JsonCache.Config) {
		super(config)
		Instance.on('start', async () => {
			await this.#start()
		}, { class: JsonCache })
		Instance.on('close', async () => {
			clearInterval(this.#interval)
			await this.#writeQueue
		}, { class: JsonCache })
	}

	#operationError(message: string, operation: string, cause?: unknown) {
		return new EquippedError(message, { adapter: ADAPTER_NAME, operation, filePath: this.config.filePath }, cause)
	}

	#assertStarted(operation: string) {
		if (!this.#started) throw this.#operationError('JsonCache has not been started', operation)
	}

	#serialize(): string {
		return JSON.stringify({ entries: this.#store.snapshot() })
	}

	async #atomicWrite(): Promise<void> {
		const tmpPath = this.config.filePath + '.tmp.' + process.pid + '.' + Date.now()
		await writeFile(tmpPath, this.#serialize(), 'utf-8')
		await rename(tmpPath, this.config.filePath)
	}

	#persistToDisk(operation: string): Promise<void> {
		const next = this.#writeQueue.then(() => this.#atomicWrite())
		this.#writeQueue = next.catch(() => {})
		return next.catch((error) => {
			throw this.#operationError('JsonCache failed to persist cache file', operation, error)
		})
	}

	async #loadFromDisk(): Promise<boolean> {
		let raw: string
		try {
			raw = await readFile(this.config.filePath, 'utf-8')
		} catch (error: any) {
			if (error?.code === 'ENOENT') return false
			throw this.#operationError('JsonCache failed to read persisted cache file', 'start', error)
		}

		const validity = v.validate(jsonCacheFilePipe, raw)
		if (!validity.valid) throw this.#operationError('JsonCache persisted cache file is invalid', 'start', validity.error)
		this.#store.restore(validity.value.entries)
		return true
	}

	async #start() {
		if (this.#started) return
		const loadedFromDisk = await this.#loadFromDisk()
		const removedExpired = this.#store.sweepExpired()
		if (loadedFromDisk && removedExpired) await this.#persistToDisk('start')
		this.#started = true
		this.#interval = setInterval(() => {
			void this.#persistExpiredSweep().catch((error) => {
				Instance.crash(this.#operationError('JsonCache expiry sweep failed', 'sweep', error))
			})
		}, 5000)
	}

	async #persistExpiredSweep() {
		if (!this.#started) return
		if (this.#store.sweepExpired()) await this.#persistToDisk('sweep')
	}

	async delete(key: string) {
		this.#assertStarted('delete')
		const changed = this.#store.delete(this.getScopedKey(key))
		if (changed) await this.#persistToDisk('delete')
	}

	async get(key: string) {
		this.#assertStarted('get')
		const result = this.#store.get(this.getScopedKey(key))
		if (result.deletedExpired) await this.#persistToDisk('get')
		return result.data
	}

	async set(key: string, data: string, ttlInSecs?: number) {
		this.#assertStarted('set')
		this.#store.set(this.getScopedKey(key), data, ttlInSecs)
		await this.#persistToDisk('set')
	}
}

if (import.meta.vitest) {
	const { describe, test, expect, expectTypeOf, vi, beforeEach, afterEach } = import.meta.vitest
	const { mkdtemp, readFile: readFileForTest, rm, writeFile: writeFileForTest } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')
	const { join } = await import('node:path')
	type PipeOutputOf<T> = import('valleyed').PipeOutput<T>

	let tmpDir: string
	let filePath: string
	let closeCallbacks: Array<() => void | Promise<void>>
	let onSpy: ReturnType<typeof vi.spyOn>
	let crashSpy: ReturnType<typeof vi.spyOn>

	function ensureInstance() {
		return Instance.maybeGet() ?? Instance.create({ app: { name: 'json-cache-test' }, log: { level: 'silent' } })
	}

	async function closeCapturedHooks() {
		for (const cb of closeCallbacks.reverse()) await cb()
		closeCallbacks = []
	}

	async function readPersistedEntries() {
		return JSON.parse(await readFileForTest(filePath, 'utf-8')) as { entries: Record<string, { data: string; expiredAt?: number }> }
	}

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'json-cache-'))
		filePath = join(tmpDir, 'cache.json')
		closeCallbacks = []
		const originalOn = Instance.on.bind(Instance)
		onSpy = vi.spyOn(Instance, 'on').mockImplementation((event, cb, options) => {
			if (event === 'close' && typeof cb === 'function') closeCallbacks.push(cb as () => void | Promise<void>)
			return originalOn(event, cb, options)
		})
		crashSpy = vi.spyOn(Instance, 'crash').mockImplementation((error) => {
			throw error
		})
	})

	afterEach(async () => {
		await closeCapturedHooks()
		onSpy.mockRestore()
		crashSpy.mockRestore()
		await rm(tmpDir, { recursive: true, force: true })
	})

	describe('JsonCache', () => {
		test('create() registers Instance lifecycle hooks', () => {
			const cache = JsonCache.create({ filePath })
			expect(cache).toBeInstanceOf(JsonCache)
			expect(onSpy).toHaveBeenCalledWith('start', expect.any(Function), expect.objectContaining({ class: JsonCache }))
			expect(onSpy).toHaveBeenCalledWith('close', expect.any(Function), expect.objectContaining({ class: JsonCache }))
		})

		test('Config type matches pipe output', () => {
			type Expected = PipeOutputOf<ReturnType<typeof jsonCacheConfigPipe>>
			expectTypeOf<typeof JsonCache.Config>().toEqualTypeOf<Expected>()
		})

		test('new JsonCache() is a compile error', () => {
			// @ts-expect-error — external `new` on a class with protected constructor is a compile error
			void (() => new JsonCache({ filePath }))
		})

		test('throws before Instance start loads the file', async () => {
			const cache = JsonCache.create({ filePath })

			await expect(cache.get('key')).rejects.toThrow(EquippedError)
			await expect(cache.set('key', 'value')).rejects.toThrow('JsonCache has not been started')
			await expect(cache.delete('key')).rejects.toThrow('JsonCache has not been started')
		})

		test('loads through Instance.start and persists mutations with scoped keys', async () => {
			const instance = ensureInstance()
			const scopedKey = instance.getScopedName('key', ':')
			await writeFileForTest(filePath, JSON.stringify({ entries: { [scopedKey]: { data: 'from-file' } } }), 'utf-8')
			const cache = JsonCache.create({ filePath })

			await instance.start()

			expect(await cache.get('key')).toBe('from-file')
			await cache.set('next', 'value')
			const persisted = await readPersistedEntries()
			expect(persisted.entries[instance.getScopedName('next', ':')]).toEqual({ data: 'value' })
		})

		test('missing file loads as empty and is not created until a mutation', async () => {
			const instance = ensureInstance()
			const cache = JsonCache.create({ filePath })

			await instance.start()

			expect(await cache.get('missing')).toBeNull()
			await expect(readFileForTest(filePath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' })

			await cache.set('key', 'value')
			expect(await readPersistedEntries()).toEqual({ entries: { [instance.getScopedName('key', ':')]: { data: 'value' } } })
		})

		test('start loading is idempotent for an adapter instance', async () => {
			const instance = ensureInstance()
			const scopedKey = instance.getScopedName('key', ':')
			await writeFileForTest(filePath, JSON.stringify({ entries: { [scopedKey]: { data: 'first' } } }), 'utf-8')
			const cache = JsonCache.create({ filePath })
			await instance.start()
			expect(await cache.get('key')).toBe('first')

			await writeFileForTest(filePath, JSON.stringify({ entries: { [scopedKey]: { data: 'second' } } }), 'utf-8')
			await instance.start()

			expect(await cache.get('key')).toBe('first')
		})

		test('persists absolute expiry timestamps and deletes expired entries discovered by get', async () => {
			const instance = ensureInstance()
			const now = Date.now()
			vi.spyOn(Date, 'now').mockReturnValue(now)
			const cache = JsonCache.create({ filePath })
			await instance.start()

			await cache.set('key', 'value', 1)
			let persisted = await readPersistedEntries()
			expect(persisted.entries[instance.getScopedName('key', ':')]).toEqual({ data: 'value', expiredAt: now + 1000 })

			vi.spyOn(Date, 'now').mockReturnValue(now + 1001)
			expect(await cache.get('key')).toBeNull()
			persisted = await readPersistedEntries()
			expect(persisted.entries).not.toHaveProperty(instance.getScopedName('key', ':'))
		})

		test('drops expired entries on startup and rewrites an existing file', async () => {
			const instance = ensureInstance()
			const now = Date.now()
			const expiredKey = instance.getScopedName('expired', ':')
			const activeKey = instance.getScopedName('active', ':')
			await writeFileForTest(
				filePath,
				JSON.stringify({
					entries: {
						[expiredKey]: { data: 'old', expiredAt: now - 1 },
						[activeKey]: { data: 'new', expiredAt: now + 1000 },
					},
				}),
				'utf-8',
			)
			vi.spyOn(Date, 'now').mockReturnValue(now)
			const cache = JsonCache.create({ filePath })

			await instance.start()

			expect(await cache.get('expired')).toBeNull()
			expect(await cache.get('active')).toBe('new')
			const persisted = await readPersistedEntries()
			expect(persisted.entries).not.toHaveProperty(expiredKey)
			expect(persisted.entries).toHaveProperty(activeKey)
		})

		test('strictly rejects invalid persisted file contents while stripping unknown extras', async () => {
			const instance = ensureInstance()
			await writeFileForTest(filePath, JSON.stringify({ entries: { bad: { data: 123 } } }), 'utf-8')
			const cache = JsonCache.create({ filePath })

			await expect(instance.start()).rejects.toThrow('Error starting instance')

			const scopedKey = instance.getScopedName('ok', ':')
			await writeFileForTest(
				filePath,
				JSON.stringify({ extra: true, entries: { [scopedKey]: { data: 'value', extra: true } } }),
				'utf-8',
			)
			await instance.start()

			expect(await cache.get('ok')).toBe('value')
		})

		test('delete persists only when the key existed', async () => {
			const instance = ensureInstance()
			const cache = JsonCache.create({ filePath })
			await instance.start()
			await cache.delete('missing')
			await expect(readFileForTest(filePath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' })

			await cache.set('key', 'value')
			await cache.delete('key')
			expect(await readPersistedEntries()).toEqual({ entries: {} })
		})

		test('rejects foreground mutations when the file cannot be written', async () => {
			const instance = ensureInstance()
			const cache = JsonCache.create({ filePath })
			await instance.start()
			await rm(tmpDir, { recursive: true, force: true })

			await expect(cache.set('key', 'value')).rejects.toMatchObject({
				context: expect.objectContaining({ adapter: ADAPTER_NAME, operation: 'set' }),
			})
		})
	})
}
