import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

import { MongoClient, type ClientSession, type MongoClientOptions, type OptionalUnlessRequiredId } from 'mongodb'
import { v, type PipeOutput } from 'valleyed'

import { EquippedError } from '../../../errors/index.js'
import { configurable } from '../../../utilities/configurable.js'
import type { FilterGroup } from '../../filter.js'
import type { DiscoveredSchema } from '../../migrations/introspection-types.js'
import type { AddIndexChange, DropIndexChange } from '../../migrations/types.js'
import { OrmAdapter, type AggregateSpec } from '../../orm-adapter.js'
import type { IterationQueryOptions, QueryOptions } from '../../query-options.js'
import type { AnySchema } from '../../schema.js'
import type { AnyUpdateOp } from '../../updates.js'
import {
	compileMongoAggregate,
	compileMongoFilter,
	compileMongoOps,
	compileMongoQuery,
	compileMongoUpdate,
} from './query.js'

const mongoSchemaConfigPipe = () => v.object({ db: v.string(), col: v.string() })
export type MongoDbRepoConfig = PipeOutput<ReturnType<typeof mongoSchemaConfigPipe>>

const mongoConnectionPipe = () =>
	v.object({
		uri: v.string(),
	})

const MIGRATION_TRACKER_COLLECTION = '_equipped_migrations'
const MIGRATION_LOCK_COLLECTION = '_equipped_migration_locks'
const MIGRATION_LOCK_POLL_MS = 100
const MIGRATION_LOCK_TIMEOUT_MS = 10_000

export class MongoDbAdapter extends configurable(mongoConnectionPipe, OrmAdapter) {
	readonly schemaConfigPipe = mongoSchemaConfigPipe()

	readonly queryableOps = [
		'eq',
		'ne',
		'gt',
		'gte',
		'lt',
		'lte',
		'in',
		'notIn',
		'like',
		'exists',
		'notExists',
		'contains',
		'notContains',
	] as const
	readonly updateOps = ['set', 'inc', 'mul', 'min', 'max', 'unset', 'push', 'pull', 'patch'] as const
	readonly aggregateOps = ['count', 'countDistinct', 'sum', 'avg', 'min', 'max'] as const
	readonly supportedFieldTypes = ['string', 'number', 'boolean', 'null', 'object', 'array', 'date'] as const

	readonly client: MongoClient
	readonly #sessionStore = new AsyncLocalStorage<ClientSession | undefined>()

	protected constructor(config: typeof MongoDbAdapter.Config, options?: MongoClientOptions) {
		super(config)
		this.client = new MongoClient(config.uri, {
			...options,
			ignoreUndefined: true,
		})
	}

	#getCollection(schemaCfg: MongoDbRepoConfig) {
		return this.client.db(schemaCfg.db).collection(schemaCfg.col)
	}

	async connect() {
		try {
			await this.client.connect()
		} catch (error) {
			throw new EquippedError('Failed to connect MongoDB client', { adapter: 'mongodb' }, error)
		}
	}

	async disconnect() {
		try {
			await this.client.close()
		} catch (error) {
			throw new EquippedError('Failed to disconnect MongoDB client', { adapter: 'mongodb' }, error)
		}
	}

	async findByPk(schema: AnySchema, config: unknown, pk: unknown) {
		const schemaCfg = config as MongoDbRepoConfig
		try {
			const pkName = schema.pkField.name
			const collection = this.#getCollection(schemaCfg)
			const doc = await collection.findOne({ [pkName]: pk }, { session: this.#sessionStore.getStore() })
			return doc as Record<string, unknown> | null
		} catch (error) {
			throw new EquippedError(
				'MongoDB findByPk failed',
				{ adapter: 'mongodb', operation: 'findByPk', collection: schemaCfg.col },
				error,
			)
		}
	}

	async createMany(_schema: AnySchema, config: unknown, data: Record<string, unknown>[]) {
		const schemaCfg = config as MongoDbRepoConfig
		try {
			const collection = this.#getCollection(schemaCfg)
			const docs = data.map((d) => d as OptionalUnlessRequiredId<any>)
			await collection.insertMany(docs, { session: this.#sessionStore.getStore() })
			return data
		} catch (error) {
			throw new EquippedError(
				'MongoDB createMany failed',
				{ adapter: 'mongodb', operation: 'createMany', collection: schemaCfg.col },
				error,
			)
		}
	}

	async updateByPk(schema: AnySchema, config: unknown, pk: unknown, ops: AnyUpdateOp[]) {
		const schemaCfg = config as MongoDbRepoConfig
		try {
			const pkName = schema.pkField.name
			const collection = this.#getCollection(schemaCfg)
			const update = compileMongoOps(ops)
			if (Object.keys(update).length === 0) {
				return (await collection.findOne(
					{ [pkName]: pk },
					{ session: this.#sessionStore.getStore() },
				)) as Record<string, unknown> | null
			}
			return (await collection.findOneAndUpdate({ [pkName]: pk }, update, {
				returnDocument: 'after',
				session: this.#sessionStore.getStore(),
			})) as Record<string, unknown> | null
		} catch (error) {
			throw new EquippedError(
				'MongoDB updateByPk failed',
				{ adapter: 'mongodb', operation: 'updateByPk', collection: schemaCfg.col },
				error,
			)
		}
	}

	async deleteByPk(schema: AnySchema, config: unknown, pk: unknown) {
		const schemaCfg = config as MongoDbRepoConfig
		try {
			const pkName = schema.pkField.name
			const collection = this.#getCollection(schemaCfg)
			return (await collection.findOneAndDelete(
				{ [pkName]: pk },
				{ session: this.#sessionStore.getStore() },
			)) as Record<string, unknown> | null
		} catch (error) {
			throw new EquippedError(
				'MongoDB deleteByPk failed',
				{ adapter: 'mongodb', operation: 'deleteByPk', collection: schemaCfg.col },
				error,
			)
		}
	}

	async raw(_schema: AnySchema, config: unknown, pipeline: Record<string, unknown>[]) {
		const schemaCfg = config as MongoDbRepoConfig
		try {
			const collection = this.#getCollection(schemaCfg)
			const result = await collection.aggregate(pipeline, { session: this.#sessionStore.getStore() }).toArray()
			return result
		} catch (error) {
			if (error instanceof EquippedError) throw error
			throw new EquippedError(
				'MongoDB raw failed',
				{ adapter: 'mongodb', operation: 'raw', collection: schemaCfg.col },
				error,
			)
		}
	}

	async aggregate(schema: AnySchema, config: unknown, spec: AggregateSpec): Promise<Array<Record<string, unknown>>> {
		const schemaCfg = config as MongoDbRepoConfig
		try {
			const pk = schema.pkField.name
			const collection = this.#getCollection(schemaCfg)
			const pipeline = compileMongoAggregate(spec, pk)
			const result = await collection.aggregate(pipeline, { session: this.#sessionStore.getStore() }).toArray()
			return result as Array<Record<string, unknown>>
		} catch (error) {
			if (error instanceof EquippedError) throw error
			throw new EquippedError(
				'MongoDB aggregate failed',
				{ adapter: 'mongodb', operation: 'aggregate', collection: schemaCfg.col },
				error,
			)
		}
	}

	async findMany(schema: AnySchema, config: unknown, filter: FilterGroup, options?: QueryOptions) {
		const schemaCfg = config as MongoDbRepoConfig
		try {
			const pk = schema.pkField.name
			const { filter: mongoFilter, sort, limit, skip, projection } = compileMongoQuery(filter, options, pk)
			const collection = this.#getCollection(schemaCfg)

			let cursor = collection.find(mongoFilter, {
				session: this.#sessionStore.getStore(),
				projection,
			})
			if (sort) cursor = cursor.sort(sort)
			if (limit) cursor = cursor.limit(limit)
			if (skip) cursor = cursor.skip(skip)

			return await cursor.toArray()
		} catch (error) {
			throw new EquippedError(
				'MongoDB findMany failed',
				{ adapter: 'mongodb', operation: 'findMany', collection: schemaCfg.col },
				error,
			)
		}
	}

	async count(schema: AnySchema, config: unknown, filter: FilterGroup) {
		const schemaCfg = config as MongoDbRepoConfig
		try {
			const pk = schema.pkField.name
			const collection = this.#getCollection(schemaCfg)
			return await collection.countDocuments(compileMongoFilter(filter, pk), {
				session: this.#sessionStore.getStore(),
			})
		} catch (error) {
			throw new EquippedError(
				'MongoDB count failed',
				{ adapter: 'mongodb', operation: 'count', collection: schemaCfg.col },
				error,
			)
		}
	}

	async *iterateMany(schema: AnySchema, config: unknown, filter: FilterGroup, options?: IterationQueryOptions) {
		const schemaCfg = config as MongoDbRepoConfig
		let cursor: any
		try {
			const pk = schema.pkField.name
			const { filter: mongoFilter, sort, limit, skip, projection } = compileMongoQuery(filter, options, pk)
			const collection = this.#getCollection(schemaCfg)

			cursor = collection.find(mongoFilter, {
				session: this.#sessionStore.getStore(),
				projection,
			})
			if (sort) cursor = cursor.sort(sort)
			if (limit) cursor = cursor.limit(limit)
			if (skip) cursor = cursor.skip(skip)
			if (options?.batchSize !== undefined) cursor = cursor.batchSize(options.batchSize)

			for await (const row of cursor) {
				yield row as Record<string, unknown>
			}
		} catch (error) {
			throw new EquippedError(
				'MongoDB iterateMany failed',
				{ adapter: 'mongodb', operation: 'iterateMany', collection: schemaCfg.col },
				error,
			)
		} finally {
			await cursor?.close()
		}
	}

	async updateMany(schema: AnySchema, config: unknown, filter: FilterGroup, data: Record<string, unknown>) {
		const schemaCfg = config as MongoDbRepoConfig
		try {
			const pk = schema.pkField.name
			const collection = this.#getCollection(schemaCfg)
			const session = this.#sessionStore.getStore()
			const mongoFilter = compileMongoFilter(filter, pk)

			const matchingDocs = await collection.find(mongoFilter, { session, projection: { [pk]: 1 } }).toArray()
			const ids = matchingDocs.map((d) => d[pk])
			const idFilter = { [pk]: { $in: ids } }

			const update = compileMongoUpdate(data)
			if (Object.keys(update).length > 0) {
				await collection.updateMany(idFilter, update, { session })
			}

			return await collection.find({ [pk]: { $in: ids } }, { session }).toArray()
		} catch (error) {
			throw new EquippedError(
				'MongoDB updateMany failed',
				{ adapter: 'mongodb', operation: 'updateMany', collection: schemaCfg.col },
				error,
			)
		}
	}

	async deleteMany(schema: AnySchema, config: unknown, filter: FilterGroup) {
		const schemaCfg = config as MongoDbRepoConfig
		try {
			const pk = schema.pkField.name
			const collection = this.#getCollection(schemaCfg)
			const session = this.#sessionStore.getStore()
			const mongoFilter = compileMongoFilter(filter, pk)

			const docs = await collection.find(mongoFilter, { session }).toArray()
			if (docs.length > 0) {
				await collection.deleteMany(mongoFilter, { session })
			}
			return docs
		} catch (error) {
			throw new EquippedError(
				'MongoDB deleteMany failed',
				{ adapter: 'mongodb', operation: 'deleteMany', collection: schemaCfg.col },
				error,
			)
		}
	}

	async upsertOne(
		schema: AnySchema,
		config: unknown,
		filter: FilterGroup,
		create: Record<string, unknown>,
		ops: AnyUpdateOp[],
	) {
		const schemaCfg = config as MongoDbRepoConfig
		try {
			const pk = schema.pkField.name
			const collection = this.#getCollection(schemaCfg)
			const mongoFilter = compileMongoFilter(filter, pk)

			const updateDoc = compileMongoOps(ops)
			const doc = await collection.findOneAndUpdate(
				mongoFilter,
				{
					...updateDoc,
					$setOnInsert: create,
				},
				{
					returnDocument: 'after',
					session: this.#sessionStore.getStore(),
					upsert: true,
				},
			)

			return doc as Record<string, unknown>
		} catch (error) {
			throw new EquippedError(
				'MongoDB upsertOne failed',
				{ adapter: 'mongodb', operation: 'upsertOne', collection: schemaCfg.col },
				error,
			)
		}
	}

	async session<T>(fn: () => Promise<T>): Promise<T> {
		if (this.#sessionStore.getStore()) return fn()
		try {
			const session = await this.client.startSession()
			try {
				return await session.withTransaction(async () => this.#sessionStore.run(session, fn))
			} finally {
				await session.endSession()
			}
		} catch (error) {
			if (error instanceof EquippedError) throw error
			throw new EquippedError('MongoDB session failed', { adapter: 'mongodb', operation: 'session' }, error)
		}
	}

	async loadMigrations(config: MongoDbRepoConfig): Promise<{ id: string; appliedAt: number }[]> {
		const db = this.client.db(config.db)
		const docs = await db.collection(config.col).find({}, { session: this.#sessionStore.getStore() }).toArray()
		return docs.map((d) => ({ id: String(d._id), appliedAt: d.appliedAt as number }))
	}

	async recordMigration(config: MongoDbRepoConfig, id: string, appliedAt: number): Promise<void> {
		const db = this.client.db(config.db)
		await db
			.collection(config.col)
			.insertOne({ _id: id as any, appliedAt }, { session: this.#sessionStore.getStore() })
	}

	async acquireMigrationLock<T>(config: MongoDbRepoConfig, fn: () => Promise<T>): Promise<T> {
		const collection = this.client.db(config.db).collection(MIGRATION_LOCK_COLLECTION)
		const lockId = this.physicalTargetIdentity(config)
		const owner = randomUUID()
		const deadline = Date.now() + MIGRATION_LOCK_TIMEOUT_MS

		for (;;) {
			try {
				await collection.insertOne({ _id: lockId as any, owner })
				break
			} catch (error) {
				if (!(error && typeof error === 'object' && 'code' in error && error.code === 11000)) throw error
				if (Date.now() >= deadline) {
					throw new Error(`Timed out acquiring MongoDB migration lock for ${lockId}`)
				}
				await new Promise((resolve) => setTimeout(resolve, MIGRATION_LOCK_POLL_MS))
			}
		}

		try {
			return await fn()
		} finally {
			await collection.deleteOne({ _id: lockId as any, owner })
		}
	}

	async applyAddIndex(change: AddIndexChange, target?: unknown): Promise<void> {
		const config = (target as MongoDbRepoConfig | undefined) ?? {
			db: this.client.db().databaseName,
			col: change.table,
		}
		const db = this.client.db(config.db)
		const fields: Record<string, 1> = {}
		for (const f of change.on) {
			fields[f] = 1
		}
		const name = change.name ?? `${config.col}_${change.on.join('_')}_idx`
		await db.collection(config.col).createIndex(fields, { unique: change.unique ?? false, name })
	}

	async applyDropIndex(change: DropIndexChange, target?: unknown): Promise<void> {
		const config = (target as MongoDbRepoConfig | undefined) ?? {
			db: this.client.db().databaseName,
			col: change.table,
		}
		const collection = this.client.db(config.db).collection(config.col)
		const indexes = await collection.listIndexes().toArray()
		if (indexes.some((idx) => idx.name === change.name)) await collection.dropIndex(change.name)
	}

	physicalTargetIdentity(config: MongoDbRepoConfig): string {
		return JSON.stringify([config.db, config.col])
	}

	async introspectTarget(config: MongoDbRepoConfig): Promise<DiscoveredSchema | null> {
		const db = this.client.db(config.db)
		const collections = await db.listCollections({ name: config.col }).toArray()
		if (!collections.some((collection) => collection.name === config.col)) return null

		const rawIndexes = await db.collection(config.col).listIndexes().toArray()
		return {
			name: config.col,
			pk: undefined,
			fields: [],
			indexes: rawIndexes
				.filter((index) => index.name !== '_id_')
				.map((index) => ({
					name: index.name as string,
					on: Object.keys(index.key as Record<string, unknown>) as ReadonlyArray<string>,
					unique: !!index.unique,
				})),
			foreignKeys: [],
		}
	}

	async introspect(): Promise<DiscoveredSchema[]> {
		const db = this.client.db()
		const collections = await db.listCollections().toArray()
		const schemas: DiscoveredSchema[] = []
		for (const col of collections) {
			if (col.name === MIGRATION_TRACKER_COLLECTION || col.name === MIGRATION_LOCK_COLLECTION) continue
			const rawIndexes = await db.collection(col.name).listIndexes().toArray()
			const indexes = rawIndexes
				.filter((idx) => idx.name !== '_id_')
				.map((idx) => ({
					name: idx.name as string,
					on: Object.keys(idx.key as Record<string, unknown>) as ReadonlyArray<string>,
					unique: !!idx.unique,
				}))
			schemas.push({
				name: col.name,
				pk: undefined,
				fields: [],
				indexes,
				foreignKeys: [],
			})
		}
		return schemas
	}
}

if (import.meta.vitest) {
	const { describe, test, expect, expectTypeOf, vi } = import.meta.vitest

	describe('MongoDbAdapter: class-via-configurable shape', () => {
		test('MongoDbAdapter.create validates connection config via pipe', () => {
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017' })
			expect(adapter).toBeInstanceOf(MongoDbAdapter)
			expect(adapter.client).toBeInstanceOf(MongoClient)
		})

		test('MongoDbAdapter.create rejects invalid config', () => {
			expect(() => MongoDbAdapter.create({} as any)).toThrow()
			expect(() => MongoDbAdapter.create({ uri: 123 } as any)).toThrow()
		})

		test('readonly schemaConfigPipe declared with { db, col } shape', () => {
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017' })
			expect(adapter.schemaConfigPipe).toBeDefined()
		})

		test('capability declarations use as const', () => {
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017' })

			expect(adapter.supportedFieldTypes).toEqual([
				'string',
				'number',
				'boolean',
				'null',
				'object',
				'array',
				'date',
			])
			expect(adapter.queryableOps).toEqual([
				'eq',
				'ne',
				'gt',
				'gte',
				'lt',
				'lte',
				'in',
				'notIn',
				'like',
				'exists',
				'notExists',
				'contains',
				'notContains',
			])
			expect(adapter.updateOps).toEqual(['set', 'inc', 'mul', 'min', 'max', 'unset', 'push', 'pull', 'patch'])
			expect(adapter.aggregateOps).toEqual(['count', 'countDistinct', 'sum', 'avg', 'min', 'max'])
		})

		test('underlying MongoClient exposed as readonly instance field', () => {
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017' })
			expect(adapter.client).toBeInstanceOf(MongoClient)
		})

		test('adapter.use returns OrmUse-shaped object', async () => {
			const { Schema } = await import('../../schema.js')
			const { v } = await import('valleyed')
			const schema = Schema.from('test')
				.pk('id', v.string(), () => 'x')
				.build()
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017' })
			const use = adapter.use(schema, { db: 'testdb', col: 'testcol' })

			expect(use.findMany).toBeTypeOf('function')
			expect(use.iterateMany).toBeTypeOf('function')
			expect(use.findOne).toBeTypeOf('function')
			expect(use.count).toBeTypeOf('function')
			expect(use.createOne).toBeTypeOf('function')
			expect(use.createMany).toBeTypeOf('function')
			expect(use.updateMany).toBeTypeOf('function')
			expect(use.updateOne).toBeTypeOf('function')
			expect(use.upsertOne).toBeTypeOf('function')
			expect(use.deleteOne).toBeTypeOf('function')
			expect(use.deleteMany).toBeTypeOf('function')
			expect(use.raw).toBeTypeOf('function')
		})

		test('type-level: adapter declares all 9 canonical update ops', () => {
			const _adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017' })
			type Ops = typeof _adapter.updateOps
			expectTypeOf<Ops>().toEqualTypeOf<
				readonly ['set', 'inc', 'mul', 'min', 'max', 'unset', 'push', 'pull', 'patch']
			>()
		})

		test('type-level: adapter declares all 7 field types', () => {
			const _adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017' })
			type Types = typeof _adapter.supportedFieldTypes
			expectTypeOf<Types>().toEqualTypeOf<
				readonly ['string', 'number', 'boolean', 'null', 'object', 'array', 'date']
			>()
		})

		test('type-level: adapter declares all 13 queryable ops', () => {
			const _adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017' })
			type Ops = typeof _adapter.queryableOps
			expectTypeOf<Ops>().toEqualTypeOf<
				readonly [
					'eq',
					'ne',
					'gt',
					'gte',
					'lt',
					'lte',
					'in',
					'notIn',
					'like',
					'exists',
					'notExists',
					'contains',
					'notContains',
				]
			>()
		})

		test('type-level: Repo.from with MongoDbAdapter enables all builder methods', async () => {
			const { Repo } = await import('../../repo/repo.js')
			const { Schema } = await import('../../schema.js')
			const { v } = await import('valleyed')
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017' })
			const repo = Repo.from(adapter)
				.resolve(() => ({ db: 'test', col: 'test' }))
				.build()
			const _TestSchema = Schema.from('test')
				.pk('id', v.string(), () => 'x')
				.build()

			const _one = repo.on(_TestSchema).one()
			const _all = repo.on(_TestSchema).all()
			const _ref = repo.on(_TestSchema)
			expectTypeOf(_one.create).toBeFunction()
			expectTypeOf(_one.find).toBeFunction()
			expectTypeOf(_one.update).toBeFunction()
			expectTypeOf(_one.delete).toBeFunction()
			expectTypeOf(_one.upsert).toBeFunction()
			expectTypeOf(_all.create).toBeFunction()
			expectTypeOf(_all.find).toBeFunction()
			expectTypeOf(_all.count).toBeFunction()
			expectTypeOf(_all.update).toBeFunction()
			expectTypeOf(_all.delete).toBeFunction()
			expectTypeOf(_ref.raw).toBeFunction()
			expectTypeOf(repo.session).toBeFunction()
		})

		test('type-level: raw arg-tuple infers (pipeline: Record<string, unknown>[]) from MongoDbAdapter', async () => {
			const { Repo } = await import('../../repo/repo.js')
			const { Schema } = await import('../../schema.js')
			const { v } = await import('valleyed')
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017' })
			const repo = Repo.from(adapter)
				.resolve(() => ({ db: 'test', col: 'test' }))
				.build()
			const _TestSchema = Schema.from('test')
				.pk('id', v.string(), () => 'x')
				.build()
			const _ref = repo.on(_TestSchema)

			expectTypeOf(_ref.raw).parameters.toEqualTypeOf<[pipeline: Record<string, unknown>[]]>()
		})

		test('type-level: per-call <T> override narrows MongoDbAdapter raw return type', async () => {
			const { Repo } = await import('../../repo/repo.js')
			const { Schema } = await import('../../schema.js')
			const { v } = await import('valleyed')
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017' })
			const repo = Repo.from(adapter)
				.resolve(() => ({ db: 'test', col: 'test' }))
				.build()
			const _TestSchema = Schema.from('test')
				.pk('id', v.string(), () => 'x')
				.build()
			const _ref = repo.on(_TestSchema)

			expectTypeOf(_ref.raw<{ total: number }[]>).returns.toEqualTypeOf<Promise<{ total: number }[]>>()
		})

		test('count forwards compiled filter to collection.countDocuments', async () => {
			const { Schema } = await import('../../schema.js')
			const { v } = await import('valleyed')
			const { FilterGroup } = await import('../../filter.js')
			const schema = Schema.from('mongo_count')
				.pk('_id', v.string(), () => 'x')
				.field('name', v.string())
				.build()
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017' })
			let capturedFilter: unknown
			;(adapter.client as any).db = () => ({
				collection: () => ({
					countDocuments: async (filter: unknown, _opts: unknown) => {
						capturedFilter = filter
						return 7
					},
				}),
			})

			const result = await adapter.count(
				schema,
				{ db: 'testdb', col: 'things' },
				FilterGroup.create().eq('name', 'Alice'),
			)
			expect(capturedFilter).toEqual({ name: { $eq: 'Alice' } })
			expect(result).toBe(7)
		})

		test('raw forwards pipeline to collection.aggregate at runtime', async () => {
			const { Schema } = await import('../../schema.js')
			const { v } = await import('valleyed')
			const schema = Schema.from('mongo_raw')
				.pk('id', v.string(), () => 'x')
				.build()
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017' })
			let capturedPipeline: unknown
			const mockResults = [{ total: 42 }]
			;(adapter.client as any).db = () => ({
				collection: () => ({
					aggregate: (pipeline: unknown, _opts: unknown) => {
						capturedPipeline = pipeline
						return { toArray: async () => mockResults }
					},
				}),
			})
			const result = await adapter.use(schema, { db: 'testdb', col: 'things' }).raw([{ $count: 'total' }])
			expect(capturedPipeline).toEqual([{ $count: 'total' }])
			expect(result).toEqual(mockResults)
		})

		test('iterateMany forwards batchSize and closes cursor on early return', async () => {
			const { Schema } = await import('../../schema.js')
			const { v } = await import('valleyed')
			const { FilterGroup } = await import('../../filter.js')
			const { OrderBy } = await import('../../query-options.js')
			const schema = Schema.from('mongo_iter')
				.pk('_id', v.string(), () => 'x')
				.field('age', v.number())
				.build()
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017' })
			let capturedFindFilter: unknown
			let capturedFindOptions: unknown
			let capturedSort: unknown
			let capturedLimit: unknown
			let capturedSkip: unknown
			let capturedBatchSize: unknown
			let closeCalls = 0
			const cursor = {
				sort(sort: unknown) {
					capturedSort = sort
					return this
				},
				limit(limit: unknown) {
					capturedLimit = limit
					return this
				},
				skip(skip: unknown) {
					capturedSkip = skip
					return this
				},
				batchSize(batchSize: unknown) {
					capturedBatchSize = batchSize
					return this
				},
				async close() {
					closeCalls += 1
				},
				async *[Symbol.asyncIterator]() {
					yield { _id: 'u4', age: 50 }
					yield { _id: 'u3', age: 40 }
				},
			}
			;(adapter.client as any).db = () => ({
				collection: () => ({
					find: (filter: unknown, options: unknown) => {
						capturedFindFilter = filter
						capturedFindOptions = options
						return cursor
					},
				}),
			})

			const rows: Record<string, unknown>[] = []
			for await (const row of adapter
				.use(schema, { db: 'testdb', col: 'people' })
				.iterateMany(FilterGroup.create().gt('age', 19), {
					orderBy: [new OrderBy('age', 'desc')],
					offset: 1,
					limit: 2,
					batchSize: 25,
				})) {
				rows.push(row)
				break
			}

			expect(capturedFindFilter).toEqual({ age: { $gt: 19 } })
			expect(capturedFindOptions).toEqual({ session: undefined, projection: undefined })
			expect(capturedSort).toEqual({ age: -1 })
			expect(capturedLimit).toBe(2)
			expect(capturedSkip).toBe(1)
			expect(capturedBatchSize).toBe(25)
			expect(rows).toEqual([{ _id: 'u4', age: 50 }])
			expect(closeCalls).toBe(1)
		})

		test('iterateMany closes cursor on normal completion', async () => {
			const { Schema } = await import('../../schema.js')
			const { v } = await import('valleyed')
			const { FilterGroup } = await import('../../filter.js')
			const schema = Schema.from('mongo_iter_complete')
				.pk('_id', v.string(), () => 'x')
				.field('age', v.number())
				.build()
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017' })
			let closeCalls = 0
			const cursor = {
				async close() {
					closeCalls += 1
				},
				async *[Symbol.asyncIterator]() {
					yield { _id: 'u1', age: 30 }
					yield { _id: 'u2', age: 40 }
				},
			}
			;(adapter.client as any).db = () => ({
				collection: () => ({
					find: () => cursor,
				}),
			})

			const rows: Record<string, unknown>[] = []
			for await (const row of adapter
				.use(schema, { db: 'testdb', col: 'people' })
				.iterateMany(FilterGroup.create())) {
				rows.push(row)
			}

			expect(rows).toEqual([
				{ _id: 'u1', age: 30 },
				{ _id: 'u2', age: 40 },
			])
			expect(closeCalls).toBe(1)
		})

		test('nested session returns callback without starting new transaction', () => {
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017' })
			expect(adapter.session).toBeTypeOf('function')
		})

		test('type-level: adapter declares all 6 canonical aggregate ops', () => {
			const _adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017' })
			type Ops = typeof _adapter.aggregateOps
			expectTypeOf<Ops>().toEqualTypeOf<readonly ['count', 'countDistinct', 'sum', 'avg', 'min', 'max']>()
		})

		test('type-level: Repo.from with MongoDbAdapter enables aggregate method', async () => {
			const { Repo } = await import('../../repo/repo.js')
			const { Schema } = await import('../../schema.js')
			const { v } = await import('valleyed')
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017' })
			const repo = Repo.from(adapter)
				.resolve(() => ({ db: 'test', col: 'test' }))
				.build()
			const _TestSchema = Schema.from('test')
				.pk('id', v.string(), () => 'x')
				.build()
			const _ref = repo.on(_TestSchema)
			expectTypeOf(_ref.aggregate).toBeFunction()
		})

		test('aggregate forwards compiled pipeline to collection.aggregate', async () => {
			const { Schema } = await import('../../schema.js')
			const { v } = await import('valleyed')
			const schema = Schema.from('mongo_agg')
				.pk('_id', v.string(), () => 'x')
				.field('amount', v.number())
				.build()
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017' })
			let capturedPipeline: unknown
			const mockResults = [{ total: 3, revenue: 150 }]
			;(adapter.client as any).db = () => ({
				collection: () => ({
					aggregate: (pipeline: unknown, _opts: unknown) => {
						capturedPipeline = pipeline
						return { toArray: async () => mockResults }
					},
				}),
			})
			const result = await adapter.aggregate(
				schema,
				{ db: 'testdb', col: 'orders' },
				{
					aggregates: [
						{ fn: 'count', alias: 'total' },
						{ fn: 'sum', field: 'amount', alias: 'revenue' },
					],
					groupBy: [],
				},
			)
			expect(capturedPipeline).toEqual([
				{ $group: { _id: null, total: { $sum: 1 }, revenue: { $sum: '$amount' } } },
				{ $project: { _id: 0, total: 1, revenue: 1 } },
			])
			expect(result).toEqual(mockResults)
		})

		test('aggregate with where and groupBy produces correct pipeline', async () => {
			const { Schema } = await import('../../schema.js')
			const { v } = await import('valleyed')
			const { FilterGroup } = await import('../../filter.js')
			const schema = Schema.from('mongo_agg2')
				.pk('_id', v.string(), () => 'x')
				.field('region', v.string())
				.field('amount', v.number())
				.build()
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017' })
			let capturedPipeline: unknown
			;(adapter.client as any).db = () => ({
				collection: () => ({
					aggregate: (pipeline: unknown, _opts: unknown) => {
						capturedPipeline = pipeline
						return { toArray: async () => [{ region: 'US', total: 2 }] }
					},
				}),
			})
			await adapter.aggregate(
				schema,
				{ db: 'testdb', col: 'orders' },
				{
					where: FilterGroup.create().gt('amount', 10),
					aggregates: [{ fn: 'count', alias: 'total' }],
					groupBy: ['region'],
				},
			)
			expect(capturedPipeline).toEqual([
				{ $match: { amount: { $gt: 10 } } },
				{ $group: { _id: { region: '$region' }, total: { $sum: 1 } } },
				{ $project: { _id: 0, region: '$_id.region', total: 1 } },
			])
		})

		test('auto-wires Instance hooks for connect/disconnect', async () => {
			const { Instance: Inst } = await import('../../../instance/index.js')
			const { vi } = await import('vitest')
			const onSpy = vi.spyOn(Inst, 'on').mockImplementation(() => {})

			MongoDbAdapter.create({ uri: 'mongodb://localhost:27017' })

			expect(onSpy).toHaveBeenCalledWith(
				'start',
				expect.any(Function),
				expect.objectContaining({ class: MongoDbAdapter }),
			)
			expect(onSpy).toHaveBeenCalledWith(
				'close',
				expect.any(Function),
				expect.objectContaining({ class: MongoDbAdapter }),
			)

			onSpy.mockRestore()
		})
	})

	describe('MongoDbAdapter: migrations', () => {
		test('history uses the resolved database and collection and records with the active session', async () => {
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017/default' })
			const session = { id: 'active-session' }
			const calls: Array<{ db: string; col: string; operation: string; options?: unknown }> = []
			;(adapter.client as any).db = (db: string) => ({
				collection: (col: string) => ({
					find: (_filter: unknown, options: unknown) => ({
						toArray: async () => {
							calls.push({ db, col, operation: 'find', options })
							return [{ _id: '0001', appliedAt: 123 }]
						},
					}),
					insertOne: async (_doc: unknown, options: unknown) => {
						calls.push({ db, col, operation: 'insert', options })
					},
				}),
			})
			;(adapter.client as any).startSession = () =>
				Object.assign(session, {
					withTransaction: (fn: () => Promise<unknown>) => fn(),
					endSession: async () => {},
				})

			await adapter.session(async () => {
				expect(await adapter.loadMigrations({ db: 'tenant', col: 'tenant_history' })).toEqual([
					{ id: '0001', appliedAt: 123 },
				])
				await adapter.recordMigration({ db: 'tenant', col: 'tenant_history' }, '0002', 456)
			})

			expect(calls).toEqual([
				{ db: 'tenant', col: 'tenant_history', operation: 'find', options: { session } },
				{ db: 'tenant', col: 'tenant_history', operation: 'insert', options: { session } },
			])
		})

		test('lock acquisition atomically inserts a scoped owner token and releases only that owner', async () => {
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017/default' })
			const inserted: any[] = []
			const deleted: any[] = []
			const collections: string[] = []
			;(adapter.client as any).db = (db: string) => ({
				collection: (col: string) => {
					collections.push(`${db}.${col}`)
					return {
						insertOne: async (doc: unknown) => void inserted.push(doc),
						deleteOne: async (filter: unknown) => void deleted.push(filter),
					}
				},
			})

			expect(await adapter.acquireMigrationLock({ db: 'tenant', col: 'history_a' }, async () => 42)).toBe(42)
			expect(collections).toEqual(['tenant._equipped_migration_locks'])
			expect(inserted).toEqual([{ _id: JSON.stringify(['tenant', 'history_a']), owner: expect.any(String) }])
			expect(deleted).toEqual([{ _id: JSON.stringify(['tenant', 'history_a']), owner: inserted[0].owner }])
		})

		test('lock release is owner-checked when the migration callback fails', async () => {
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017/default' })
			let inserted: any
			let deleted: any
			;(adapter.client as any).db = () => ({
				collection: () => ({
					insertOne: async (doc: unknown) => void (inserted = doc),
					deleteOne: async (filter: unknown) => void (deleted = filter),
				}),
			})

			await expect(
				adapter.acquireMigrationLock({ db: 'tenant', col: 'history' }, async () => {
					throw new Error('boom')
				}),
			).rejects.toThrow('boom')
			expect(deleted).toEqual({ _id: inserted._id, owner: inserted.owner })
		})

		test('lock polling times out without taking over the existing owner', async () => {
			vi.useFakeTimers()
			try {
				const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017/default' })
				const insertOne = vi.fn(async () => {
					throw Object.assign(new Error('duplicate'), { code: 11000 })
				})
				const deleteOne = vi.fn()
				;(adapter.client as any).db = () => ({ collection: () => ({ insertOne, deleteOne }) })

				const pending = adapter.acquireMigrationLock({ db: 'tenant', col: 'history' }, async () => 'never')
				const assertion = expect(pending).rejects.toThrow('Timed out acquiring MongoDB migration lock')
				await vi.runAllTimersAsync()
				await assertion
				expect(insertOne).toHaveBeenCalledTimes(101)
				expect(deleteOne).not.toHaveBeenCalled()
			} finally {
				vi.useRealTimers()
			}
		})

		test('different history identities acquire independently while the same identity waits', async () => {
			vi.useFakeTimers()
			try {
				const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017/default' })
				const held = new Set<string>()
				;(adapter.client as any).db = () => ({
					collection: () => ({
						insertOne: async ({ _id }: { _id: string }) => {
							if (held.has(_id)) throw Object.assign(new Error('duplicate'), { code: 11000 })
							held.add(_id)
						},
						deleteOne: async ({ _id }: { _id: string }) => void held.delete(_id),
					}),
				})
				let release!: () => void
				const first = adapter.acquireMigrationLock(
					{ db: 'tenant', col: 'history_a' },
					() => new Promise<void>((resolve) => (release = resolve)),
				)
				await vi.advanceTimersByTimeAsync(0)
				let sameRan = false
				const same = adapter.acquireMigrationLock(
					{ db: 'tenant', col: 'history_a' },
					async () => void (sameRan = true),
				)
				let otherRan = false
				const other = adapter.acquireMigrationLock(
					{ db: 'tenant', col: 'history_b' },
					async () => void (otherRan = true),
				)
				await vi.advanceTimersByTimeAsync(0)

				expect(sameRan).toBe(false)
				expect(otherRan).toBe(true)
				release()
				await first
				await vi.advanceTimersByTimeAsync(100)
				await Promise.all([same, other])
				expect(sameRan).toBe(true)
			} finally {
				vi.useRealTimers()
			}
		})

		function mockMongoDb(adapter: MongoDbAdapter) {
			const state = {
				migrations: new Map<string, { _id: string; appliedAt: number }>(),
				collections: new Map<
					string,
					{ indexes: Array<{ name: string; key: Record<string, number>; unique?: boolean }> }
				>(),
			}

			const getCol = (name: string) => {
				if (!state.collections.has(name)) {
					state.collections.set(name, { indexes: [] })
				}
				return state.collections.get(name)!
			}

			;(adapter.client as any).db = () => ({
				collection: (name: string) => {
					if (name === MIGRATION_TRACKER_COLLECTION) {
						return {
							find: () => ({ toArray: async () => [...state.migrations.values()] }),
							insertOne: async (doc: { _id: string; appliedAt: number }) => {
								state.migrations.set(doc._id, doc)
							},
						}
					}
					const col = getCol(name)
					return {
						createIndex: async (
							fields: Record<string, number>,
							opts: { unique?: boolean; name: string },
						) => {
							col.indexes.push({ name: opts.name, key: fields, unique: opts.unique })
						},
						dropIndex: async (indexName: string) => {
							col.indexes = col.indexes.filter((i) => i.name !== indexName)
						},
						listIndexes: () => ({
							toArray: async () => [{ name: '_id_', key: { _id: 1 } }, ...col.indexes],
						}),
					}
				},
				listCollections: (filter?: { name?: string }) => ({
					toArray: async () =>
						[...state.collections.keys()]
							.filter((name) => !filter?.name || name === filter.name)
							.map((name) => ({ name })),
				}),
			})

			return state
		}

		test('targeted introspection selects a resolved database and collection', async () => {
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017/default' })
			const state = mockMongoDb(adapter)
			state.collections.set('users', { indexes: [] })

			expect((await adapter.introspectTarget({ db: 'tenant', col: 'users' }))?.name).toBe('users')
			expect(await adapter.introspectTarget({ db: 'tenant', col: 'missing' })).toBeNull()
			expect(adapter.physicalTargetIdentity({ db: 'tenant', col: 'users' })).toBe(
				JSON.stringify(['tenant', 'users']),
			)
			expect(adapter.physicalTargetIdentity({ db: 'other', col: 'users' })).not.toBe(
				adapter.physicalTargetIdentity({ db: 'tenant', col: 'users' }),
			)
		})

		test('loadMigrations reads from equipped_migrations collection', async () => {
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017/testdb' })
			const state = mockMongoDb(adapter)
			state.migrations.set('0001', { _id: '0001', appliedAt: 1000 })
			state.migrations.set('0002', { _id: '0002', appliedAt: 2000 })

			const result = await adapter.loadMigrations({ db: 'testdb', col: '_equipped_migrations' })
			expect(result).toEqual([
				{ id: '0001', appliedAt: 1000 },
				{ id: '0002', appliedAt: 2000 },
			])
		})

		test('loadMigrations returns empty array when no migrations exist', async () => {
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017/testdb' })
			mockMongoDb(adapter)

			const result = await adapter.loadMigrations({ db: 'testdb', col: '_equipped_migrations' })
			expect(result).toEqual([])
		})

		test('recordMigration inserts into equipped_migrations with _id', async () => {
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017/testdb' })
			const state = mockMongoDb(adapter)

			await adapter.recordMigration({ db: 'testdb', col: '_equipped_migrations' }, '0001', 1234)

			expect(state.migrations.has('0001')).toBe(true)
			expect(state.migrations.get('0001')).toEqual({ _id: '0001', appliedAt: 1234 })
		})

		test('applyAddIndex creates index with specified name and fields', async () => {
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017/testdb' })
			const state = mockMongoDb(adapter)

			await adapter.applyAddIndex({
				kind: 'addIndex',
				table: 'users',
				on: ['email'],
				unique: true,
				name: 'users_email_unique',
			})

			const col = state.collections.get('users')!
			expect(col.indexes).toHaveLength(1)
			expect(col.indexes[0]).toEqual({ name: 'users_email_unique', key: { email: 1 }, unique: true })
		})

		test('applyAddIndex auto-derives name when absent', async () => {
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017/testdb' })
			const state = mockMongoDb(adapter)

			await adapter.applyAddIndex({ kind: 'addIndex', table: 'users', on: ['email'] })

			const col = state.collections.get('users')!
			expect(col.indexes[0].name).toBe('users_email_idx')
		})

		test('applyAddIndex auto-derived compound index name', async () => {
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017/testdb' })
			const state = mockMongoDb(adapter)

			await adapter.applyAddIndex({ kind: 'addIndex', table: 'orders', on: ['userId', 'createdAt'] })

			const col = state.collections.get('orders')!
			expect(col.indexes[0].name).toBe('orders_userId_createdAt_idx')
			expect(col.indexes[0].key).toEqual({ userId: 1, createdAt: 1 })
		})

		test('applyDropIndex only drops from the resolved database and collection', async () => {
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017/testdb' })
			const state = mockMongoDb(adapter)
			state.collections.set('users', { indexes: [{ name: 'users_email_idx', key: { email: 1 }, unique: true }] })
			state.collections.set('unrelated', {
				indexes: [{ name: 'users_email_idx', key: { email: 1 }, unique: true }],
			})

			await adapter.applyDropIndex(
				{ kind: 'dropIndex', table: 'logicalUsers', name: 'users_email_idx' },
				{ db: 'mappedDb', col: 'users' },
			)

			expect(state.collections.get('users')!.indexes).toHaveLength(0)
			expect(state.collections.get('unrelated')!.indexes).toHaveLength(1)
		})

		test('applyDropIndex is a no-op when index not found', async () => {
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017/testdb' })
			mockMongoDb(adapter)

			await adapter.applyDropIndex({ kind: 'dropIndex', table: 'users', name: 'nonexistent_idx' })
		})

		test('introspect returns DiscoveredSchema with empty fields, pk, and foreignKeys', async () => {
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017/testdb' })
			const state = mockMongoDb(adapter)
			state.collections.set('users', { indexes: [] })
			state.collections.set('posts', { indexes: [] })

			const schemas = await adapter.introspect()

			expect(schemas).toHaveLength(2)
			for (const s of schemas) {
				expect(s.pk).toBeUndefined()
				expect(s.fields).toEqual([])
				expect(s.foreignKeys).toEqual([])
			}
		})

		test('introspect skips _id_ index', async () => {
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017/testdb' })
			const state = mockMongoDb(adapter)
			state.collections.set('users', { indexes: [{ name: 'users_email_idx', key: { email: 1 }, unique: false }] })

			const schemas = await adapter.introspect()

			expect(schemas).toHaveLength(1)
			expect(schemas[0].indexes).toHaveLength(1)
			expect(schemas[0].indexes[0].name).toBe('users_email_idx')
		})

		test('introspect skips tracker collection', async () => {
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017/testdb' })
			const state = mockMongoDb(adapter)
			state.collections.set('users', { indexes: [] })
			state.collections.set(MIGRATION_TRACKER_COLLECTION, { indexes: [] })
			state.collections.set(MIGRATION_LOCK_COLLECTION, { indexes: [] })

			const schemas = await adapter.introspect()

			expect(schemas).toHaveLength(1)
			expect(schemas[0].name).toBe('users')
		})

		test('introspect maps index keys to on array and unique flag', async () => {
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017/testdb' })
			const state = mockMongoDb(adapter)
			state.collections.set('orders', {
				indexes: [
					{ name: 'orders_userId_createdAt_idx', key: { userId: 1, createdAt: 1 }, unique: false },
					{ name: 'orders_email_unique', key: { email: 1 }, unique: true },
				],
			})

			const schemas = await adapter.introspect()

			expect(schemas[0].indexes).toEqual([
				{ name: 'orders_userId_createdAt_idx', on: ['userId', 'createdAt'], unique: false },
				{ name: 'orders_email_unique', on: ['email'], unique: true },
			])
		})

		test('adapter implements acquireMigrationLock', () => {
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017/testdb' })
			expect(adapter.acquireMigrationLock).toBeTypeOf('function')
		})

		test('adapter does not implement DDL apply methods', () => {
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017/testdb' })
			expect((adapter as any).applyCreateTable).toBeUndefined()
			expect((adapter as any).applyDropTable).toBeUndefined()
			expect((adapter as any).applyAddField).toBeUndefined()
			expect((adapter as any).applyDropField).toBeUndefined()
			expect((adapter as any).applyModifyField).toBeUndefined()
			expect((adapter as any).applyRenameTable).toBeUndefined()
			expect((adapter as any).applyRenameField).toBeUndefined()
			expect((adapter as any).applyAddForeignKey).toBeUndefined()
			expect((adapter as any).applyDropForeignKey).toBeUndefined()
		})

		test('type-level: ChangeFor<MongoDbAdapter> excludes DDL variants', () => {
			type Changes = import('../../migrations/types.js').ChangeFor<MongoDbAdapter>

			expectTypeOf<Extract<Changes, { kind: 'addIndex' }>>().not.toBeNever()
			expectTypeOf<Extract<Changes, { kind: 'dropIndex' }>>().not.toBeNever()
			expectTypeOf<Extract<Changes, { kind: 'execute' }>>().not.toBeNever()

			expectTypeOf<Extract<Changes, { kind: 'addField' }>>().toBeNever()
			expectTypeOf<Extract<Changes, { kind: 'createTable' }>>().toBeNever()
			expectTypeOf<Extract<Changes, { kind: 'dropTable' }>>().toBeNever()
			expectTypeOf<Extract<Changes, { kind: 'modifyField' }>>().toBeNever()
			expectTypeOf<Extract<Changes, { kind: 'renameTable' }>>().toBeNever()
			expectTypeOf<Extract<Changes, { kind: 'renameField' }>>().toBeNever()
			expectTypeOf<Extract<Changes, { kind: 'dropField' }>>().toBeNever()
			expectTypeOf<Extract<Changes, { kind: 'addForeignKey' }>>().toBeNever()
			expectTypeOf<Extract<Changes, { kind: 'dropForeignKey' }>>().toBeNever()
		})

		test('type-level: Migrator requires an explicit lock policy', async () => {
			const { Migrator } = await import('../../migrations/migrator.js')
			const { Repo } = await import('../../repo/repo.js')

			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017/testdb' })
			const repo = Repo.from(adapter)
				.resolve(() => ({ db: 'test', col: 'test' }))
				.build()
			const step = Migrator.from(repo).withoutLock().migrations([])

			expectTypeOf(step).toHaveProperty('build')
			expectTypeOf(Migrator.from(repo)).not.toHaveProperty('migrations')
		})

		test('type-level: Migrator.from(repo).withoutLock().build() also works', async () => {
			const { Migrator } = await import('../../migrations/migrator.js')
			const { Repo } = await import('../../repo/repo.js')

			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017/testdb' })
			const repo = Repo.from(adapter)
				.resolve(() => ({ db: 'test', col: 'test' }))
				.build()
			const migrator = Migrator.from(repo).withoutLock().migrations([]).build()
			expect(migrator).toBeDefined()
		})

		test('end-to-end: Migrator runs addIndex + dropIndex + execute changes', async () => {
			const { Migrator } = await import('../../migrations/migrator.js')
			const { Repo } = await import('../../repo/repo.js')

			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017/testdb' })
			const state = mockMongoDb(adapter)
			const repo = Repo.from(adapter)
				.resolve((name) => ({ db: 'test', col: name }))
				.build()

			let executeRan = false
			type M = import('../../migrations/types.js').Migration<typeof adapter>
			const migrations: M[] = [
				{
					id: '0001-add-idx',
					tx: false,
					changes: [{ kind: 'addIndex', table: 'users', on: ['email'], unique: true }],
				},
				{
					id: '0002-backfill',
					tx: false,
					changes: [
						{
							kind: 'execute',
							up: async () => {
								executeRan = true
							},
						},
					],
				},
				{
					id: '0003-drop-idx',
					tx: false,
					changes: [{ kind: 'dropIndex', table: 'users', name: 'users_email_idx' }],
				},
			]

			const migrator = Migrator.from(repo).withoutLock().migrations(migrations).build()
			const result = await migrator.up()

			expect(result.ran).toEqual(['0001-add-idx', '0002-backfill', '0003-drop-idx'])
			expect(executeRan).toBe(true)
			expect(state.migrations.size).toBe(3)
			expect(state.collections.get('users')!.indexes).toHaveLength(0)
		})

		test('introspect round-trip: addIndex then introspect sees the index', async () => {
			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017/testdb' })
			const state = mockMongoDb(adapter)

			state.collections.set('users', {
				indexes: [{ name: 'users_email_idx', key: { email: 1 }, unique: true }],
			})

			const schemas = await adapter.introspect()

			expect(schemas).toHaveLength(1)
			expect(schemas[0].name).toBe('users')
			expect(schemas[0].pk).toBeUndefined()
			expect(schemas[0].fields).toEqual([])
			expect(schemas[0].foreignKeys).toEqual([])
			expect(schemas[0].indexes).toEqual([{ name: 'users_email_idx', on: ['email'], unique: true }])
		})

		test('data backfill via execute change', async () => {
			const { Migrator } = await import('../../migrations/migrator.js')
			const { Repo } = await import('../../repo/repo.js')

			const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017/testdb' })
			mockMongoDb(adapter)
			const repo = Repo.from(adapter)
				.resolve((name) => ({ db: 'test', col: name }))
				.build()

			const backfilledData: string[] = []
			type M = import('../../migrations/types.js').Migration<typeof adapter>
			const m: M = {
				id: '0001-backfill',
				tx: false,
				changes: [
					{
						kind: 'execute',
						up: async () => {
							backfilledData.push('user-1-normalized')
							backfilledData.push('user-2-normalized')
						},
					},
				],
			}

			const migrator = Migrator.from(repo).withoutLock().migrations([m]).build()
			await migrator.up()

			expect(backfilledData).toEqual(['user-1-normalized', 'user-2-normalized'])
		})
	})
}
