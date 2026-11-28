import { v } from 'valleyed'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import type { InferAdapterConfig } from '../../src/orm/adapter.js'
import type { OrmUse } from '../../src/orm/adapters/base.js'
import { InMemoryAdapter } from '../../src/orm/adapters/in-memory/index.js'
import { OrmValidationError } from '../../src/orm/errors/index.js'
import { FilterGroup } from '../../src/orm/filter.js'
import { OrmAdapter } from '../../src/orm/orm-adapter.js'
import { Relations } from '../../src/orm/relations.js'
import type { OneBuilderSurface } from '../../src/orm/repo/builders.js'
import { Repo } from '../../src/orm/repo/repo.js'
import type { SchemaCreateInput } from '../../src/orm/schema-validations.js'
import { Schema } from '../../src/orm/schema.js'
import type { AnySchema } from '../../src/orm/schema.js'

describe('atomic schema-aware mutations', () => {
	const UserSchema = Schema.from('mutation_atomic_users')
		.pk('id', { input: v.string(), generate: () => 'generated-user' })
		.field('name', { input: v.string(), output: v.string() })
		.build()

	function makeRepo<A extends OrmAdapter = InMemoryAdapter>(adapter: A = InMemoryAdapter.create({}) as A) {
		return Repo.from(adapter)
			.resolve((name) => ({ table: name }) as InferAdapterConfig<A>)
			.build()
	}

	it('rolls back a standalone write when output validation fails after dispatch', async () => {
		const adapter = InMemoryAdapter.create({})
		const createMany = adapter.createMany.bind(adapter)
		const mutableAdapter = adapter as unknown as { createMany: typeof adapter.createMany }
		mutableAdapter.createMany = async (...args: Parameters<typeof adapter.createMany>) => {
			const rows = await createMany(...args)
			return rows.map((row) => ({ ...row, name: 42 }))
		}
		const repo = makeRepo(adapter)

		await expect(repo.on(UserSchema).one().create({ name: 'persist then reject' })).rejects.toBeInstanceOf(
			OrmValidationError,
		)
		expect(await repo.on(UserSchema).all().find()).toEqual([])
	})

	it('joins the caller-owned session and rolls grouped mutation work back on an escaping error', async () => {
		const adapter = InMemoryAdapter.create({})
		const session = vi.spyOn(adapter, 'session')
		const repo = makeRepo(adapter)
		const failure = new Error('abort grouped work')

		await expect(
			repo.session(async () => {
				const user = await repo.on(UserSchema).one().create({ name: 'before' })
				await repo.on(UserSchema).one().id(user.id).update({ name: 'after' })
				throw failure
			}),
		).rejects.toBe(failure)

		expect(session).toHaveBeenCalledTimes(1)
		expect(await repo.on(UserSchema).all().find()).toEqual([])
	})

	it('rolls back a create when requested preload assembly fails output validation', async () => {
		const PostSchema = Schema.from('mutation_atomic_posts')
			.pk('id', { input: v.string(), generate: () => 'post-id' })
			.field('userId', { input: v.string() })
			.field('title', { input: v.string() })
			.build()
		const UserRelations = Relations.from(UserSchema).hasMany('posts', PostSchema.fields.userId).build()
		const adapter = InMemoryAdapter.create({})
		const originalUse = adapter.use.bind(adapter)
		const mutableAdapter = adapter as unknown as {
			use: (schema: AnySchema, config: { table: string }) => OrmUse
		}
		mutableAdapter.use = (schema, config) => {
			const use = originalUse(schema, config)
			if (schema.name === PostSchema.name) {
				return { ...use, findMany: async () => [{ id: 'bad-post', userId: 42, title: 'invalid' }] }
			}
			return use
		}
		const repo = makeRepo(adapter)

		await expect(
			repo.on(UserSchema).one().preload([UserRelations.posts]).create({ name: 'parent' }),
		).rejects.toMatchObject({ kind: 'output' })
		expect(await repo.on(UserSchema).all().find()).toEqual([])
	})

	it('refuses unsupported mutations before dispatch and keeps accepted nontransactional errors ordinary', async () => {
		class NonTransactionalAdapter extends OrmAdapter {
			readonly schemaConfigPipe = v.object({ table: v.string() })
			readonly supportedFieldTypes = ['string'] as const
			written: Record<string, unknown>[] = []
			async createMany(_schema: unknown, _config: unknown, data: Record<string, unknown>[]) {
				this.written.push(...data)
				return data.map((row) => ({ ...row, name: 42 }))
			}
		}

		const adapter = new NonTransactionalAdapter()
		const repo = makeRepo(adapter)
		const rawBuilder = repo.on(UserSchema).one()
		const rawCreate = Reflect.get(rawBuilder, 'create') as (
			data: SchemaCreateInput<typeof UserSchema>,
		) => Promise<unknown>
		await expect(rawCreate.call(rawBuilder, { name: 'refused' })).rejects.toThrow(TypeError)
		expect(adapter.written).toEqual([])

		let caught: unknown
		try {
			await repo.on(UserSchema).one().allowNonTransactional().create({ name: 'accepted' })
		} catch (error) {
			caught = error
		}
		expect(caught).toBeInstanceOf(OrmValidationError)
		expect((caught as OrmValidationError).kind).toBe('output')
		expect((caught as OrmValidationError).context).not.toHaveProperty('persistenceOutcome')
		expect(adapter.written).toEqual([{ id: 'generated-user', name: 'accepted' }])
	})

	it('rejects incomplete transaction pairs and missing adapter methods before callbacks or queries', async () => {
		class IncompleteAdapter extends OrmAdapter {
			readonly schemaConfigPipe = v.object({})
			readonly supportedFieldTypes = ['string'] as const
			readonly queryableOps = ['eq'] as const
			queryCalls = 0
			async findMany() {
				this.queryCalls++
				return []
			}
			async createMany(_schema: unknown, _config: unknown, data: Record<string, unknown>[]) {
				return data
			}
			async session<T>(fn: () => Promise<T>) {
				return fn()
			}
		}
		const incomplete = new IncompleteAdapter()
		const incompleteRepo = makeRepo(incomplete)
		const incompleteBuilder = incompleteRepo.on(UserSchema).one()
		const incompleteCreate = Reflect.get(incompleteBuilder, 'create') as (
			data: SchemaCreateInput<typeof UserSchema>,
		) => Promise<unknown>
		await expect(incompleteCreate.call(incompleteBuilder, { name: 'must not write' })).rejects.toThrow(TypeError)
		let callbackCalled = false
		const runtimeSession = Reflect.get(incompleteRepo, 'session') as (fn: () => Promise<void>) => Promise<void>
		await expect(runtimeSession.call(incompleteRepo, async () => void (callbackCalled = true))).rejects.toThrow(
			TypeError,
		)
		expect(callbackCalled).toBe(false)

		class MissingCountAdapter extends OrmAdapter {
			readonly schemaConfigPipe = v.object({})
			readonly supportedFieldTypes = ['string'] as const
			readonly queryableOps = ['eq'] as const
			queryCalls = 0
			async findMany() {
				this.queryCalls++
				return []
			}
		}
		const missingCount = new MissingCountAdapter()
		const use = missingCount.use(UserSchema, {})
		await expect(use.count(FilterGroup.create())).rejects.toThrow(TypeError)
		await expect(use.deleteOne(FilterGroup.create())).rejects.toThrow(TypeError)
		expect(missingCount.queryCalls).toBe(0)
	})

	it('exposes per-chain nontransactional acceptance only for adapters without transaction methods', () => {
		class NonTransactionalAdapter extends OrmAdapter {
			readonly schemaConfigPipe = v.object({})
			readonly supportedFieldTypes = ['string'] as const
			async createMany() {
				return []
			}
		}
		class IncompleteAdapter extends OrmAdapter {
			readonly schemaConfigPipe = v.object({})
			readonly supportedFieldTypes = ['string'] as const
			async session<T>(fn: () => Promise<T>) {
				return fn()
			}
			async createMany() {
				return []
			}
		}
		type Transactional = OneBuilderSurface<typeof UserSchema, InMemoryAdapter>
		type NonTransactional = OneBuilderSurface<typeof UserSchema, NonTransactionalAdapter>
		type Incomplete = OneBuilderSurface<typeof UserSchema, IncompleteAdapter>
		expectTypeOf<Transactional['create']>().toBeFunction()
		expectTypeOf<Transactional['allowNonTransactional']>().toBeNever()
		expectTypeOf<NonTransactional['create']>().toBeNever()
		expectTypeOf<NonTransactional['allowNonTransactional']>().toBeFunction()
		expectTypeOf<Incomplete['create']>().toBeNever()
		expectTypeOf<Incomplete['allowNonTransactional']>().toBeNever()
	})
})
