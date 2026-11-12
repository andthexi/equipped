import { AsyncLocalStorage } from 'node:async_hooks'
import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises'

import { v } from 'valleyed'

import { configurable } from '../../../utilities/configurable.js'
import type { FilterGroup } from '../../filter.js'
import type { DiscoveredSchema } from '../../migrations/introspection-types.js'
import type {
	AddFieldChange,
	AddForeignKeyChange,
	AddIndexChange,
	AnyFieldSpec,
	CreateTableChange,
	DropFieldChange,
	DropForeignKeyChange,
	DropIndexChange,
	DropTableChange,
	ModifyFieldChange,
	RenameFieldChange,
	RenameTableChange,
} from '../../migrations/types.js'
import { OrmAdapter, type AggregateSpec } from '../../orm-adapter.js'
import type { IterationQueryOptions, QueryOptions } from '../../query-options.js'
import type { AnySchema } from '../../schema.js'
import type { AnyUpdateOp } from '../../updates.js'
import { InMemoryAdapter, type InMemoryRepoConfig } from '../in-memory/index.js'

export type JsonAdapterConfig = InMemoryRepoConfig

const jsonConnectionPipe = () =>
	v.object({
		filePath: v.string(),
	})

const fileLockStore = new AsyncLocalStorage<Set<string>>()
const fileSessionStore = new AsyncLocalStorage<Set<string>>()

export class JsonAdapter extends configurable(jsonConnectionPipe, OrmAdapter) {
	readonly schemaConfigPipe = v.object({ table: v.string() })

	readonly #inMemory = InMemoryAdapter.create({})

	readonly supportedFieldTypes = this.#inMemory.supportedFieldTypes
	readonly queryableOps = this.#inMemory.queryableOps
	readonly updateOps = this.#inMemory.updateOps
	readonly aggregateOps = this.#inMemory.aggregateOps

	#operationQueue: Promise<unknown> = Promise.resolve()

	protected constructor(config: typeof JsonAdapter.Config) {
		super(config)
	}

	get stores() {
		return this.#inMemory.stores
	}

	#serialize(): string {
		const obj: Record<string, unknown> = {}

		const migrations = [...this.#inMemory.migrations.values()]
		if (migrations.length > 0) obj['__migrations'] = migrations

		const tables: Record<string, unknown> = {}
		for (const [name, meta] of this.#inMemory.tables.entries()) {
			tables[name] = { pk: meta.pk, fields: Object.fromEntries(meta.fields.entries()) }
		}
		if (Object.keys(tables).length > 0) obj['__tables'] = tables

		const indexes: Record<string, unknown> = {}
		for (const [name, meta] of this.#inMemory.indexes.entries()) {
			indexes[name] = { table: meta.table, on: [...meta.on], unique: meta.unique }
		}
		if (Object.keys(indexes).length > 0) obj['__indexes'] = indexes

		const foreignKeys: Record<string, unknown> = {}
		for (const [name, meta] of this.#inMemory.foreignKeys.entries()) {
			foreignKeys[name] = {
				table: meta.table,
				on: meta.on,
				references: meta.references,
				...(meta.onDelete ? { onDelete: meta.onDelete } : {}),
				...(meta.onUpdate ? { onUpdate: meta.onUpdate } : {}),
			}
		}
		if (Object.keys(foreignKeys).length > 0) obj['__foreignKeys'] = foreignKeys

		for (const [name, store] of this.stores.entries()) {
			const records: Record<string, Record<string, unknown>> = {}
			for (const [pk, doc] of store.entries()) {
				records[pk] = doc
			}
			obj[name] = records
		}

		return JSON.stringify(obj)
	}

	async #atomicWrite(): Promise<void> {
		const data = this.#serialize()
		const tmpPath = this.config.filePath + '.tmp.' + process.pid + '.' + Date.now()
		await writeFile(tmpPath, data, 'utf-8')
		await rename(tmpPath, this.config.filePath)
	}

	#enqueue<T>(run: () => Promise<T>): Promise<T> {
		const next = this.#operationQueue.then(run, run)
		this.#operationQueue = next.then(
			() => undefined,
			() => undefined,
		)
		return next
	}

	async #withFileLock<T>(run: () => Promise<T>): Promise<T> {
		const lockPath = this.#lockPath()
		const activeLocks = fileLockStore.getStore()
		if (activeLocks?.has(lockPath)) return run()
		return this.#enqueue(async () => {
			await this.#acquireLockFile()
			try {
				return await fileLockStore.run(new Set([...(activeLocks ?? []), lockPath]), run)
			} finally {
				await this.#releaseLockFile()
			}
		})
	}

	async #acquireLockFile(): Promise<void> {
		const lockPath = this.#lockPath()
		const deadline = Date.now() + 30_000
		while (true) {
			try {
				const handle = await open(lockPath, 'wx')
				await handle.close()
				return
			} catch (err: any) {
				if (err.code !== 'EEXIST') throw err
				if (Date.now() > deadline) throw new Error('Timed out waiting for json adapter file lock')
				await new Promise((resolve) => setTimeout(resolve, 50))
			}
		}
	}

	async #releaseLockFile(): Promise<void> {
		await unlink(this.#lockPath()).catch(() => {})
	}

	#lockPath(): string {
		return this.config.filePath + '.lock'
	}

	async #withCurrentFile<T>(persist: boolean, run: () => Promise<T>): Promise<T> {
		if (fileSessionStore.getStore()?.has(this.#lockPath())) return run()
		return this.#withFileLock(async () => {
			await this.#loadFromDisk()
			const result = await run()
			if (persist) await this.#atomicWrite()
			return result
		})
	}

	async #persistCurrentFileIfNeeded(shouldPersist: boolean): Promise<void> {
		if (shouldPersist && !fileSessionStore.getStore()?.has(this.#lockPath())) await this.#atomicWrite()
	}

	async #loadFromDisk(): Promise<void> {
		let raw: string
		try {
			raw = await readFile(this.config.filePath, 'utf-8')
		} catch (error: any) {
			if (error?.code !== 'ENOENT') throw error
			this.#clearInMemory()
			return
		}
		this.#restoreFromDisk(JSON.parse(raw) as Record<string, unknown>)
	}

	#clearInMemory(): void {
		this.#inMemory.migrations.clear()
		this.#inMemory.tables.clear()
		this.#inMemory.indexes.clear()
		this.#inMemory.foreignKeys.clear()
		this.stores.clear()
	}

	#restoreFromDisk(data: Record<string, unknown>): void {
		this.#clearInMemory()

		if (Array.isArray(data['__migrations'])) {
			for (const m of data['__migrations'] as Array<{ id: string; appliedAt: number }>) {
				this.#inMemory.migrations.set(m.id, { id: m.id, appliedAt: m.appliedAt })
			}
		}

		if (data['__tables'] && typeof data['__tables'] === 'object') {
			for (const [name, meta] of Object.entries(data['__tables'] as Record<string, any>)) {
				const fields = new Map<string, AnyFieldSpec>()
				if (meta.fields) {
					for (const [fieldName, fspec] of Object.entries(meta.fields as Record<string, AnyFieldSpec>)) {
						fields.set(fieldName, fspec)
					}
				}
				this.#inMemory.tables.set(name, { pk: meta.pk, fields })
			}
		}

		if (data['__indexes'] && typeof data['__indexes'] === 'object') {
			for (const [name, meta] of Object.entries(data['__indexes'] as Record<string, any>)) {
				this.#inMemory.indexes.set(name, { table: meta.table, on: meta.on, unique: meta.unique })
			}
		}

		if (data['__foreignKeys'] && typeof data['__foreignKeys'] === 'object') {
			for (const [name, meta] of Object.entries(data['__foreignKeys'] as Record<string, any>)) {
				this.#inMemory.foreignKeys.set(name, meta)
			}
		}

		for (const [name, records] of Object.entries(data)) {
			if (name.startsWith('__')) continue
			const store = new Map<string, Record<string, unknown>>()
			for (const [pk, doc] of Object.entries(records as Record<string, Record<string, unknown>>)) {
				store.set(pk, doc)
			}
			this.stores.set(name, store)
		}
	}

	async connect(): Promise<void> {
		await this.#withFileLock(async () => await this.#loadFromDisk())
	}

	async disconnect(): Promise<void> {
		await this.#operationQueue
	}

	async findByPk(schema: AnySchema, config: unknown, pk: unknown) {
		return this.#withCurrentFile(false, async () => await this.#inMemory.findByPk(schema, config, pk))
	}

	async createMany(schema: AnySchema, config: unknown, data: Record<string, unknown>[]) {
		return this.#withCurrentFile(true, async () => await this.#inMemory.createMany(schema, config, data))
	}

	async updateByPk(schema: AnySchema, config: unknown, pk: unknown, ops: AnyUpdateOp[]) {
		return this.#withCurrentFile(false, async () => {
			const result = await this.#inMemory.updateByPk(schema, config, pk, ops)
			await this.#persistCurrentFileIfNeeded(result !== null)
			return result
		})
	}

	async deleteByPk(schema: AnySchema, config: unknown, pk: unknown) {
		return this.#withCurrentFile(false, async () => {
			const result = await this.#inMemory.deleteByPk(schema, config, pk)
			await this.#persistCurrentFileIfNeeded(result !== null)
			return result
		})
	}

	async findMany(schema: AnySchema, config: unknown, group: FilterGroup, options?: QueryOptions) {
		return this.#withCurrentFile(false, async () => await this.#inMemory.findMany(schema, config, group, options))
	}

	async count(schema: AnySchema, config: unknown, group: FilterGroup) {
		return this.#withCurrentFile(false, async () => await this.#inMemory.count(schema, config, group))
	}

	async *iterateMany(schema: AnySchema, config: unknown, group: FilterGroup, options?: IterationQueryOptions) {
		const rows = await this.#withCurrentFile(false, async () => {
			const results: Record<string, unknown>[] = []
			for await (const row of this.#inMemory.iterateMany(schema, config, group, options)) results.push(row)
			return results
		})
		for (const row of rows) yield row
	}

	async updateMany(schema: AnySchema, config: unknown, group: FilterGroup, data: Record<string, unknown>) {
		return this.#withCurrentFile(false, async () => {
			const result = await this.#inMemory.updateMany(schema, config, group, data)
			await this.#persistCurrentFileIfNeeded(result.length > 0)
			return result
		})
	}

	async deleteMany(schema: AnySchema, config: unknown, filter: FilterGroup) {
		return this.#withCurrentFile(false, async () => {
			const result = await this.#inMemory.deleteMany(schema, config, filter)
			await this.#persistCurrentFileIfNeeded(result.length > 0)
			return result
		})
	}

	async upsertOne(
		schema: AnySchema,
		config: unknown,
		filter: FilterGroup,
		create: Record<string, unknown>,
		ops: AnyUpdateOp[],
	) {
		return this.#withCurrentFile(
			true,
			async () => await this.#inMemory.upsertOne(schema, config, filter, create, ops),
		)
	}

	async aggregate(schema: AnySchema, config: unknown, spec: AggregateSpec) {
		return this.#withCurrentFile(false, async () => await this.#inMemory.aggregate(schema, config, spec))
	}

	async session<T>(fn: () => Promise<T>): Promise<T> {
		const lockPath = this.#lockPath()
		const activeSessions = fileSessionStore.getStore()
		if (activeSessions?.has(lockPath)) return this.#inMemory.session(fn)
		return this.#withFileLock(async () => {
			await this.#loadFromDisk()
			const result = await fileSessionStore.run(new Set([...(activeSessions ?? []), lockPath]), async () =>
				this.#inMemory.session(fn),
			)
			await this.#atomicWrite()
			return result
		})
	}

	async loadMigrations(): Promise<{ id: string; appliedAt: number }[]> {
		return this.#withCurrentFile(false, async () => await this.#inMemory.loadMigrations())
	}

	async recordMigration(id: string, appliedAt: number): Promise<void> {
		return this.#withCurrentFile(true, async () => await this.#inMemory.recordMigration(id, appliedAt))
	}

	async acquireMigrationLock<T>(fn: () => Promise<T>): Promise<T> {
		return this.#withFileLock(fn)
	}

	async applyCreateTable(change: CreateTableChange<any>, target?: unknown): Promise<void> {
		return this.#withCurrentFile(true, async () => await this.#inMemory.applyCreateTable(change, target))
	}

	async applyDropTable(change: DropTableChange, target?: unknown): Promise<void> {
		return this.#withCurrentFile(true, async () => await this.#inMemory.applyDropTable(change, target))
	}

	async applyAddField(change: AddFieldChange<any>, target?: unknown): Promise<void> {
		return this.#withCurrentFile(true, async () => await this.#inMemory.applyAddField(change, target))
	}

	async applyDropField(change: DropFieldChange, target?: unknown): Promise<void> {
		return this.#withCurrentFile(true, async () => await this.#inMemory.applyDropField(change, target))
	}

	async applyModifyField(change: ModifyFieldChange<any>, target?: unknown): Promise<void> {
		return this.#withCurrentFile(true, async () => await this.#inMemory.applyModifyField(change, target))
	}

	async applyRenameTable(change: RenameTableChange, from?: unknown, to?: unknown): Promise<void> {
		return this.#withCurrentFile(true, async () => await this.#inMemory.applyRenameTable(change, from, to))
	}

	async applyRenameField(change: RenameFieldChange, target?: unknown): Promise<void> {
		return this.#withCurrentFile(true, async () => await this.#inMemory.applyRenameField(change, target))
	}

	async applyAddIndex(change: AddIndexChange, target?: unknown): Promise<void> {
		return this.#withCurrentFile(true, async () => await this.#inMemory.applyAddIndex(change, target))
	}

	async applyDropIndex(change: DropIndexChange, target?: unknown): Promise<void> {
		return this.#withCurrentFile(true, async () => await this.#inMemory.applyDropIndex(change, target))
	}

	async applyAddForeignKey(change: AddForeignKeyChange, target?: unknown, referencedTarget?: unknown): Promise<void> {
		return this.#withCurrentFile(
			true,
			async () => await this.#inMemory.applyAddForeignKey(change, target, referencedTarget),
		)
	}

	async applyDropForeignKey(change: DropForeignKeyChange, target?: unknown): Promise<void> {
		return this.#withCurrentFile(true, async () => await this.#inMemory.applyDropForeignKey(change, target))
	}

	physicalTargetIdentity(config: JsonAdapterConfig): string {
		return this.#inMemory.physicalTargetIdentity(config)
	}

	async introspectTarget(config: JsonAdapterConfig): Promise<DiscoveredSchema | null> {
		return this.#withCurrentFile(false, async () => await this.#inMemory.introspectTarget(config))
	}

	async introspect(): Promise<DiscoveredSchema[]> {
		return this.#withCurrentFile(false, async () => await this.#inMemory.introspect())
	}
}

if (import.meta.vitest) {
	const { describe, test, expect, beforeEach, afterEach } = import.meta.vitest
	const { FilterGroup } = await import('../../filter.js')
	const { OrderBy } = await import('../../query-options.js')
	const { Schema } = await import('../../schema.js')
	const { IncOp, PatchOp, PullOp, PushOp } = await import('../../updates.js')
	const { v } = await import('valleyed')
	const { mkdtemp, rm } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')
	const { join } = await import('node:path')
	const { Migrator } = await import('../../migrations/migrator.js')
	const { Repo } = await import('../../repo/repo.js')
	const { OrmMigrationError } = await import('../../errors/migration.js')
	type Migration<A extends import('../base.js').OrmAdapterLike<any>> =
		import('../../migrations/types.js').Migration<A>

	let tmpDir: string
	let filePath: string

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'json-adapter-'))
		filePath = join(tmpDir, 'test.json')
	})

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true })
	})

	describe('json adapter — class construction', () => {
		test('JsonAdapter.create({ filePath }) produces a working adapter', () => {
			const adapter = JsonAdapter.create({ filePath })
			expect(adapter).toBeInstanceOf(JsonAdapter)
			expect(adapter.schemaConfigPipe).toBeDefined()
			expect(adapter.supportedFieldTypes).toEqual([
				'string',
				'number',
				'boolean',
				'null',
				'object',
				'array',
				'date',
			])
		})

		test('auto-wired Instance hooks register connect/disconnect keyed by class', async () => {
			const { Instance: Inst } = await import('../../../instance/index.js')
			const onSpy = (await import('vitest')).vi.spyOn(Inst, 'on').mockImplementation(() => {})

			JsonAdapter.create({ filePath })

			expect(onSpy).toHaveBeenCalledWith(
				'start',
				expect.any(Function),
				expect.objectContaining({ class: JsonAdapter }),
			)
			expect(onSpy).toHaveBeenCalledWith(
				'close',
				expect.any(Function),
				expect.objectContaining({ class: JsonAdapter }),
			)

			onSpy.mockRestore()
		})
	})

	describe('json adapter — surface parity with in-memory', () => {
		test('targeted introspection reads one resolved table while broad discovery remains available', async () => {
			const adapter = JsonAdapter.create({ filePath })
			await adapter.connect()
			await adapter.applyCreateTable({
				kind: 'createTable',
				name: 'users',
				pk: { name: 'id', type: 'string' },
				fields: [],
			})

			expect((await adapter.introspectTarget({ table: 'users' }))?.name).toBe('users')
			expect(await adapter.introspectTarget({ table: 'missing' })).toBeNull()
			expect(adapter.physicalTargetIdentity({ table: 'users' })).toBe('users')
			expect(await adapter.introspect()).toHaveLength(1)
			await adapter.disconnect()
		})

		test('CRUD: create, find, update, delete round-trip', async () => {
			const schema = Schema.from('users')
				.pk('id', v.string(), () => 'u')
				.field('name', v.string())
				.field('age', v.number())
				.build()

			const adapter = JsonAdapter.create({ filePath })
			await adapter.connect()

			const use = adapter.use(schema, { table: 'users' })

			const created = await use.createMany([
				{ id: 'u1', name: 'Alice', age: 30 },
				{ id: 'u2', name: 'Bob', age: 20 },
			])
			expect(created).toHaveLength(2)

			const found = await use.findOne(FilterGroup.create().eq('id', 'u1'))
			expect(found).toEqual({ id: 'u1', name: 'Alice', age: 30 })

			const many = await use.findMany(FilterGroup.create().gt('age', 19), {
				orderBy: [new OrderBy('age', 'asc')],
			})
			expect(many).toEqual([
				{ id: 'u2', name: 'Bob', age: 20 },
				{ id: 'u1', name: 'Alice', age: 30 },
			])

			await use.updateOne(FilterGroup.create().eq('id', 'u1'), { age: 31 })
			const updated = await use.findOne(FilterGroup.create().eq('id', 'u1'))
			expect(updated?.age).toBe(31)

			const deleted = await use.deleteOne(FilterGroup.create().eq('id', 'u2'))
			expect(deleted).toEqual({ id: 'u2', name: 'Bob', age: 20 })

			const remaining = await use.findMany(FilterGroup.create())
			expect(remaining).toHaveLength(1)

			await adapter.disconnect()
		})

		test('supports nested filters, ordering, select, offset and limit', async () => {
			const schema = Schema.from('users')
				.pk('id', v.string(), () => 'u')
				.field('name', v.string())
				.field('age', v.number())
				.build()

			const adapter = JsonAdapter.create({ filePath })
			await adapter.connect()
			const use = adapter.use(schema, { table: 'users' })

			await use.createMany([
				{ id: 'u1', name: 'Alice', age: 30 },
				{ id: 'u2', name: 'Bob', age: 20 },
				{ id: 'u3', name: 'Carol', age: 40 },
			])

			const builtGroup = FilterGroup.create().and([
				(q) => q.gt('age', 19),
				(q) => q.or([(g) => g.eq('name', 'Alice'), (g) => g.eq('name', 'Carol')]),
			])
			const options = {
				orderBy: [new OrderBy('age', 'desc')],
				offset: 1,
				limit: 1,
				select: ['id', 'name'] as const,
			}
			const rows = await use.findMany(builtGroup, options)
			expect(rows).toEqual([{ id: 'u1', name: 'Alice' }])

			await adapter.disconnect()
		})

		test('count delegates to the in-memory store and persists separately from query options', async () => {
			const schema = Schema.from('count_users')
				.pk('id', v.string(), () => 'u')
				.field('name', v.string())
				.build()

			const adapter = JsonAdapter.create({ filePath })
			await adapter.connect()
			const use = adapter.use(schema, { table: 'count_users' })
			await use.createMany([
				{ id: 'u1', name: 'Alice' },
				{ id: 'u2', name: 'Bob' },
				{ id: 'u3', name: 'Alice' },
			])

			await expect(use.count(FilterGroup.create().eq('name', 'Alice'))).resolves.toBe(2)
			await adapter.disconnect()
		})

		test('iterateMany with batchSize matches findMany through in-memory delegation', async () => {
			const schema = Schema.from('json_iter_users')
				.pk('id', v.string(), () => 'u')
				.field('name', v.string())
				.field('age', v.number())
				.build()

			const adapter = JsonAdapter.create({ filePath })
			await adapter.connect()
			const use = adapter.use(schema, { table: 'json_iter_users' })
			await use.createMany([
				{ id: 'u1', name: 'Alice', age: 30 },
				{ id: 'u2', name: 'Bob', age: 20 },
				{ id: 'u3', name: 'Carol', age: 40 },
				{ id: 'u4', name: 'Dan', age: 50 },
			])

			const filter = FilterGroup.create().gt('age', 19)
			const options = {
				orderBy: [new OrderBy('age', 'desc')],
				offset: 1,
				limit: 2,
				select: ['id', 'name'],
			}
			const expected = await use.findMany(filter, options)
			const rows: Record<string, unknown>[] = []
			for await (const row of use.iterateMany(filter, { ...options, batchSize: 2 })) {
				rows.push(row)
			}
			expect(rows).toEqual(expected)
			expect(rows).toEqual([
				{ id: 'u3', name: 'Carol' },
				{ id: 'u1', name: 'Alice' },
			])

			await adapter.disconnect()
		})

		test('supports update operators and rollback on failed session', async () => {
			const schema = Schema.from('docs')
				.pk('id', v.string(), () => 'd1')
				.field('count', v.number())
				.field('tags', v.array(v.string()))
				.field('meta', v.object({ a: v.number() }))
				.build()

			const adapter = JsonAdapter.create({ filePath })
			await adapter.connect()
			const use = adapter.use(schema, { table: 'docs' })

			await use.createOne({ id: 'd1', count: 1, tags: ['x'], meta: { a: 1 } })

			await adapter.session(async () => {
				await use.updateOne(FilterGroup.create().eq('id', 'd1'), {
					count: new IncOp('count', 2),
					tags: new PushOp('tags', 'y'),
					meta: new PatchOp('meta', { a: 9 }),
				})
			})

			await expect(
				adapter.session(async () => {
					await use.updateOne(FilterGroup.create().eq('id', 'd1'), { tags: new PullOp('tags', 'x') })
					throw new Error('boom')
				}),
			).rejects.toThrow('boom')

			const row = await use.findOne(FilterGroup.create().eq('id', 'd1'))
			expect(row).toEqual({ id: 'd1', count: 3, tags: ['x', 'y'], meta: { a: 9 } })

			await adapter.disconnect()
		})

		test('upsertOne inserts when missing and updates when existing', async () => {
			const schema = Schema.from('items')
				.pk('id', v.string(), () => 'i')
				.field('val', v.number())
				.build()

			const adapter = JsonAdapter.create({ filePath })
			await adapter.connect()
			const use = adapter.use(schema, { table: 'items' })

			const inserted = await use.upsertOne(FilterGroup.create().eq('id', 'i1'), { id: 'i1', val: 10 }, [])
			expect(inserted).toEqual({ id: 'i1', val: 10 })

			const updated = await use.upsertOne(FilterGroup.create().eq('id', 'i1'), { id: 'i1', val: 10 }, [
				new IncOp('val', 5),
			])
			expect(updated).toEqual({ id: 'i1', val: 15 })

			await adapter.disconnect()
		})
	})

	describe('json adapter — persistence', () => {
		test('lazy discovery and table rename/drop remain consistent across reloads', async () => {
			const schema = Schema.from('users')
				.pk('id', v.string(), () => 'u')
				.field('name', v.string())
				.build()
			const first = JsonAdapter.create({ filePath })
			await first.connect()
			await first.use(schema, { table: 'users' }).createMany([{ id: 'u1', name: 'Alice' }])
			await first.disconnect()

			const second = JsonAdapter.create({ filePath })
			await second.connect()
			expect((await second.introspect()).map((s) => s.name)).toEqual(['users'])
			await second.applyRenameTable({ kind: 'renameTable', from: 'users', to: 'members' })
			await second.disconnect()

			const third = JsonAdapter.create({ filePath })
			await third.connect()
			expect(await third.use(schema, { table: 'members' }).findMany(FilterGroup.create())).toEqual([
				{ id: 'u1', name: 'Alice' },
			])
			expect(await third.use(schema, { table: 'users' }).findMany(FilterGroup.create())).toEqual([])
			expect((await third.introspect()).map((s) => s.name)).toEqual(['members'])
			await third.applyDropTable({ kind: 'dropTable', name: 'members' })
			await third.disconnect()

			const fourth = JsonAdapter.create({ filePath })
			await fourth.connect()
			expect(await fourth.use(schema, { table: 'members' }).findMany(FilterGroup.create())).toEqual([])
			expect(await fourth.introspect()).toEqual([])
			await fourth.disconnect()
		})

		test('state persists across adapter restarts', async () => {
			const schema = Schema.from('users')
				.pk('id', v.string(), () => 'u')
				.field('name', v.string())
				.build()

			const a1 = JsonAdapter.create({ filePath })
			await a1.connect()
			const use1 = a1.use(schema, { table: 'users' })
			await use1.createMany([
				{ id: 'u1', name: 'Alice' },
				{ id: 'u2', name: 'Bob' },
			])
			await a1.disconnect()

			const a2 = JsonAdapter.create({ filePath })
			await a2.connect()
			const use2 = a2.use(schema, { table: 'users' })
			const rows = await use2.findMany(FilterGroup.create())
			expect(rows).toHaveLength(2)
			expect(rows.map((r) => r.name).sort()).toEqual(['Alice', 'Bob'])
			await a2.disconnect()
		})

		test('failed session does not persist rolled-back state to disk', async () => {
			const schema = Schema.from('docs')
				.pk('id', v.string(), () => 'd')
				.field('val', v.number())
				.build()

			const a1 = JsonAdapter.create({ filePath })
			await a1.connect()
			const use1 = a1.use(schema, { table: 'docs' })
			await use1.createOne({ id: 'd1', val: 1 })
			await a1.disconnect()

			const a2 = JsonAdapter.create({ filePath })
			await a2.connect()
			const use2 = a2.use(schema, { table: 'docs' })
			await expect(
				a2.session(async () => {
					await use2.updateOne(FilterGroup.create().eq('id', 'd1'), { val: 999 })
					throw new Error('rollback')
				}),
			).rejects.toThrow('rollback')
			await a2.disconnect()

			const a3 = JsonAdapter.create({ filePath })
			await a3.connect()
			const use3 = a3.use(schema, { table: 'docs' })
			const row = await use3.findOne(FilterGroup.create().eq('id', 'd1'))
			expect(row?.val).toBe(1)
			await a3.disconnect()
		})
	})

	describe('json adapter — atomic writes', () => {
		test('file is valid JSON after every write', async () => {
			const { readFile: rf } = await import('node:fs/promises')
			const schema = Schema.from('items')
				.pk('id', v.string(), () => 'i')
				.field('val', v.number())
				.build()

			const adapter = JsonAdapter.create({ filePath })
			await adapter.connect()
			const use = adapter.use(schema, { table: 'items' })

			for (let i = 0; i < 10; i++) {
				await use.createOne({ id: `i${i}`, val: i })
				const raw = await rf(filePath, 'utf-8')
				expect(() => JSON.parse(raw)).not.toThrow()
			}
			await adapter.disconnect()
		})

		test('no .tmp files remain after writes complete', async () => {
			const { readdir } = await import('node:fs/promises')
			const schema = Schema.from('items')
				.pk('id', v.string(), () => 'i')
				.field('val', v.number())
				.build()

			const adapter = JsonAdapter.create({ filePath })
			await adapter.connect()
			const use = adapter.use(schema, { table: 'items' })

			for (let i = 0; i < 5; i++) {
				await use.createOne({ id: `i${i}`, val: i })
			}
			await adapter.disconnect()

			const files = await readdir(tmpDir)
			const tmpFiles = files.filter((f) => f.includes('.tmp.'))
			expect(tmpFiles).toHaveLength(0)
		})
	})

	describe('json adapter — aggregate delegation', () => {
		const orderSchema = Schema.from('orders')
			.pk('id', v.string(), () => 'o')
			.field('amount', v.number())
			.field('region', v.string())
			.build()

		const orderSeed = [
			{ id: 'o1', amount: 100, region: 'us' },
			{ id: 'o2', amount: 200, region: 'eu' },
			{ id: 'o3', amount: 150, region: 'us' },
		]

		async function makeSeededAdapter() {
			const adapter = JsonAdapter.create({ filePath })
			await adapter.connect()
			const use = adapter.use(orderSchema, { table: 'orders' })
			await use.createMany(orderSeed)
			return adapter
		}

		test('aggregateOps matches in-memory adapter', () => {
			const json = JsonAdapter.create({ filePath })
			const inMem = InMemoryAdapter.create({})
			expect(json.aggregateOps).toEqual(inMem.aggregateOps)
			expect(json.aggregateOps).toEqual(['count', 'countDistinct', 'sum', 'avg', 'min', 'max'])
		})

		test('count returns identical result to in-memory', async () => {
			const adapter = await makeSeededAdapter()
			const result = await adapter.aggregate(
				orderSchema,
				{ table: 'orders' },
				{
					aggregates: [{ fn: 'count', alias: 'total' }],
					groupBy: [],
				},
			)
			expect(result).toEqual([{ total: 3 }])
			await adapter.disconnect()
		})

		test('countDistinct returns identical result to in-memory', async () => {
			const adapter = await makeSeededAdapter()
			const result = await adapter.aggregate(
				orderSchema,
				{ table: 'orders' },
				{
					aggregates: [{ fn: 'countDistinct', field: 'region', alias: 'uniqueRegions' }],
					groupBy: [],
				},
			)
			expect(result).toEqual([{ uniqueRegions: 2 }])
			await adapter.disconnect()
		})

		test('sum, avg, min, max return identical results to in-memory', async () => {
			const adapter = await makeSeededAdapter()
			const result = await adapter.aggregate(
				orderSchema,
				{ table: 'orders' },
				{
					aggregates: [
						{ fn: 'sum', field: 'amount', alias: 'totalAmount' },
						{ fn: 'avg', field: 'amount', alias: 'avgAmount' },
						{ fn: 'min', field: 'amount', alias: 'minAmount' },
						{ fn: 'max', field: 'amount', alias: 'maxAmount' },
					],
					groupBy: [],
				},
			)
			expect(result).toEqual([{ totalAmount: 450, avgAmount: 150, minAmount: 100, maxAmount: 200 }])
			await adapter.disconnect()
		})

		test('groupBy returns identical results to in-memory', async () => {
			const adapter = await makeSeededAdapter()
			const result = await adapter.aggregate(
				orderSchema,
				{ table: 'orders' },
				{
					aggregates: [
						{ fn: 'count', alias: 'cnt' },
						{ fn: 'sum', field: 'amount', alias: 'total' },
					],
					groupBy: ['region'],
				},
			)
			const sorted = result.sort((a, b) => String(a.region).localeCompare(String(b.region)))
			expect(sorted).toEqual([
				{ region: 'eu', cnt: 1, total: 200 },
				{ region: 'us', cnt: 2, total: 250 },
			])
			await adapter.disconnect()
		})

		test('where pre-filter returns identical results to in-memory', async () => {
			const adapter = await makeSeededAdapter()
			const result = await adapter.aggregate(
				orderSchema,
				{ table: 'orders' },
				{
					where: FilterGroup.create().gt('amount', 100),
					aggregates: [{ fn: 'count', alias: 'cnt' }],
					groupBy: [],
				},
			)
			expect(result).toEqual([{ cnt: 2 }])
			await adapter.disconnect()
		})

		test('having post-filter returns identical results to in-memory', async () => {
			const adapter = await makeSeededAdapter()
			const result = await adapter.aggregate(
				orderSchema,
				{ table: 'orders' },
				{
					aggregates: [{ fn: 'count', alias: 'cnt' }],
					groupBy: ['region'],
					having: FilterGroup.create().gt('cnt', 1),
				},
			)
			expect(result).toEqual([{ region: 'us', cnt: 2 }])
			await adapter.disconnect()
		})

		test('aggregate delegates to same in-memory instance used by CRUD', async () => {
			const schema = Schema.from('items')
				.pk('id', v.string(), () => 'i')
				.field('val', v.number())
				.build()

			const adapter = JsonAdapter.create({ filePath })
			await adapter.connect()
			const use = adapter.use(schema, { table: 'items' })

			await use.createMany([
				{ id: 'i1', val: 10 },
				{ id: 'i2', val: 20 },
			])

			const spec: AggregateSpec = {
				aggregates: [{ fn: 'sum', field: 'val', alias: 'total' }],
				groupBy: [],
			}
			const result = await adapter.aggregate(schema, { table: 'items' }, spec)
			expect(result).toEqual([{ total: 30 }])

			await use.createOne({ id: 'i3', val: 30 })
			const result2 = await adapter.aggregate(schema, { table: 'items' }, spec)
			expect(result2).toEqual([{ total: 60 }])

			await adapter.disconnect()
		})
	})

	describe('json adapter — concurrent writes serialize', () => {
		test('parallel writes from same process all persist', async () => {
			const schema = Schema.from('items')
				.pk('id', v.string(), () => 'i')
				.field('val', v.number())
				.build()

			const adapter = JsonAdapter.create({ filePath })
			await adapter.connect()
			const use = adapter.use(schema, { table: 'items' })

			await Promise.all(Array.from({ length: 20 }, (_, i) => use.createOne({ id: `i${i}`, val: i })))

			const rows = await use.findMany(FilterGroup.create())
			expect(rows).toHaveLength(20)
			await adapter.disconnect()

			const a2 = JsonAdapter.create({ filePath })
			await a2.connect()
			const use2 = a2.use(schema, { table: 'items' })
			const reloaded = await use2.findMany(FilterGroup.create())
			expect(reloaded).toHaveLength(20)
			await a2.disconnect()
		})

		test('writes from separate stale adapter instances merge against the latest file', async () => {
			const schema = Schema.from('items')
				.pk('id', v.string(), () => 'i')
				.field('val', v.number())
				.build()
			const first = JsonAdapter.create({ filePath })
			const second = JsonAdapter.create({ filePath })
			await first.connect()
			await second.connect()

			await first.use(schema, { table: 'items' }).createOne({ id: 'first', val: 1 })
			await second.use(schema, { table: 'items' }).createOne({ id: 'second', val: 2 })
			await first.disconnect()
			await second.disconnect()

			const reloaded = JsonAdapter.create({ filePath })
			await reloaded.connect()
			const rows = await reloaded.use(schema, { table: 'items' }).findMany(FilterGroup.create())
			expect(rows.map((row) => row.id).sort()).toEqual(['first', 'second'])
			await reloaded.disconnect()
		})

		test('stale read-only disconnect does not overwrite newer writes', async () => {
			const schema = Schema.from('items')
				.pk('id', v.string(), () => 'i')
				.field('val', v.number())
				.build()
			const staleReader = JsonAdapter.create({ filePath })
			await staleReader.connect()
			await staleReader.use(schema, { table: 'items' }).findMany(FilterGroup.create())

			const writer = JsonAdapter.create({ filePath })
			await writer.connect()
			await writer.use(schema, { table: 'items' }).createOne({ id: 'written', val: 1 })
			await writer.disconnect()
			await staleReader.disconnect()

			const reloaded = JsonAdapter.create({ filePath })
			await reloaded.connect()
			const rows = await reloaded.use(schema, { table: 'items' }).findMany(FilterGroup.create())
			expect(rows).toEqual([{ id: 'written', val: 1 }])
			await reloaded.disconnect()
		})
	})

	describe('json adapter — migration storage', () => {
		test('recordMigration + loadMigrations round-trip', async () => {
			const adapter = JsonAdapter.create({ filePath })
			await adapter.connect()

			await adapter.recordMigration('m-001', 1000)
			await adapter.recordMigration('m-002', 2000)

			const loaded = await adapter.loadMigrations()
			expect(loaded).toHaveLength(2)
			expect(loaded).toEqual([
				{ id: 'm-001', appliedAt: 1000 },
				{ id: 'm-002', appliedAt: 2000 },
			])
			await adapter.disconnect()
		})

		test('migration tracker persists across adapter restarts', async () => {
			const a1 = JsonAdapter.create({ filePath })
			await a1.connect()
			await a1.recordMigration('m-001', 1000)
			await a1.disconnect()

			const a2 = JsonAdapter.create({ filePath })
			await a2.connect()
			const loaded = await a2.loadMigrations()
			expect(loaded).toEqual([{ id: 'm-001', appliedAt: 1000 }])
			await a2.disconnect()
		})

		test('__migrations key in JSON file stores tracker data', async () => {
			const { readFile: rf } = await import('node:fs/promises')
			const adapter = JsonAdapter.create({ filePath })
			await adapter.connect()
			await adapter.recordMigration('m-001', 1000)
			await adapter.disconnect()

			const raw = JSON.parse(await rf(filePath, 'utf-8'))
			expect(raw['__migrations']).toEqual([{ id: 'm-001', appliedAt: 1000 }])
		})
	})

	describe('json adapter — apply* methods', () => {
		test('applyCreateTable persists table metadata', async () => {
			const adapter = JsonAdapter.create({ filePath })
			await adapter.connect()
			await adapter.applyCreateTable({
				kind: 'createTable',
				name: 'users',
				pk: { name: 'id', type: 'string' },
				fields: [{ name: 'email', type: 'string', unique: true }],
			})
			await adapter.disconnect()

			const a2 = JsonAdapter.create({ filePath })
			await a2.connect()
			const schemas = await a2.introspect()
			expect(schemas).toHaveLength(1)
			expect(schemas[0].name).toBe('users')
			expect(schemas[0].pk).toEqual({ name: 'id', type: 'string' })
			expect(schemas[0].fields).toEqual([{ name: 'email', type: 'string', nullable: false, unique: true }])
			await a2.disconnect()
		})

		test('applyAddIndex and applyDropIndex persist across restarts', async () => {
			const a1 = JsonAdapter.create({ filePath })
			await a1.connect()
			await a1.applyCreateTable({
				kind: 'createTable',
				name: 'users',
				pk: { name: 'id', type: 'string' },
				fields: [],
			})
			await a1.applyAddIndex({ kind: 'addIndex', table: 'users', on: ['email'], unique: true })
			await a1.disconnect()

			const a2 = JsonAdapter.create({ filePath })
			await a2.connect()
			const schemas = await a2.introspect()
			expect(schemas[0].indexes).toEqual([{ name: 'users_email_idx', on: ['email'], unique: true }])
			await a2.applyDropIndex({ kind: 'dropIndex', table: 'users', name: 'users_email_idx' })
			await a2.disconnect()

			const a3 = JsonAdapter.create({ filePath })
			await a3.connect()
			const schemas2 = await a3.introspect()
			expect(schemas2[0].indexes).toEqual([])
			await a3.disconnect()
		})

		test('applyAddForeignKey and applyDropForeignKey persist across restarts', async () => {
			const a1 = JsonAdapter.create({ filePath })
			await a1.connect()
			await a1.applyCreateTable({
				kind: 'createTable',
				name: 'users',
				pk: { name: 'id', type: 'string' },
				fields: [],
			})
			await a1.applyCreateTable({
				kind: 'createTable',
				name: 'posts',
				pk: { name: 'id', type: 'string' },
				fields: [],
			})
			await a1.applyAddForeignKey({
				kind: 'addForeignKey',
				table: 'posts',
				on: 'authorId',
				references: { table: 'users', column: 'id' },
				onDelete: 'cascade',
			})
			await a1.disconnect()

			const a2 = JsonAdapter.create({ filePath })
			await a2.connect()
			const schemas = await a2.introspect()
			const posts = schemas.find((s) => s.name === 'posts')!
			expect(posts.foreignKeys).toEqual([
				{
					name: 'posts_authorId_fk',
					on: 'authorId',
					references: { table: 'users', column: 'id' },
					onDelete: 'cascade',
				},
			])
			await a2.applyDropForeignKey({ kind: 'dropForeignKey', table: 'posts', name: 'posts_authorId_fk' })
			await a2.disconnect()

			const a3 = JsonAdapter.create({ filePath })
			await a3.connect()
			const schemas2 = await a3.introspect()
			const posts2 = schemas2.find((s) => s.name === 'posts')!
			expect(posts2.foreignKeys).toEqual([])
			await a3.disconnect()
		})
	})

	describe('json adapter — acquireMigrationLock', () => {
		test('file lock serialises concurrent calls', async () => {
			const adapter = JsonAdapter.create({ filePath })
			await adapter.connect()

			const order: string[] = []
			let resolveGate!: () => void
			const gate = new Promise<void>((r) => {
				resolveGate = r
			})

			const p1 = adapter.acquireMigrationLock(async () => {
				order.push('p1-start')
				await gate
				order.push('p1-end')
			})
			await new Promise((r) => setTimeout(r, 100))
			const p2 = adapter.acquireMigrationLock(async () => {
				order.push('p2')
			})

			await new Promise((r) => setTimeout(r, 100))
			expect(order).toEqual(['p1-start'])

			resolveGate()
			await Promise.all([p1, p2])
			expect(order).toEqual(['p1-start', 'p1-end', 'p2'])

			await adapter.disconnect()
		})

		test('lock file is cleaned up after successful execution', async () => {
			const { access } = await import('node:fs/promises')
			const adapter = JsonAdapter.create({ filePath })
			await adapter.connect()

			await adapter.acquireMigrationLock(async () => {
				/* no-op */
			})

			await expect(access(filePath + '.lock')).rejects.toThrow()
			await adapter.disconnect()
		})

		test('lock file is cleaned up after failed execution', async () => {
			const { access } = await import('node:fs/promises')
			const adapter = JsonAdapter.create({ filePath })
			await adapter.connect()

			await expect(
				adapter.acquireMigrationLock(async () => {
					throw new Error('boom')
				}),
			).rejects.toThrow('boom')

			await expect(access(filePath + '.lock')).rejects.toThrow()
			await adapter.disconnect()
		})
	})

	describe('json adapter — end-to-end migrations via Migrator', () => {
		const UserSchema = Schema.from('users')
			.pk('id', v.string(), () => `u-${Math.random().toString(36).slice(2)}`)
			.field('email', v.string())
			.build()

		function makeEnv() {
			const adapter = JsonAdapter.create({ filePath })
			const repo = new Repo({ adapter, resolve: (name) => ({ table: name }) })
			return { adapter, repo }
		}

		test('end-to-end migration run covering every declarative variant + execute', async () => {
			const { adapter, repo } = makeEnv()
			await adapter.connect()

			const migrations: Migration<typeof adapter>[] = [
				{
					id: '0001-create',
					changes: [
						{
							kind: 'createTable',
							name: 'users',
							pk: { name: 'id', type: 'string' },
							fields: [{ name: 'email', type: 'string' }],
						},
						{
							kind: 'createTable',
							name: 'posts',
							pk: { name: 'id', type: 'string' },
							fields: [
								{ name: 'title', type: 'string' },
								{ name: 'authorId', type: 'string' },
							],
						},
						{ kind: 'addIndex', table: 'users', on: ['email'], unique: true },
						{
							kind: 'addForeignKey',
							table: 'posts',
							on: 'authorId',
							references: { table: 'users', column: 'id' },
						},
					],
				},
				{
					id: '0002-evolve',
					changes: [
						{ kind: 'addField', table: 'users', field: { name: 'age', type: 'number', nullable: true } },
						{
							kind: 'modifyField',
							table: 'users',
							name: 'email',
							to: { name: 'email', type: 'string', unique: true, nullable: true },
						},
						{ kind: 'renameField', table: 'posts', from: 'title', to: 'headline' },
						{ kind: 'renameTable', from: 'posts', to: 'articles' },
					],
				},
				{
					id: '0003-cleanup',
					changes: [
						{ kind: 'dropField', table: 'users', name: 'age' },
						{ kind: 'dropForeignKey', table: 'posts', name: 'posts_authorId_fk' },
						{ kind: 'dropIndex', table: 'users', name: 'users_email_idx' },
						{ kind: 'dropTable', name: 'articles' },
					],
				},
				{
					id: '0004-seed',
					changes: [
						{
							kind: 'execute',
							up: async (r) => {
								await r.on(UserSchema).one().create({ id: 'seed-1', email: 'test@example.com' })
							},
						},
					],
				},
			]

			const migrator = Migrator.from(repo, adapter).migrations(migrations).build()
			const result = await migrator.up()
			expect(result.ran).toEqual(['0001-create', '0002-evolve', '0003-cleanup', '0004-seed'])

			const recorded = await adapter.loadMigrations()
			expect(recorded).toHaveLength(4)

			const row = await repo.on(UserSchema).one().id('seed-1').find()
			expect(row).not.toBeNull()
			expect(row!.email).toBe('test@example.com')

			// Verify via re-reading the file
			await adapter.disconnect()
			const { adapter: a2, repo: r2 } = makeEnv()
			await a2.connect()
			const recorded2 = await a2.loadMigrations()
			expect(recorded2).toHaveLength(4)

			const row2 = await r2.on(UserSchema).one().id('seed-1').find()
			expect(row2!.email).toBe('test@example.com')
			await a2.disconnect()
		})

		test('file lock serialises concurrent migrator.up() runs', async () => {
			const order: string[] = []
			let resolveGate!: () => void
			const gate = new Promise<void>((r) => {
				resolveGate = r
			})

			const migrations: Migration<JsonAdapter>[] = [
				{
					id: '0001',
					changes: [
						{
							kind: 'execute',
							up: async () => {
								order.push('0001-start')
								await gate
								order.push('0001-end')
							},
						},
					],
				},
				{
					id: '0002',
					changes: [
						{
							kind: 'execute',
							up: async () => {
								order.push('0002')
							},
						},
					],
				},
			]

			const adapter1 = JsonAdapter.create({ filePath })
			await adapter1.connect()
			const repo1 = new Repo({ adapter: adapter1, resolve: (name) => ({ table: name }) })
			const migrator1 = Migrator.from(repo1, adapter1).migrations(migrations).build()

			const adapter2 = JsonAdapter.create({ filePath })
			await adapter2.connect()
			const repo2 = new Repo({ adapter: adapter2, resolve: (name) => ({ table: name }) })
			const migrator2 = Migrator.from(repo2, adapter2).migrations(migrations).build()

			const p1 = migrator1.up()
			const p2 = migrator2.up()

			await new Promise((r) => setTimeout(r, 200))
			expect(order).toEqual(['0001-start'])

			resolveGate()
			await Promise.all([p1, p2])

			expect(order).toEqual(['0001-start', '0001-end', '0002'])

			await adapter1.disconnect()
			await adapter2.disconnect()
		})

		test('tx:true rollback leaves file unchanged on failure', async () => {
			const { adapter } = makeEnv()
			await adapter.connect()

			await adapter.applyCreateTable({
				kind: 'createTable',
				name: 'users',
				pk: { name: 'id', type: 'string' },
				fields: [],
			})
			await adapter.disconnect()

			const { adapter: a2, repo: r2 } = makeEnv()
			await a2.connect()

			const m: Migration<typeof a2> = {
				id: '0001-will-fail',
				changes: [
					{ kind: 'addIndex', table: 'users', on: ['email'] },
					{
						kind: 'execute',
						up: async (r) => {
							await r.on(UserSchema).one().create({ id: 'partial', email: 'fail@test.com' })
							throw new Error('mid-migration boom')
						},
					},
				],
			}
			const migrator = Migrator.from(r2, a2).migrations([m]).build()
			await expect(migrator.up()).rejects.toThrow(OrmMigrationError)
			await a2.disconnect()

			const { adapter: a3, repo: r3 } = makeEnv()
			await a3.connect()
			const recorded = await a3.loadMigrations()
			expect(recorded).toHaveLength(0)
			const schemas = await a3.introspect()
			const users = schemas.find((s) => s.name === 'users')!
			expect(users.indexes).toEqual([])
			const row = await r3.on(UserSchema).one().id('partial').find()
			expect(row).toBeNull()
			await a3.disconnect()
		})

		test('introspect() round-trip: apply* then introspect returns matching descriptors', async () => {
			const adapter = JsonAdapter.create({ filePath })
			await adapter.connect()

			await adapter.applyCreateTable({
				kind: 'createTable',
				name: 'users',
				pk: { name: 'id', type: 'string' },
				fields: [
					{ name: 'email', type: 'string', unique: true },
					{ name: 'age', type: 'number', nullable: true },
				],
			})
			await adapter.applyAddIndex({ kind: 'addIndex', table: 'users', on: ['email'], unique: true })
			await adapter.applyCreateTable({
				kind: 'createTable',
				name: 'posts',
				pk: { name: 'id', type: 'string' },
				fields: [{ name: 'authorId', type: 'string' }],
			})
			await adapter.applyAddForeignKey({
				kind: 'addForeignKey',
				table: 'posts',
				on: 'authorId',
				references: { table: 'users', column: 'id' },
				onDelete: 'cascade',
			})
			await adapter.disconnect()

			const a2 = JsonAdapter.create({ filePath })
			await a2.connect()
			const schemas = await a2.introspect()

			const users = schemas.find((s) => s.name === 'users')!
			expect(users.pk).toEqual({ name: 'id', type: 'string' })
			expect(users.fields).toEqual([
				{ name: 'email', type: 'string', nullable: false, unique: true },
				{ name: 'age', type: 'number', nullable: true },
			])
			expect(users.indexes).toEqual([{ name: 'users_email_idx', on: ['email'], unique: true }])

			const posts = schemas.find((s) => s.name === 'posts')!
			expect(posts.pk).toEqual({ name: 'id', type: 'string' })
			expect(posts.fields).toEqual([{ name: 'authorId', type: 'string', nullable: false }])
			expect(posts.foreignKeys).toEqual([
				{
					name: 'posts_authorId_fk',
					on: 'authorId',
					references: { table: 'users', column: 'id' },
					onDelete: 'cascade',
				},
			])

			await a2.disconnect()
		})

		test('metadata keys do not leak into data stores', async () => {
			const adapter = JsonAdapter.create({ filePath })
			await adapter.connect()
			await adapter.recordMigration('m-001', 1000)
			await adapter.applyCreateTable({
				kind: 'createTable',
				name: 'users',
				pk: { name: 'id', type: 'string' },
				fields: [],
			})

			expect(adapter.stores.has('__migrations')).toBe(false)
			expect(adapter.stores.has('__tables')).toBe(false)
			await adapter.disconnect()

			const a2 = JsonAdapter.create({ filePath })
			await a2.connect()
			expect(a2.stores.has('__migrations')).toBe(false)
			expect(a2.stores.has('__tables')).toBe(false)
			await a2.disconnect()
		})
	})
}
