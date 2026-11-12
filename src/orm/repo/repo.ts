import type { InferAdapterConfig } from '../adapter.js'
import type { OrmAdapterLike } from '../adapters/base.js'
import type { IterationOptions } from '../query-options.js'
import type { AnySchema } from '../schema.js'
import { run } from './als.js'
import { SchemaContext, SchemaRef, type HasMethod, type SchemaRefSurface } from './builders.js'
import { registerRepoConfig, resolveRepoConfig } from './internals/config.js'

export type { ConfigTransform } from './als.js'

export class Repo<A extends OrmAdapterLike<any>> {
	readonly #adapter: A

	constructor({ adapter, resolve }: { adapter: A; resolve: (name: string) => InferAdapterConfig<A> }) {
		this.#adapter = adapter
		registerRepoConfig<A>(this, resolve, (adapter as any).schemaConfigPipe)
	}

	#getConfig(s: AnySchema): InferAdapterConfig<A> {
		return resolveRepoConfig<A>(this, s.name)
	}

	#getUse(s: AnySchema) {
		return this.#adapter.use(s, this.#getConfig(s))
	}

	on<S extends AnySchema>(schema: S): SchemaRefSurface<S, A> {
		return new SchemaRef<S, A>(
			new SchemaContext(schema, (target) => this.#getUse(target)),
		) as unknown as SchemaRefSurface<S, A>
	}

	static from<NewA extends OrmAdapterLike<any>>(adapter: NewA): RepoBuilder<NewA> {
		return new RepoBuilder<NewA>(adapter)
	}

	async session<T>(fn: () => Promise<T>): Promise<T> {
		return this.#adapter.session?.(fn) ?? fn()
	}

	resolve<T>(resolver: (config: InferAdapterConfig<A>, name: string) => InferAdapterConfig<A>, fn: () => T): T {
		return run<InferAdapterConfig<A>, T>(resolver, fn)
	}
}

class RepoBuilder<A extends OrmAdapterLike<any>> {
	#adapter: unknown
	#resolve: unknown

	constructor(adapter?: unknown, resolve?: unknown) {
		this.#adapter = adapter
		this.#resolve = resolve
	}

	resolve(fn: (name: string) => InferAdapterConfig<A>): RepoBuilder<A> {
		return new RepoBuilder<A>(this.#adapter, fn)
	}

	build(this: RepoBuilder<A>): RepoSurface<A> {
		return new Repo<A>({
			adapter: this.#adapter as any,
			resolve: this.#resolve as any,
		}) as RepoSurface<A>
	}
}

export type RepoSurface<A extends OrmAdapterLike<any>> = Repo<A> &
	(HasMethod<A, 'session'> extends true ? {} : { session: never })

if (import.meta.vitest) {
	const { describe, test, expect, expectTypeOf, vi } = import.meta.vitest
	const { v } = await import('valleyed')
	const { InMemoryAdapter } = await import('../adapters/in-memory/index.js')
	const { OrmAdapter } = await import('../orm-adapter.js')
	const { OrmValidationError } = await import('../errors/index.js')
	const { Instance } = await import('../../instance/index.js')
	const { Relations } = await import('../relations.js')
	const { Schema } = await import('../schema.js')

	function mockInstance() {
		return vi.spyOn(Instance, 'on').mockImplementation(() => {})
	}

	describe('Repo.from() and repo.on()', () => {
		function buildRepo<A extends OrmAdapterLike<unknown>>(
			adapter: A,
			resolve: (name: string) => InferAdapterConfig<A>,
		) {
			return Repo.from(adapter).resolve(resolve).build()
		}

		test('builds and queries through a generic schema-config resolver', async () => {
			const adapter = InMemoryAdapter.create({})
			const schema = Schema.from('generic_resolver')
				.pk('id', v.string(), () => 'generic-id')
				.field('name', v.string())
				.build()
			const repo = buildRepo(adapter, (name) => ({ table: `scoped_${name}` }))

			const created = await repo.on(schema).one().create({ name: 'Generic resolver' })
			expect(await repo.on(schema).one().id(created.id).find()).toEqual(created)
			expect((await adapter.introspect()).map(({ name }) => name)).toEqual(['scoped_generic_resolver'])
		})

		test('types base resolvers and scoped transforms with logical names', async () => {
			const adapter = InMemoryAdapter.create({})
			const schema = Schema.from('typed_logical_name')
				.pk('id', v.string(), () => 'typed-id')
				.build()
			const repo = Repo.from(adapter)
				.resolve((name) => {
					expectTypeOf(name).toEqualTypeOf<string>()
					return { table: name }
				})
				.build()

			await repo.resolve(
				(config, name) => {
					expectTypeOf(config).toEqualTypeOf<{ table: string }>()
					expectTypeOf(name).toEqualTypeOf<string>()
					return { table: `${name}_${config.table}` }
				},
				() => repo.on(schema).all().find(),
			)
		})

		test('uses schema-config input before transforming it for the adapter', async () => {
			class TransformingConfigAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.string().pipe((table) => ({ table }))
				readonly supportedFieldTypes = ['string'] as const
				readonly seenConfigs: unknown[] = []

				async findMany(_schema: AnySchema, config: unknown) {
					this.seenConfigs.push(config)
					return [{ id: 'stored-id' }]
				}
			}

			const adapter = new TransformingConfigAdapter()
			const schema = Schema.from('transformed_resolver')
				.pk('id', v.string(), () => 'unused')
				.build()
			const repo = buildRepo(adapter, (name) => name)

			expect(adapter.seenConfigs).toEqual([])
			expect(await repo.on(schema).all().find()).toEqual([{ id: 'stored-id' }])
			expect(adapter.seenConfigs).toEqual([{ table: 'transformed_resolver' }])
		})

		test('preserves use-config inference for an adapter without a schema config pipe', async () => {
			const storage = InMemoryAdapter.create({})
			const adapter = {
				use: (schema: AnySchema, config: { table: string }) => storage.use(schema, config),
			}
			const schema = Schema.from('legacy_resolver')
				.pk('id', v.string(), () => 'legacy-id')
				.build()
			const repo = buildRepo(adapter, (name) => ({ table: name }))

			const created = await repo.on(schema).one().create({})
			expect(await repo.on(schema).all().find()).toEqual([created])
			expect((await storage.introspect()).map(({ name }) => name)).toEqual(['legacy_resolver'])
		})

		test('Repo.from(adapter).resolve(...).build() creates a working repo', async () => {
			const adapter = InMemoryAdapter.create({})
			const TestSchema = Schema.from('test')
				.pk('id', v.string(), () => 'x')
				.field('name', v.string())
				.build()
			const repo = Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()
			const created = await repo.on(TestSchema).one().create({ name: 'Hello' })
			expect(created.name).toBe('Hello')
			const found = await repo.on(TestSchema).one().id(created.id).find()
			expect(found?.name).toBe('Hello')
		})

		test('repo.on(schema) returns a SchemaRef', async () => {
			const adapter = InMemoryAdapter.create({})
			const TestSchema = Schema.from('test')
				.pk('id', v.string(), () => 'x')
				.field('name', v.string())
				.build()
			const repo = Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()
			const ref = repo.on(TestSchema)
			expect(ref).toBeInstanceOf(SchemaRef)
		})
	})

	describe('clone-on-step: RepoBuilder fan-out independence', () => {
		test('.resolve() returns a new builder, not the same instance', () => {
			const adapter = InMemoryAdapter.create({})
			const base = Repo.from(adapter)
			const a = base.resolve((name) => ({ table: name }))
			expect(a).not.toBe(base)
		})
	})

	describe('repo/Repo core behavior', () => {
		let userCounter = 0
		let postCounter = 0
		let profileCounter = 0
		let orgCounter = 0

		const UserSchema = Schema.from('users')
			.pk('id', v.string(), () => `u${++userCounter}`)
			.field('email', v.string())
			.field('name', v.string())
			.field('orgId', v.optional(v.string()), { onCreate: () => undefined })
			.field('createdAt', v.number(), { onCreate: () => 1000 })
			.build()

		const PostSchema = Schema.from('posts')
			.pk('id', v.string(), () => `p${++postCounter}`)
			.field('title', v.string())
			.field('userId', v.string())
			.build()

		const ProfileSchema = Schema.from('profiles')
			.pk('id', v.string(), () => `pr${++profileCounter}`)
			.field('bio', v.string())
			.field('userId', v.string())
			.build()

		const OrgSchema = Schema.from('orgs')
			.pk('id', v.string(), () => `o${++orgCounter}`)
			.field('name', v.string())
			.build()

		const PersonSchema = Schema.from('people')
			.pk('id', v.string(), () => `person-${++userCounter}`)
			.field('firstName', v.string())
			.field('lastName', v.string())
			.computed(
				'fullName',
				['firstName', 'lastName'],
				v.string(),
				({ firstName, lastName }) => `${firstName} ${lastName}`,
			)
			.build()

		const UserRels = Relations.from(UserSchema)
			.hasMany('posts', PostSchema.fields.userId)
			.hasOne('profile', ProfileSchema.fields.userId)
			.belongsTo('org', UserSchema.fields.orgId, OrgSchema)
			.build()

		function makeRepo() {
			const adapter = InMemoryAdapter.create({})
			return Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()
		}

		test('fluent builders support one/all read chains', async () => {
			const repo = makeRepo()
			const created = await repo.on(UserSchema).one().create({ email: 'fluent@test.com', name: 'Fluent User' })

			const one = await repo.on(UserSchema).one().id(created.id).select(['id', 'name']).find()
			expect(one).toEqual({ id: created.id, name: 'Fluent User' })

			const all = await repo
				.on(UserSchema)
				.all()
				.where((q) => q.eq('id', created.id))
				.orderBy('createdAt', 'desc')
				.limit(1)
				.select(['id'])
				.find()

			expect(all).toEqual([{ id: created.id }])
		})

		test('all().count() returns filtered counts and ignores query-shape state', async () => {
			const repo = makeRepo()
			await repo
				.on(UserSchema)
				.all()
				.create([
					{ email: 'alice@count.com', name: 'Alice' },
					{ email: 'bob@count.com', name: 'Bob' },
					{ email: 'alice2@count.com', name: 'Alice' },
				])

			const count = await repo
				.on(UserSchema)
				.all()
				.where((q) => q.eq('name', 'Alice'))
				.select(['does_not_exist'] as any)
				.preload(['does_not_exist'] as any)
				.orderBy('does_not_exist')
				.limit(0)
				.page(0)
				.count()

			expect(count).toBe(2)
		})

		test('all().count() validates only the filter', async () => {
			const repo = makeRepo()
			await repo.on(UserSchema).one().create({ email: 'bad-filter-count@test.com', name: 'Alice' })

			await expect(
				repo
					.on(UserSchema)
					.all()
					.where((q) => q.eq('does_not_exist' as any, 'x'))
					.select(['also_missing'] as any)
					.preload(['also_missing'] as any)
					.limit(0)
					.count(),
			).rejects.toBeInstanceOf(OrmValidationError)
		})

		test('all().count() is distinct from aggregate count', async () => {
			const repo = makeRepo()
			await repo
				.on(UserSchema)
				.all()
				.create([
					{ email: 'one@agg-count.com', name: 'Same' },
					{ email: 'two@agg-count.com', name: 'Same' },
				])

			const count = await repo
				.on(UserSchema)
				.all()
				.where((q) => q.eq('name', 'Same'))
				.count()
			const aggregate = await repo
				.on(UserSchema)
				.aggregate()
				.count('total')
				.where((q) => q.eq('name', 'Same'))
				.run()

			expect(count).toBe(2)
			expect(aggregate).toEqual({ total: 2 })
		})

		test('builder snapshots are immutable across chain branches', async () => {
			const repo = makeRepo()
			await repo
				.on(UserSchema)
				.all()
				.create([
					{ email: 'alice@branch.com', name: 'Alice' },
					{ email: 'bob@branch.com', name: 'Bob' },
				])

			const base = repo.on(UserSchema).all()
			const branchA = base.where((q) => q.eq('name', 'Alice')).select(['id'])
			const branchB = base.where((q) => q.eq('name', 'Bob')).select(['name'])

			const rowsA = await branchA.find()
			const rowsB = await branchB.find()

			expect(rowsA).toHaveLength(1)
			expect(rowsB).toHaveLength(1)
			expect(rowsA.every((r) => 'id' in r && !('name' in r))).toBe(true)
			expect(rowsB).toEqual([{ name: 'Bob' }])
		})

		test('fluent builders support write chains with preloads', async () => {
			const repo = makeRepo()
			const org = await repo.on(OrgSchema).one().create({ name: 'Fluent Org' })

			const user = await repo
				.on(UserSchema)
				.one()
				.preload([UserRels.org])
				.create({ email: 'writer@test.com', name: 'Writer', orgId: org.id })

			expect((user.org as any).name).toBe('Fluent Org')

			const updated = await repo
				.on(UserSchema)
				.one()
				.id(user.id)
				.select(['id', 'name'])
				.update({ name: 'Updated Writer' })

			expect(updated).toEqual({ id: user.id, name: 'Updated Writer' })

			const deleted = await repo.on(UserSchema).one().id(user.id).select(['id']).delete()
			expect(deleted).toEqual({ id: user.id })
		})

		test('session supports multi-operation writes with fluent builders', async () => {
			const repo = makeRepo()

			const insertedId = await repo.session(async () => {
				const created = await repo.on(UserSchema).one().create({ email: 'tx@fluent.com', name: 'Tx Fluent' })
				await repo.on(UserSchema).one().id(created.id).update({ name: 'Tx Fluent Updated' })
				return created.id
			})

			const persisted = await repo.on(UserSchema).one().id(insertedId).select(['name']).find()
			expect(persisted).toEqual({ name: 'Tx Fluent Updated' })
		})

		test('create/find/update/delete flows work', async () => {
			const repo = makeRepo()
			const user = await repo.on(UserSchema).one().create({ email: 'a@b.com', name: 'Alice' })
			expect(user.id).toMatch(/^u\d+$/)
			expect(user.createdAt).toBe(1000)

			const found = await repo.on(UserSchema).one().id(user.id).find()
			expect(found?.id).toBe(user.id)

			const updated = await repo.on(UserSchema).one().id(user.id).update({ name: 'Updated' })
			expect(updated?.name).toBe('Updated')

			const deleted = await repo.on(UserSchema).one().id(user.id).delete()
			expect(deleted?.id).toBe(user.id)
		})

		test('findById, updateById, and deleteById target the schema primary key', async () => {
			const repo = makeRepo()
			const user = await repo.on(UserSchema).one().create({ email: 'id@test.com', name: 'ById' })

			const found = await repo.on(UserSchema).one().id(user.id).find()
			expect(found?.id).toBe(user.id)

			const updated = await repo.on(UserSchema).one().id(user.id).update({ name: 'Changed' })
			expect(updated?.name).toBe('Changed')

			const deleted = await repo.on(UserSchema).one().id(user.id).delete()
			expect(deleted?.id).toBe(user.id)
			expect(await repo.on(UserSchema).one().id(user.id).find()).toBeNull()
		})

		test('createMany, findMany and upsertOne work', async () => {
			const repo = makeRepo()
			await repo
				.on(UserSchema)
				.all()
				.create([
					{ email: 'a@b.com', name: 'Alice' },
					{ email: 'b@c.com', name: 'Bob' },
				])
			expect(await repo.on(UserSchema).all().find()).toHaveLength(2)

			const inserted = await repo
				.on(UserSchema)
				.one()
				.where((q) => q.eq('id', 'u-fixed'))
				.upsert({ create: { email: 'new@test.com', name: 'New' } })
			expect(inserted.name).toBe('New')
		})

		test('accepts chainable where input for filters and options', async () => {
			const repo = makeRepo()
			await repo
				.on(UserSchema)
				.all()
				.create([
					{ email: 'a@b.com', name: 'Alice' },
					{ email: 'b@c.com', name: 'Bob' },
				])

			const rows = await repo
				.on(UserSchema)
				.all()
				.where((q) => q.or([(g) => g.eq('name', 'Alice'), (g) => g.eq('name', 'Bob')]))
				.orderBy('name', 'desc')
				.limit(1)
				.find()

			expect(rows).toHaveLength(1)
			expect(rows[0].name).toBe('Bob')
		})

		test('all().iterate uses adapter iterateMany without findMany emulation', async () => {
			const TestSchema = Schema.from('iter_repo_users')
				.pk('id', v.string(), () => 'x')
				.field('name', v.string())
				.field('age', v.number())
				.build()
			let findManyCalls = 0
			let capturedOptions: unknown

			class IterAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ table: v.string() })
				readonly supportedFieldTypes = ['string', 'number'] as const
				readonly queryableOps = ['gt'] as const
				async findMany(): Promise<Record<string, unknown>[]> {
					findManyCalls += 1
					throw new Error('findMany should not be called')
				}
				async *iterateMany(_s: AnySchema, _c: unknown, _f: unknown, options?: unknown) {
					capturedOptions = options
					yield { id: 'u3', name: 'Carol', age: 40 }
					yield { id: 'u1', name: 'Alice', age: 30 }
				}
			}

			const adapter = new (IterAdapter as any)() as IterAdapter
			const repo = Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()
			const rows: Array<{ id: string; name: string; age: number }> = []
			for await (const row of repo
				.on(TestSchema)
				.all()
				.where((q) => q.gt('age', 19))
				.orderBy('age', 'desc')
				.offset(1)
				.limit(2)
				.iterate()) {
				rows.push(row)
			}

			expect(findManyCalls).toBe(0)
			expect(capturedOptions).toMatchObject({
				orderBy: [{ field: 'age', direction: 'desc' }],
				offset: 1,
				limit: 2,
			})
			expect(rows.map((row) => row.name)).toEqual(['Carol', 'Alice'])
		})

		test('all().iterate accepts batchSize and forwards it only to iterateMany', async () => {
			const TestSchema = Schema.from('iter_batch_users')
				.pk('id', v.string(), () => 'x')
				.field('name', v.string())
				.build()
			const events: unknown[] = []

			class IterAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ table: v.string() })
				readonly supportedFieldTypes = ['string'] as const
				readonly queryableOps = ['eq'] as const
				async findMany(_s: AnySchema, _c: unknown, _f: unknown, options?: unknown) {
					events.push({ method: 'findMany', options })
					return [{ id: 'u1', name: 'Alice' }]
				}
				async count(_s: AnySchema, _c: unknown, _f: unknown) {
					events.push({ method: 'count' })
					return 1
				}
				async *iterateMany(_s: AnySchema, _c: unknown, _f: unknown, options?: unknown) {
					events.push({ method: 'iterateMany', options })
					yield { id: 'u1', name: 'Alice' }
				}
			}

			const adapter = new (IterAdapter as any)() as IterAdapter
			const repo = Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()

			const iterated: Array<{ id: string; name: string }> = []
			for await (const row of repo.on(TestSchema).all().limit(10).iterate({ batchSize: 3 })) {
				iterated.push(row)
			}
			await repo.on(TestSchema).all().limit(10).find()
			await repo.on(TestSchema).all().limit(10).paginate()

			expect(iterated).toEqual([{ id: 'u1', name: 'Alice' }])
			expect(events).toEqual([
				{ method: 'iterateMany', options: expect.objectContaining({ limit: 10, batchSize: 3 }) },
				{ method: 'findMany', options: expect.not.objectContaining({ batchSize: expect.anything() }) },
				{ method: 'findMany', options: expect.not.objectContaining({ batchSize: expect.anything() }) },
				{ method: 'count' },
			])
		})

		test('all().iterate validates batchSize before adapter iteration runs', async () => {
			const TestSchema = Schema.from('iter_invalid_batch_users')
				.pk('id', v.string(), () => 'x')
				.field('name', v.string())
				.build()
			let iterateManyCalls = 0

			class IterAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ table: v.string() })
				readonly supportedFieldTypes = ['string'] as const
				async *iterateMany() {
					iterateManyCalls += 1
					yield { id: 'u1', name: 'Alice' }
				}
			}

			const adapter = new (IterAdapter as any)() as IterAdapter
			const repo = Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()

			for (const batchSize of [
				0,
				-1,
				1.5,
				Number.MAX_SAFE_INTEGER + 1,
				Number.POSITIVE_INFINITY,
				Number.NaN,
				'2',
			] as const) {
				try {
					for await (const _row of repo
						.on(TestSchema)
						.all()
						.iterate({ batchSize } as any)) {
						void _row
					}
					expect.unreachable(`batchSize ${String(batchSize)} should have failed`)
				} catch (error) {
					expect(error).toBeInstanceOf(OrmValidationError)
					const err = error as InstanceType<typeof OrmValidationError>
					expect(err.kind).toBe('query-shape')
					expect(err.operation).toBe('iterate')
					expect(err.failures).toEqual([expect.objectContaining({ option: 'batchSize' })])
				}
			}
			expect(iterateManyCalls).toBe(0)
		})

		test('all().iterate yields selected and preloaded documents one at a time', async () => {
			const adapter = InMemoryAdapter.create({})
			let preloadReads = 0
			const origUse = adapter.use.bind(adapter)
			;(adapter as any).use = vi.fn((schema: AnySchema, config: any) => {
				const use = origUse(schema, config)
				return {
					...use,
					findMany: async (...args: any[]) => {
						if (schema === PostSchema) preloadReads += 1
						return use.findMany(...(args as [any, any]))
					},
				}
			})
			const repo = Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()
			const alice = await repo.on(UserSchema).one().create({ email: 'alice@iter.com', name: 'Alice' })
			const bob = await repo.on(UserSchema).one().create({ email: 'bob@iter.com', name: 'Bob' })
			await repo.on(PostSchema).one().create({ title: 'A1', userId: alice.id })
			await repo.on(PostSchema).one().create({ title: 'A2', userId: alice.id })
			await repo.on(PostSchema).one().create({ title: 'B1', userId: bob.id })

			const rows: any[] = []
			const iterator = repo
				.on(UserSchema)
				.all()
				.orderBy('name', 'asc')
				.select(['id', 'name'])
				.preload([UserRels.posts])
				.iterate({ batchSize: 1 })
			expect(iterator[Symbol.asyncIterator]()).toBe(iterator)
			for await (const row of iterator) rows.push(row)

			expect(rows).toHaveLength(2)
			expect(rows.map((row) => row.name)).toEqual(['Alice', 'Bob'])
			expect(rows[0]).not.toHaveProperty('email')
			expect(rows[0].posts.map((post) => post.title)).toEqual(['A1', 'A2'])
			expect(rows[1].posts.map((post) => post.title)).toEqual(['B1'])
			expect(preloadReads).toBe(2)
		})

		test('all().iterate honors page-based offsets and validates read query shape', async () => {
			const repo = makeRepo()
			await repo
				.on(UserSchema)
				.all()
				.create([
					{ email: 'u1@iter.com', name: 'A' },
					{ email: 'u2@iter.com', name: 'B' },
					{ email: 'u3@iter.com', name: 'C' },
					{ email: 'u4@iter.com', name: 'D' },
					{ email: 'u5@iter.com', name: 'E' },
				])

			const paged: string[] = []
			for await (const row of repo.on(UserSchema).all().orderBy('name', 'asc').limit(2).page(2).iterate()) {
				paged.push(row.name)
			}
			expect(paged).toEqual(['C', 'D'])

			try {
				for await (const _row of repo
					.on(UserSchema)
					.all()
					.select(['missing' as any])
					.iterate()) {
					void _row
				}
				expect.unreachable('iterate should validate selected fields before reading')
			} catch (error) {
				expect(error).toBeInstanceOf(OrmValidationError)
				expect((error as InstanceType<typeof OrmValidationError>).kind).toBe('query-shape')
			}
		})

		test('resolve chains adapter config transforms', async () => {
			const seenConfigs: unknown[] = []
			const adapter = InMemoryAdapter.create({})
			const origUse = adapter.use.bind(adapter)
			;(adapter as any).use = vi.fn((s: any, config: any) => {
				seenConfigs.push(config)
				return origUse(s, config)
			})

			const repo = Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()

			await repo.resolve(
				(config) => ({ table: `a_${config.table}` }),
				async () => {
					await repo.resolve(
						(config) => ({ table: `b_${config.table}` }),
						async () => {
							await repo.on(UserSchema).all().find()
						},
					)
				},
			)

			expect(seenConfigs[0]).toEqual({ table: 'b_a_users' })
		})

		test('session returns callback value and persists writes', async () => {
			const repo = makeRepo()
			let insertedId = ''
			const result = await repo.session(async () => {
				const inserted = await repo.on(UserSchema).one().create({ email: 't@test.com', name: 'TxUser' })
				insertedId = inserted.id
				return 42
			})

			expect(result).toBe(42)
			expect(await repo.on(UserSchema).one().id(insertedId).find()).not.toBeNull()
		})

		test('preloads can be resolved on mutation methods', async () => {
			const repo = makeRepo()
			const org = await repo.on(OrgSchema).one().create({ name: 'Corp' })
			const user = await repo
				.on(UserSchema)
				.one()
				.preload([UserRels.org])
				.create({ email: 'u@test.com', name: 'User', orgId: org.id })
			expect((user.org as any).name).toBe('Corp')

			await repo.on(PostSchema).one().create({ title: 'Post', userId: user.id })
			const updated = await repo
				.on(UserSchema)
				.one()
				.id(user.id)
				.preload([UserRels.posts])
				.update({ name: 'Updated' })
			expect(updated?.posts).toHaveLength(1)
		})

		test('in-memory adapter without crud.raw collapses schemaRef.raw to never', () => {
			const repo = makeRepo()
			const ref = repo.on(UserSchema)
			expectTypeOf(ref.raw).toBeNever()
		})

		test('raw forwards user args through adapter.use to adapter.raw', async () => {
			let capturedArgs: unknown[] = []
			const spy = mockInstance()
			class RawAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ table: v.string() })
				readonly supportedFieldTypes = ['string', 'number'] as const
				readonly queryableOps = ['eq'] as const
				async findMany() {
					return []
				}
				async raw(_s: any, _c: any, command: string, params: unknown[]) {
					capturedArgs = [_s, _c, command, params]
					return { rows: [{ id: '1' }] }
				}
			}
			const rawAdapter = new (RawAdapter as any)() as InstanceType<typeof RawAdapter>
			spy.mockRestore()

			const repo = Repo.from(rawAdapter)
				.resolve((name) => ({ table: name }))
				.build()
			const TestSchema = Schema.from('raw_test')
				.pk('id', v.string(), () => 'x')
				.build()

			const result = await repo.on(TestSchema).raw('SELECT * FROM raw_test WHERE id = $1', ['abc'])
			expect(capturedArgs[0]).toBe(TestSchema)
			expect(capturedArgs[1]).toEqual({ table: 'raw_test' })
			expect(capturedArgs[2]).toBe('SELECT * FROM raw_test WHERE id = $1')
			expect(capturedArgs[3]).toEqual(['abc'])
			expect(result).toEqual({ rows: [{ id: '1' }] })
		})

		test('raw with single-arg adapter (mongo-style) forwards correctly', async () => {
			let capturedPipeline: unknown = undefined
			const spy = mockInstance()
			class MongoStyleAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ col: v.string() })
				readonly supportedFieldTypes = ['string'] as const
				async raw(_s: any, _c: any, pipeline: Record<string, unknown>[]) {
					capturedPipeline = pipeline
					return [{ total: 42 }]
				}
			}
			const mongoStyleAdapter = new (MongoStyleAdapter as any)() as InstanceType<typeof MongoStyleAdapter>
			spy.mockRestore()

			const repo = Repo.from(mongoStyleAdapter)
				.resolve(() => ({ col: 'test' }))
				.build()
			const TestSchema = Schema.from('mongo_test')
				.pk('id', v.string(), () => 'x')
				.build()

			const result = await repo.on(TestSchema).raw([{ $count: 'total' }])
			expect(capturedPipeline).toEqual([{ $count: 'total' }])
			expect(result).toEqual([{ total: 42 }])
		})

		test('computed fields are derived and shaped correctly when selected', async () => {
			const repo = makeRepo()
			const created = await repo.on(PersonSchema).one().create({ firstName: 'Ada', lastName: 'Lovelace' })
			const rows = await repo.on(PersonSchema).all().select(['id', 'fullName']).find()

			expect(rows).toEqual([{ id: created.id, fullName: 'Ada Lovelace' }])
		})

		test('computed field selection auto-includes dependencies for adapter reads', async () => {
			const adapter = InMemoryAdapter.create({})
			const origUse = adapter.use.bind(adapter)
			let seenSelect: string[] | undefined
			;(adapter as any).use = vi.fn((schema: any, config: any) => {
				const use = origUse(schema, config)
				return {
					...use,
					findMany: async (filter: any, options: any) => {
						seenSelect = options?.select as string[] | undefined
						return use.findMany(filter, options)
					},
				}
			})

			const repo = Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()
			await repo.on(PersonSchema).one().create({ firstName: 'Grace', lastName: 'Hopper' })
			await repo.on(PersonSchema).all().select(['id', 'fullName']).find()

			expect(seenSelect).toEqual(expect.arrayContaining(['id', 'firstName', 'lastName']))
		})

		test('unknown selected fields fail fast', async () => {
			const { EquippedError } = await import('../../errors/index.js')
			const repo = makeRepo()
			await repo.on(PersonSchema).one().create({ firstName: 'Ada', lastName: 'Lovelace' })

			await expect(
				repo
					.on(PersonSchema)
					.all()
					.select(['unknownField' as any])
					.find(),
			).rejects.toBeInstanceOf(EquippedError)
		})

		test('missing computed dependencies in adapter output fail fast', async () => {
			const { EquippedError } = await import('../../errors/index.js')
			const adapter = InMemoryAdapter.create({})
			const origUse = adapter.use.bind(adapter)
			;(adapter as any).use = vi.fn((schema: any, config: any) => {
				const use = origUse(schema, config)
				return {
					...use,
					findMany: async (filter: any, options: any) => {
						const rows = await use.findMany(filter, options)
						return rows.map((row: any) => {
							const next = { ...row }
							delete (next as any).lastName
							return next
						})
					},
				}
			})

			const repo = Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()
			await repo.on(PersonSchema).one().create({ firstName: 'Katherine', lastName: 'Johnson' })

			await expect(repo.on(PersonSchema).all().select(['fullName']).find()).rejects.toBeInstanceOf(EquippedError)
		})

		test('one().id().find() returns seeded document and null for missing', async () => {
			const TestSchema = Schema.from('findbytest')
				.pk('id', v.string(), () => 'gen')
				.build()
			const adapter = InMemoryAdapter.create({})
			const repo = Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()

			const use = adapter.use(TestSchema, { table: 'findbytest' })
			await use.createOne({ id: 'x' })

			const found = await repo.on(TestSchema).one().id('x').find()
			expect(found).toEqual({ id: 'x' })

			const missing = await repo.on(TestSchema).one().id('missing').find()
			expect(missing).toBeNull()
		})

		describe('schema-per-call create path', () => {
			test('createOne round-trip via one().id().find()', async () => {
				const repo = makeRepo()
				const inserted = await repo.on(UserSchema).one().create({ email: 'rt@test.com', name: 'RoundTrip' })
				expect(inserted.email).toBe('rt@test.com')
				expect(inserted.name).toBe('RoundTrip')
				expect(inserted.id).toBeDefined()

				const found = await repo.on(UserSchema).one().id(inserted.id).find()
				expect(found).not.toBeNull()
				expect(found!.id).toBe(inserted.id)
				expect(found!.email).toBe('rt@test.com')
			})

			test('createOne injects onCreate defaults for missing fields', async () => {
				const repo = makeRepo()
				const inserted = await repo
					.on(UserSchema)
					.one()
					.create({ email: 'defaults@test.com', name: 'Defaults' })
				expect(inserted.createdAt).toBe(1000)
				expect(inserted.id).toBeDefined()
			})

			test('createOne throws OrmValidationError with kind validation and field populated', async () => {
				const { OrmValidationError } = await import('../errors/index.js')
				const repo = makeRepo()
				try {
					await repo
						.on(UserSchema)
						.one()
						.create({ email: 123 as any, name: 'Bad' })
					expect.unreachable()
				} catch (e) {
					expect(e).toBeInstanceOf(OrmValidationError)
					const err = e as InstanceType<typeof OrmValidationError>
					expect(err.kind).toBe('validation')
					expect(err.operation).toBe('createOne')
					expect(err.schema).toBe('users')
					expect(err.failures.length).toBeGreaterThan(0)
					expect(err.failures[0].field).toBe('email')
				}
			})

			test('createMany round-trip via one().id().find()', async () => {
				const repo = makeRepo()
				const inserted = await repo
					.on(UserSchema)
					.all()
					.create([
						{ email: 'a@test.com', name: 'Alice' },
						{ email: 'b@test.com', name: 'Bob' },
					])
				expect(inserted).toHaveLength(2)

				const foundA = await repo.on(UserSchema).one().id(inserted[0].id).find()
				const foundB = await repo.on(UserSchema).one().id(inserted[1].id).find()
				expect(foundA!.email).toBe('a@test.com')
				expect(foundB!.email).toBe('b@test.com')
			})

			test('createMany collects all failures with rowIndex and throws single OrmValidationError', async () => {
				const { OrmValidationError } = await import('../errors/index.js')
				const repo = makeRepo()
				try {
					await repo
						.on(UserSchema)
						.all()
						.create([
							{ email: 'good@test.com', name: 'Good' },
							{ email: 123 as any, name: 'Bad' },
							{ email: 'also-bad' as any, name: 456 as any },
						])
					expect.unreachable()
				} catch (e) {
					expect(e).toBeInstanceOf(OrmValidationError)
					const err = e as InstanceType<typeof OrmValidationError>
					expect(err.kind).toBe('validation')
					expect(err.operation).toBe('createMany')
					expect(err.schema).toBe('users')
					const rowIndices = err.failures.map((f) => f.rowIndex)
					expect(rowIndices).toContain(1)
					expect(rowIndices).toContain(2)
					expect(rowIndices).not.toContain(0)
				}
			})

			test('one().id().find() returns null for non-existent pk', async () => {
				const repo = makeRepo()
				const result = await repo.on(UserSchema).one().id('nonexistent').find()
				expect(result).toBeNull()
			})

			test('createMany with onCreate defaults applied to all rows', async () => {
				const repo = makeRepo()
				const inserted = await repo
					.on(UserSchema)
					.all()
					.create([
						{ email: 'x@test.com', name: 'X' },
						{ email: 'y@test.com', name: 'Y' },
					])
				expect(inserted[0].createdAt).toBe(1000)
				expect(inserted[1].createdAt).toBe(1000)
				expect(inserted[0].id).toBeDefined()
				expect(inserted[1].id).toBeDefined()
			})
		})

		test('one().id().delete() removes and returns document, null for missing', async () => {
			const repo = makeRepo()
			const user = await repo.on(UserSchema).one().create({ email: 'del@test.com', name: 'ToDelete' })

			const deleted = await repo.on(UserSchema).one().id(user.id).delete()
			expect(deleted).toEqual(expect.objectContaining({ id: user.id, name: 'ToDelete' }))

			const found = await repo.on(UserSchema).one().id(user.id).find()
			expect(found).toBeNull()

			const missing = await repo.on(UserSchema).one().id('nonexistent').delete()
			expect(missing).toBeNull()
		})

		test('one().where().update() updates first matching document via filter', async () => {
			const repo = makeRepo()
			await repo
				.on(UserSchema)
				.all()
				.create([
					{ email: 'a@test.com', name: 'Alice' },
					{ email: 'b@test.com', name: 'Bob' },
				])

			const updated = await repo
				.on(UserSchema)
				.one()
				.where((q) => q.eq('name', 'Alice'))
				.update({ name: 'Alicia' })
			expect(updated?.name).toBe('Alicia')
		})

		test('one().where().update() with non-unique filter selects first match', async () => {
			const repo = makeRepo()
			await repo
				.on(UserSchema)
				.all()
				.create([
					{ email: 'a@test.com', name: 'Same' },
					{ email: 'b@test.com', name: 'Same' },
				])

			const updated = await repo
				.on(UserSchema)
				.one()
				.where((q) => q.eq('name', 'Same'))
				.update({ name: 'Changed' })
			expect(updated?.name).toBe('Changed')

			const all = await repo.on(UserSchema).all().find()
			const changedCount = all.filter((u) => u.name === 'Changed').length
			expect(changedCount).toBe(1)
		})

		test('all().where().update() updates all matching documents', async () => {
			const repo = makeRepo()
			await repo
				.on(UserSchema)
				.all()
				.create([
					{ email: 'a@test.com', name: 'Same' },
					{ email: 'b@test.com', name: 'Same' },
					{ email: 'c@test.com', name: 'Different' },
				])

			const updated = await repo
				.on(UserSchema)
				.all()
				.where((q) => q.eq('name', 'Same'))
				.update({ name: 'Updated' })
			expect(updated).toHaveLength(2)
			expect(updated.every((u) => u.name === 'Updated')).toBe(true)
		})

		test('all().where().update() applies auto-bump for onUpdate fields', async () => {
			const AutoSchema = Schema.from('auto')
				.pk('id', v.string(), () => `a${++userCounter}`)
				.field('name', v.string())
				.field('updatedAt', v.number(), { onCreate: () => 0, onUpdate: () => 9999 })
				.build()
			const repo = makeRepo()
			await repo.on(AutoSchema).one().create({ name: 'A' })

			const updated = await repo
				.on(AutoSchema)
				.all()
				.where((q) => q.eq('name', 'A'))
				.update({ name: 'B' })
			expect(updated[0].updatedAt).toBe(9999)
		})

		test('one().where().delete() removes first matching document', async () => {
			const repo = makeRepo()
			await repo
				.on(UserSchema)
				.all()
				.create([
					{ email: 'a@test.com', name: 'Alice' },
					{ email: 'b@test.com', name: 'Bob' },
				])

			const deleted = await repo
				.on(UserSchema)
				.one()
				.where((q) => q.eq('name', 'Alice'))
				.delete()
			expect(deleted?.name).toBe('Alice')

			const remaining = await repo.on(UserSchema).all().find()
			expect(remaining).toHaveLength(1)
		})

		test('all().where().delete() removes all matching and returns them', async () => {
			const repo = makeRepo()
			await repo
				.on(UserSchema)
				.all()
				.create([
					{ email: 'a@test.com', name: 'ToDelete' },
					{ email: 'b@test.com', name: 'ToDelete' },
					{ email: 'c@test.com', name: 'Keep' },
				])

			const deleted = await repo
				.on(UserSchema)
				.all()
				.where((q) => q.eq('name', 'ToDelete'))
				.delete()
			expect(deleted).toHaveLength(2)

			const remaining = await repo.on(UserSchema).all().find()
			expect(remaining).toHaveLength(1)
			expect(remaining[0].name).toBe('Keep')
		})

		test('round-trip update via filter preserves data integrity', async () => {
			const repo = makeRepo()
			const user = await repo.on(UserSchema).one().create({ email: 'rt@test.com', name: 'Original' })

			await repo
				.on(UserSchema)
				.one()
				.where((q) => q.eq('id', user.id))
				.update({ name: 'Modified' })

			const found = await repo.on(UserSchema).one().id(user.id).find()
			expect(found?.name).toBe('Modified')
			expect(found?.email).toBe('rt@test.com')
		})
	})

	describe('type-level: per-op gating on FilterGroup', () => {
		test('undeclared filter op is never on GatedFilterGroup', () => {
			const { GatedFilterGroup: _type } = {} as any
			type EqOnlyOps = readonly ['eq']
			type Gated = import('../filter.js').GatedFilterGroup<EqOnlyOps>
			expectTypeOf<Gated['eq']>().not.toBeNever()
			expectTypeOf<Gated['ne']>().toBeNever()
			expectTypeOf<Gated['gt']>().toBeNever()
			expectTypeOf<Gated['and']>().not.toBeNever()
			expectTypeOf<Gated['or']>().not.toBeNever()
		})

		test('all declared ops are available, undeclared are never', () => {
			type TwoOps = readonly ['eq', 'gt']
			type Gated = import('../filter.js').GatedFilterGroup<TwoOps>
			expectTypeOf<Gated['eq']>().not.toBeNever()
			expectTypeOf<Gated['gt']>().not.toBeNever()
			expectTypeOf<Gated['ne']>().toBeNever()
			expectTypeOf<Gated['lt']>().toBeNever()
			expectTypeOf<Gated['in']>().toBeNever()
		})
	})

	describe('type-level: missing queryableOps yields empty ops', () => {
		test('adapter without queryableOps yields empty InferAdapterQueryableOps', () => {
			class MinimalAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string'] as const
				readonly queryableOps = [] as const
			}
			type Ops = import('../adapter.js').InferAdapterQueryableOps<MinimalAdapter>
			expectTypeOf<Ops>().toEqualTypeOf<readonly []>()
		})
	})

	describe('type-level: method gating via class-based adapter', () => {
		test('adapter with findMany enables all().find()', () => {
			class FindAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string'] as const
				readonly queryableOps = ['eq'] as const
				async findMany() {
					return []
				}
			}
			type A = FindAdapter
			type S = import('../schema.js').AnySchema
			type All = import('./builders.js').AllBuilderSurface<S, A>
			expectTypeOf<All['find']>().toBeFunction()
		})

		test('adapter with iterateMany enables all().iterate(options?)', () => {
			class IterateAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string'] as const
				readonly queryableOps = ['eq'] as const
				async *iterateMany() {}
			}
			type A = IterateAdapter
			type S = import('../schema.js').AnySchema
			type All = import('./builders.js').AllBuilderSurface<S, A>
			expectTypeOf<All['iterate']>().toBeFunction()
			expectTypeOf<Parameters<All['iterate']>>().toEqualTypeOf<[options?: IterationOptions]>()
			expectTypeOf<ReturnType<All['iterate']>>().toEqualTypeOf<
				AsyncGenerator<import('./internals/types.js').SelectedWithPreloads<S, never, []>, void, void>
			>()
		})

		test('iterate exists only on AllBuilder and has no CDC-style sibling methods', () => {
			class IterateAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string'] as const
				readonly queryableOps = ['eq'] as const
				async *iterateMany() {}
			}
			type A = IterateAdapter
			type S = import('../schema.js').AnySchema
			type One = import('./builders.js').OneBuilderSurface<S, A>
			type All = import('./builders.js').AllBuilderSurface<S, A>
			type OneHasIterate = 'iterate' extends keyof One ? true : false
			type CdcKeys = Extract<'stream' | 'watch' | 'subscribe' | 'changeFeed', keyof All>
			expectTypeOf<OneHasIterate>().toEqualTypeOf<false>()
			expectTypeOf<CdcKeys>().toBeNever()
		})

		test('missing iterateMany collapses all().iterate to never', () => {
			class FindOnlyAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string'] as const
				readonly queryableOps = ['eq'] as const
				async findMany() {
					return []
				}
			}
			type A = FindOnlyAdapter
			type S = import('../schema.js').AnySchema
			type All = import('./builders.js').AllBuilderSurface<S, A>
			expectTypeOf<All['iterate']>().toBeNever()
		})

		test('missing updateMany collapses one().update and all().update to never', () => {
			class ReadOnlyAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string'] as const
				async findMany() {
					return []
				}
			}
			type A = ReadOnlyAdapter
			type S = import('../schema.js').AnySchema
			type One = import('./builders.js').OneBuilderSurface<S, A>
			type All = import('./builders.js').AllBuilderSurface<S, A>
			expectTypeOf<One['update']>().toBeNever()
			expectTypeOf<All['update']>().toBeNever()
		})

		test('missing deleteMany collapses one().delete and all().delete to never', () => {
			class NoDeleteAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string'] as const
				async findMany() {
					return []
				}
			}
			type A = NoDeleteAdapter
			type S = import('../schema.js').AnySchema
			type One = import('./builders.js').OneBuilderSurface<S, A>
			type All = import('./builders.js').AllBuilderSurface<S, A>
			expectTypeOf<One['delete']>().toBeNever()
			expectTypeOf<All['delete']>().toBeNever()
		})

		test('missing raw collapses schemaRef.raw to never', () => {
			class NoRawAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string'] as const
				async findMany() {
					return []
				}
			}
			type A = NoRawAdapter
			type Ref = import('./builders.js').SchemaRefSurface<import('../schema.js').AnySchema, A>
			expectTypeOf<Ref['raw']>().toBeNever()
		})

		test('missing upsertOne collapses one().upsert to never', () => {
			class NoUpsertAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string'] as const
				readonly queryableOps = ['eq'] as const
				async findMany() {
					return []
				}
			}
			type A = NoUpsertAdapter
			type S = import('../schema.js').AnySchema
			type One = import('./builders.js').OneBuilderSurface<S, A>
			expectTypeOf<One['upsert']>().toBeNever()
		})

		test('adapter with updateMany enables one().update and all().update', () => {
			class WithUpdateAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string'] as const
				readonly queryableOps = ['eq'] as const
				async findMany() {
					return []
				}
				async updateMany() {
					return []
				}
			}
			type A = WithUpdateAdapter
			type S = import('../schema.js').AnySchema
			type One = import('./builders.js').OneBuilderSurface<S, A>
			type All = import('./builders.js').AllBuilderSurface<S, A>
			expectTypeOf<One['update']>().toBeFunction()
			expectTypeOf<All['update']>().toBeFunction()
		})

		test('adapter with deleteMany enables one().delete and all().delete', () => {
			class WithDeleteAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string'] as const
				readonly queryableOps = ['eq'] as const
				async findMany() {
					return []
				}
				async deleteMany() {
					return []
				}
			}
			type A = WithDeleteAdapter
			type S = import('../schema.js').AnySchema
			type One = import('./builders.js').OneBuilderSurface<S, A>
			type All = import('./builders.js').AllBuilderSurface<S, A>
			expectTypeOf<One['delete']>().toBeFunction()
			expectTypeOf<All['delete']>().toBeFunction()
		})

		test('missing count collapses all().count to never', () => {
			class NoCountAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string'] as const
				readonly queryableOps = ['eq'] as const
				async findMany() {
					return []
				}
			}
			type A = NoCountAdapter
			type S = import('../schema.js').AnySchema
			type All = import('./builders.js').AllBuilderSurface<S, A>
			expectTypeOf<All['count']>().toBeNever()
		})

		test('adapter with count enables all().count', () => {
			class WithCountAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string'] as const
				readonly queryableOps = ['eq'] as const
				async findMany() {
					return []
				}
				async count() {
					return 0
				}
			}
			type A = WithCountAdapter
			type S = import('../schema.js').AnySchema
			type All = import('./builders.js').AllBuilderSurface<S, A>
			expectTypeOf<All['count']>().toBeFunction()
		})

		test('adapter with raw enables schemaRef.raw', () => {
			class WithRawAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string'] as const
				async raw(_s: any, _c: any, _command: string) {
					return { rows: [] }
				}
			}
			type A = WithRawAdapter
			type Ref = import('./builders.js').SchemaRefSurface<import('../schema.js').AnySchema, A>
			expectTypeOf<Ref['raw']>().toBeFunction()
		})

		test('adapter raw signature drives arg-tuple inference on schemaRef.raw', () => {
			class TypedRawAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ table: v.string() })
				readonly supportedFieldTypes = ['string'] as const
				async raw(_s: any, _c: any, _sql: string, _params: number[]) {
					return [42]
				}
			}
			type A = TypedRawAdapter
			type Ref = import('./builders.js').SchemaRefSurface<import('../schema.js').AnySchema, A>
			expectTypeOf<Ref['raw']>().toBeFunction()
			expectTypeOf<Ref['raw']>().parameters.toEqualTypeOf<[sql: string, params: number[]]>()
		})

		test('per-call <T> override narrows raw return type', () => {
			class DefaultRawAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ table: v.string() })
				readonly supportedFieldTypes = ['string'] as const
				async raw(_s: any, _c: any, _sql: string) {
					return { rows: [] as unknown[] }
				}
			}
			type A = DefaultRawAdapter
			type Ref = import('./builders.js').SchemaRefSurface<import('../schema.js').AnySchema, A>
			expectTypeOf<Ref['raw']>().toBeFunction()
			expectTypeOf<Ref['raw']>().parameters.toEqualTypeOf<[sql: string]>()
		})

		test('adapter with zero-arg raw infers empty arg tuple', () => {
			class ZeroArgRawAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string'] as const
				async raw(_s: any, _c: any) {
					return 'pong'
				}
			}
			type A = ZeroArgRawAdapter
			type Ref = import('./builders.js').SchemaRefSurface<import('../schema.js').AnySchema, A>
			expectTypeOf<Ref['raw']>().parameters.toEqualTypeOf<[]>()
			expectTypeOf<Ref['raw']>().toBeFunction()
		})

		test('gating survives through select() chains', () => {
			class MinimalAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string'] as const
			}
			type A = MinimalAdapter
			const _TestSchema = Schema.from('test')
				.pk('id', v.string(), () => 'x')
				.field('name', v.string())
				.build()
			type S = typeof _TestSchema
			type One = import('./builders.js').OneBuilderSurface<S, A, 'id'>
			type All = import('./builders.js').AllBuilderSurface<S, A, 'id'>
			expectTypeOf<One['update']>().toBeNever()
			expectTypeOf<One['delete']>().toBeNever()
			expectTypeOf<All['update']>().toBeNever()
			expectTypeOf<All['delete']>().toBeNever()
		})
	})

	describe('type-level: aggregate gating', () => {
		test('adapter with aggregateOps = [] narrows repo.on(S).aggregate to never', () => {
			class EmptyAggAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string'] as const
				readonly aggregateOps = [] as const
			}
			type A = EmptyAggAdapter
			type Ref = import('./builders.js').SchemaRefSurface<import('../schema.js').AnySchema, A>
			expectTypeOf<Ref['aggregate']>().toBeNever()
		})

		test('adapter with aggregate method and non-empty aggregateOps narrows to callable', () => {
			class FullAggAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string', 'number'] as const
				readonly aggregateOps = ['count', 'sum'] as const
				async aggregate() {
					return []
				}
			}
			type A = FullAggAdapter
			type Ref = import('./builders.js').SchemaRefSurface<import('../schema.js').AnySchema, A>
			expectTypeOf<Ref['aggregate']>().toBeFunction()
		})

		test('adapter with aggregate method but empty aggregateOps narrows to never', () => {
			class MethodOnlyAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string'] as const
				readonly aggregateOps = [] as const
				async aggregate() {
					return []
				}
			}
			type A = MethodOnlyAdapter
			type Ref = import('./builders.js').SchemaRefSurface<import('../schema.js').AnySchema, A>
			expectTypeOf<Ref['aggregate']>().toBeNever()
		})

		test('adapter with non-empty aggregateOps but no aggregate method narrows to never', () => {
			class OpsOnlyAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string'] as const
				readonly aggregateOps = ['count'] as const
			}
			type A = OpsOnlyAdapter
			type Ref = import('./builders.js').SchemaRefSurface<import('../schema.js').AnySchema, A>
			expectTypeOf<Ref['aggregate']>().toBeNever()
		})

		test('default aggregateOps on OrmAdapter is empty, so aggregate is never by default', () => {
			class DefaultAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string'] as const
			}
			type A = DefaultAdapter
			type Ref = import('./builders.js').SchemaRefSurface<import('../schema.js').AnySchema, A>
			expectTypeOf<Ref['aggregate']>().toBeNever()
		})
	})

	describe('type-level: AggregateBuilder', () => {
		class AggAdapter extends OrmAdapter {
			readonly schemaConfigPipe = v.object({})
			readonly supportedFieldTypes = ['string', 'number', 'boolean', 'object', 'array'] as const
			readonly aggregateOps = ['count', 'countDistinct', 'sum', 'avg', 'min', 'max'] as const
			async aggregate() {
				return []
			}
		}
		const _S = Schema.from('items')
			.pk('id', v.string(), () => 'x')
			.field('name', v.string())
			.field('amount', v.number())
			.field('active', v.boolean())
			.field('tags', v.array(v.string()))
			.field('meta', v.object({ x: v.number() }))
			.build()
		type S = typeof _S
		type A = AggAdapter
		type Builder = import('./builders.js').AggregateBuilder<S, A, {}, {}, false>

		test('.count(alias) adds alias to result type as number', () => {
			type AfterCount = ReturnType<Builder['count']>
			type Result = Awaited<ReturnType<AfterCount['run']>>
			expectTypeOf<Result>().toHaveProperty('total')
		})

		test('duplicate alias: "a" extends keyof Aggs triggers never guard', () => {
			type AggsWithA = { a: number }
			type DuplicateGuard = 'a' extends keyof AggsWithA ? [never] : [alias: 'a']
			expectTypeOf<DuplicateGuard>().toEqualTypeOf<[never]>()
		})

		test('.run() on empty Aggs requires never arg (compile error gate)', () => {
			type RunParams = Parameters<Builder['run']>
			expectTypeOf<RunParams>().toEqualTypeOf<[never]>()
		})

		test('.run() on non-empty Aggs takes no args', () => {
			type WithCount = import('./builders.js').AggregateBuilder<S, A, { total: number }, {}, false>
			type RunParams = Parameters<WithCount['run']>
			expectTypeOf<RunParams>().toEqualTypeOf<[]>()
		})

		test('.run() returns single object when HasGroupBy = false', () => {
			type WithCount = import('./builders.js').AggregateBuilder<S, A, { total: number }, {}, false>
			type Result = Awaited<ReturnType<WithCount['run']>>
			expectTypeOf<Result>().toEqualTypeOf<{ total: number }>()
		})

		test('.run() returns array when HasGroupBy = true', () => {
			type WithGroupBy = import('./builders.js').AggregateBuilder<S, A, { total: number }, { name: string }, true>
			type Result = Awaited<ReturnType<WithGroupBy['run']>>
			expectTypeOf<Result>().toEqualTypeOf<({ total: number } & { name: string })[]>()
		})

		test('group-key fields appear in result row with schema-declared types', () => {
			type WithGroupBy = import('./builders.js').AggregateBuilder<
				S,
				A,
				{ total: number },
				{ name: string; amount: number },
				true
			>
			type Result = Awaited<ReturnType<WithGroupBy['run']>>
			type Row = Result[number]
			expectTypeOf<Row>().toHaveProperty('total')
			expectTypeOf<Row>().toHaveProperty('name')
			expectTypeOf<Row>().toHaveProperty('amount')
		})

		test('.sum rejects string field (field-type constraint)', () => {
			type SumFieldParam = Parameters<Builder['sum']>[0]
			type IsAccepted = typeof _S.fields.name extends SumFieldParam ? true : false
			expectTypeOf<IsAccepted>().toEqualTypeOf<false>()
		})

		test('.avg rejects string field (field-type constraint)', () => {
			type AvgFieldParam = Parameters<Builder['avg']>[0]
			type IsAccepted = typeof _S.fields.name extends AvgFieldParam ? true : false
			expectTypeOf<IsAccepted>().toEqualTypeOf<false>()
		})

		test('.min rejects array field', () => {
			type MinFieldParam = Parameters<Builder['min']>[0]
			type IsAccepted = typeof _S.fields.tags extends MinFieldParam ? true : false
			expectTypeOf<IsAccepted>().toEqualTypeOf<false>()
		})

		test('.max rejects object field', () => {
			type MaxFieldParam = Parameters<Builder['max']>[0]
			type IsAccepted = typeof _S.fields.meta extends MaxFieldParam ? true : false
			expectTypeOf<IsAccepted>().toEqualTypeOf<false>()
		})

		test('.where().where() is a compile error', () => {
			type AfterWhere = import('./builders.js').AggregateBuilder<S, A, {}, {}, false, true, false>
			type WhereParams = Parameters<AfterWhere['where']>
			expectTypeOf<WhereParams>().toEqualTypeOf<[never]>()
		})

		test('.having().having() is a compile error', () => {
			type AfterHaving = import('./builders.js').AggregateBuilder<S, A, {}, {}, false, false, true>
			type HavingParams = Parameters<AfterHaving['having']>
			expectTypeOf<HavingParams>().toEqualTypeOf<[never]>()
		})

		test('.groupBy().groupBy() is a compile error', () => {
			type AfterGroupBy = import('./builders.js').AggregateBuilder<S, A, {}, { name: string }, true, false, false>
			type GroupByParams = Parameters<AfterGroupBy['groupBy']>
			expectTypeOf<GroupByParams>().toEqualTypeOf<[never]>()
		})

		test('clone-on-step: .where() returns a new builder', () => {
			type After = ReturnType<Builder['where']>
			expectTypeOf<After>().toMatchTypeOf<
				import('./builders.js').AggregateBuilder<S, A, {}, {}, false, true, false>
			>()
		})
	})

	describe('repo.on().all().where().find() end-to-end', () => {
		const TestSchema = Schema.from('e2e')
			.pk('id', v.string(), () => `e-${Math.random().toString(36).slice(2)}`)
			.field('name', v.string())
			.field('age', v.number())
			.field('active', v.boolean())
			.field('tags', v.array(v.string()))
			.field('score', v.optional(v.number()), { onCreate: () => undefined })
			.build()

		function makeE2eRepo() {
			const adapter = InMemoryAdapter.create({})
			const repo = Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()
			return { repo, adapter }
		}

		async function seedData(repo: any) {
			await repo
				.on(TestSchema)
				.all()
				.create([
					{ name: 'Alice', age: 30, active: true, tags: ['admin', 'user'] },
					{ name: 'Bob', age: 20, active: false, tags: ['user'] },
					{ name: 'Carol', age: 40, active: true, tags: ['admin'] },
					{ name: 'Dave', age: 25, active: true, tags: ['user', 'guest'], score: 100 },
				])
		}

		test('all().where().find() returns matching documents', async () => {
			const { repo } = makeE2eRepo()
			await seedData(repo)
			const results = await repo
				.on(TestSchema)
				.all()
				.where((q) => q.eq(TestSchema.fields.active, true))
				.find()
			expect(results).toHaveLength(3)
			expect(results.every((r) => r.active === true)).toBe(true)
		})

		test('one().where().find() returns first matching document', async () => {
			const { repo } = makeE2eRepo()
			await seedData(repo)
			const result = await repo
				.on(TestSchema)
				.one()
				.where((q) => q.eq(TestSchema.fields.name, 'Bob'))
				.find()
			expect(result).not.toBeNull()
			expect(result!.name).toBe('Bob')
		})

		test('one().where().find() returns null when no match', async () => {
			const { repo } = makeE2eRepo()
			await seedData(repo)
			const result = await repo
				.on(TestSchema)
				.one()
				.where((q) => q.eq(TestSchema.fields.name, 'Nobody'))
				.find()
			expect(result).toBeNull()
		})

		test('eq filter op matches exact value', async () => {
			const { repo } = makeE2eRepo()
			await seedData(repo)
			const results = await repo
				.on(TestSchema)
				.all()
				.where((q) => q.eq(TestSchema.fields.age, 30))
				.find()
			expect(results).toHaveLength(1)
			expect(results[0].name).toBe('Alice')
		})

		test('ne filter op excludes matching values', async () => {
			const { repo } = makeE2eRepo()
			await seedData(repo)
			const results = await repo
				.on(TestSchema)
				.all()
				.where((q) => q.ne(TestSchema.fields.name, 'Alice'))
				.find()
			expect(results).toHaveLength(3)
			expect(results.every((r) => r.name !== 'Alice')).toBe(true)
		})

		test('gt filter op matches values greater than', async () => {
			const { repo } = makeE2eRepo()
			await seedData(repo)
			const results = await repo
				.on(TestSchema)
				.all()
				.where((q) => q.gt(TestSchema.fields.age, 25))
				.find()
			expect(results.map((r) => r.name).sort()).toEqual(['Alice', 'Carol'])
		})

		test('gte filter op matches values greater than or equal', async () => {
			const { repo } = makeE2eRepo()
			await seedData(repo)
			const results = await repo
				.on(TestSchema)
				.all()
				.where((q) => q.gte(TestSchema.fields.age, 30))
				.find()
			expect(results.map((r) => r.name).sort()).toEqual(['Alice', 'Carol'])
		})

		test('lt filter op matches values less than', async () => {
			const { repo } = makeE2eRepo()
			await seedData(repo)
			const results = await repo
				.on(TestSchema)
				.all()
				.where((q) => q.lt(TestSchema.fields.age, 25))
				.find()
			expect(results).toHaveLength(1)
			expect(results[0].name).toBe('Bob')
		})

		test('lte filter op matches values less than or equal', async () => {
			const { repo } = makeE2eRepo()
			await seedData(repo)
			const results = await repo
				.on(TestSchema)
				.all()
				.where((q) => q.lte(TestSchema.fields.age, 25))
				.find()
			expect(results.map((r) => r.name).sort()).toEqual(['Bob', 'Dave'])
		})

		test('in filter op matches values in array', async () => {
			const { repo } = makeE2eRepo()
			await seedData(repo)
			const results = await repo
				.on(TestSchema)
				.all()
				.where((q) => q.in(TestSchema.fields.name, ['Alice', 'Carol']))
				.find()
			expect(results.map((r) => r.name).sort()).toEqual(['Alice', 'Carol'])
		})

		test('notIn filter op excludes values in array', async () => {
			const { repo } = makeE2eRepo()
			await seedData(repo)
			const results = await repo
				.on(TestSchema)
				.all()
				.where((q) => q.notIn(TestSchema.fields.name, ['Alice', 'Carol']))
				.find()
			expect(results.map((r) => r.name).sort()).toEqual(['Bob', 'Dave'])
		})

		test('like filter op matches substring case-insensitively', async () => {
			const { repo } = makeE2eRepo()
			await seedData(repo)
			const results = await repo
				.on(TestSchema)
				.all()
				.where((q) => q.like(TestSchema.fields.name, 'ali'))
				.find()
			expect(results).toHaveLength(1)
			expect(results[0].name).toBe('Alice')
		})

		test('like filter op treats pattern characters as literal text', async () => {
			const { repo } = makeE2eRepo()
			await repo.on(TestSchema).one().create({ name: 'A.B', age: 10, active: true, tags: [] })
			await repo.on(TestSchema).one().create({ name: 'ACB', age: 10, active: true, tags: [] })

			const results = await repo
				.on(TestSchema)
				.all()
				.where((q) => q.like(TestSchema.fields.name, 'a.b'))
				.find()

			expect(results.map((result) => result.name)).toEqual(['A.B'])
		})

		test('exists filter op matches non-null values', async () => {
			const { repo } = makeE2eRepo()
			await seedData(repo)
			const results = await repo
				.on(TestSchema)
				.all()
				.where((q) => q.exists(TestSchema.fields.score))
				.find()
			expect(results).toHaveLength(1)
			expect(results[0].name).toBe('Dave')
		})

		test('notExists filter op matches null/undefined values', async () => {
			const { repo } = makeE2eRepo()
			await seedData(repo)
			const results = await repo
				.on(TestSchema)
				.all()
				.where((q) => q.notExists(TestSchema.fields.score))
				.find()
			expect(results).toHaveLength(3)
		})

		test('contains filter op matches array subset', async () => {
			const { repo } = makeE2eRepo()
			await seedData(repo)
			const results = await repo
				.on(TestSchema)
				.all()
				.where((q) => q.contains('tags', ['admin']))
				.find()
			expect(results.map((r) => r.name).sort()).toEqual(['Alice', 'Carol'])
		})

		test('notContains filter op excludes array subset', async () => {
			const { repo } = makeE2eRepo()
			await seedData(repo)
			const results = await repo
				.on(TestSchema)
				.all()
				.where((q) => q.notContains('tags', ['admin']))
				.find()
			expect(results.map((r) => r.name).sort()).toEqual(['Bob', 'Dave'])
		})

		test('and combinator requires all conditions', async () => {
			const { repo } = makeE2eRepo()
			await seedData(repo)
			const results = await repo
				.on(TestSchema)
				.all()
				.where((q) =>
					q.and([(g) => g.gt(TestSchema.fields.age, 20), (g) => g.eq(TestSchema.fields.active, true)]),
				)
				.find()
			expect(results.map((r) => r.name).sort()).toEqual(['Alice', 'Carol', 'Dave'])
		})

		test('or combinator matches any condition', async () => {
			const { repo } = makeE2eRepo()
			await seedData(repo)
			const results = await repo
				.on(TestSchema)
				.all()
				.where((q) =>
					q.or([(g) => g.eq(TestSchema.fields.name, 'Alice'), (g) => g.eq(TestSchema.fields.name, 'Bob')]),
				)
				.find()
			expect(results.map((r) => r.name).sort()).toEqual(['Alice', 'Bob'])
		})

		test('raw-string field overload works end-to-end', async () => {
			const { repo } = makeE2eRepo()
			await seedData(repo)
			const results = await repo
				.on(TestSchema)
				.all()
				.where((q) => q.eq('name', 'Alice'))
				.find()
			expect(results).toHaveLength(1)
			expect(results[0].name).toBe('Alice')
		})

		test('empty and([]) throws at builder time', async () => {
			const { repo } = makeE2eRepo()
			await seedData(repo)
			expect(() =>
				repo
					.on(TestSchema)
					.all()
					.where((q) => q.and([]))
					.find(),
			).toThrow()
		})

		test('empty or([]) throws at builder time', async () => {
			const { repo } = makeE2eRepo()
			await seedData(repo)
			expect(() =>
				repo
					.on(TestSchema)
					.all()
					.where((q) => q.or([]))
					.find(),
			).toThrow()
		})

		test('unknown field in filter throws OrmValidationError at boundary', async () => {
			const { OrmValidationError: OrmValErr } = await import('../errors/index.js')
			const { repo } = makeE2eRepo()
			await seedData(repo)
			await expect(
				repo
					.on(TestSchema)
					.all()
					.where((q) => q.eq('nonexistentField', 42))
					.find(),
			).rejects.toBeInstanceOf(OrmValErr)
		})
	})

	describe('one().id().update() (replaces updateByPk)', () => {
		let viewCounter = 0
		const ItemSchema = Schema.from('items')
			.pk('id', v.string(), () => `item-${++viewCounter}`)
			.field('title', v.string())
			.field('views', v.number())
			.field('updatedAt', v.number(), { onCreate: () => 1000, onUpdate: () => Date.now() })
			.build()

		function makeUpdateRepo() {
			const adapter = InMemoryAdapter.create({})
			return Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()
		}

		test('round-trip update via one().id().update()', async () => {
			const repo = makeUpdateRepo()
			const item = await repo.on(ItemSchema).one().create({ title: 'Hello', views: 0 })
			const updated = await repo.on(ItemSchema).one().id(item.id).update({ title: 'Updated' })
			expect(updated).not.toBeNull()
			expect(updated!.title).toBe('Updated')
			expect(updated!.views).toBe(0)

			const found = await repo.on(ItemSchema).one().id(item.id).find()
			expect(found!.title).toBe('Updated')
		})

		test('auto-bump injects updatedAt on un-touched onUpdate field', async () => {
			const repo = makeUpdateRepo()
			const item = await repo.on(ItemSchema).one().create({ title: 'Hello', views: 0 })
			const before = item.updatedAt

			const updated = await repo.on(ItemSchema).one().id(item.id).update({ title: 'Changed' })
			expect(updated!.updatedAt).not.toBe(before)
			expect(updated!.updatedAt).toBeGreaterThanOrEqual(before)
		})

		test('user set({updatedAt:X}) suppresses auto-bump', async () => {
			const repo = makeUpdateRepo()
			const item = await repo.on(ItemSchema).one().create({ title: 'Hello', views: 0 })

			const updated = await repo.on(ItemSchema).one().id(item.id).update({ updatedAt: 9999 })
			expect(updated!.updatedAt).toBe(9999)
		})

		test('update with inc op via SchemaUpdateInput', async () => {
			const { IncOp } = await import('../updates.js')
			const repo = makeUpdateRepo()
			const item = await repo.on(ItemSchema).one().create({ title: 'Hello', views: 10 })

			const updated = await repo
				.on(ItemSchema)
				.one()
				.id(item.id)
				.update({ views: new IncOp('views', 5) })
			expect(updated!.views).toBe(15)
		})

		test('update returns null for missing pk', async () => {
			const repo = makeUpdateRepo()
			const result = await repo.on(ItemSchema).one().id('nonexistent').update({ title: 'X' })
			expect(result).toBeNull()
		})
	})

	describe('one().where().upsert() (replaces upsertOne)', () => {
		let upsertCounter = 0

		const UpsertSchema = Schema.from('upserts')
			.pk('id', v.string(), () => `up-${++upsertCounter}`)
			.field('email', v.string())
			.field('name', v.string())
			.field('views', v.number())
			.field('createdAt', v.number(), { onCreate: () => 1000 })
			.field('updatedAt', v.number(), { onCreate: () => 1000, onUpdate: () => 9999 })
			.build()

		function makeUpsertRepo() {
			const adapter = InMemoryAdapter.create({})
			return Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()
		}

		test('create-then-update path: row missing → inserts and applies update', async () => {
			const repo = makeUpsertRepo()

			const result = await repo
				.on(UpsertSchema)
				.one()
				.where((q) => q.eq('email', 'alice@test.com'))
				.upsert({
					create: { email: 'alice@test.com', name: 'Alice', views: 0 },
					update: { name: 'Alice Updated' },
				})

			expect(result.email).toBe('alice@test.com')
			expect(result.name).toBe('Alice Updated')
			expect(result.createdAt).toBe(1000)
		})

		test('create path with set value overriding create field is allowed', async () => {
			const repo = makeUpsertRepo()

			const result = await repo
				.on(UpsertSchema)
				.one()
				.where((q) => q.eq('email', 'override@test.com'))
				.upsert({
					create: { email: 'override@test.com', name: 'Original', views: 0 },
					update: { views: 42 },
				})

			expect(result.views).toBe(42)
			expect(result.name).toBe('Original')
		})

		test('update-only-on-exists path: row exists → ignores create, applies update + auto-bump', async () => {
			const repo = makeUpsertRepo()

			await repo.on(UpsertSchema).one().create({ email: 'bob@test.com', name: 'Bob', views: 42 })

			const result = await repo
				.on(UpsertSchema)
				.one()
				.where((q) => q.eq('email', 'bob@test.com'))
				.upsert({
					create: { email: 'bob@test.com', name: 'IGNORED', views: 0 },
					update: { name: 'Bob Updated' },
				})

			expect(result.name).toBe('Bob Updated')
			expect(result.views).toBe(42)
			expect(result.updatedAt).toBe(9999)
		})

		test('create-vs-op conflict throws OrmValidationError with kind conflicting-ops', async () => {
			const { IncOp } = await import('../updates.js')
			const { OrmValidationError } = await import('../errors/index.js')
			const repo = makeUpsertRepo()

			try {
				await repo
					.on(UpsertSchema)
					.one()
					.where((q) => q.eq('email', 'conflict@test.com'))
					.upsert({
						create: { email: 'conflict@test.com', name: 'Conflict', views: 0 },
						update: { views: new IncOp('views', 1) },
					})
				expect.unreachable()
			} catch (e) {
				expect(e).toBeInstanceOf(OrmValidationError)
				const err = e as InstanceType<typeof OrmValidationError>
				expect(err.kind).toBe('conflicting-ops')
				expect(err.operation).toBe('upsertOne')
				expect(err.failures[0].field).toBe('views')
			}
		})

		test('empty-update-allowed: create with no update is allowed', async () => {
			const repo = makeUpsertRepo()

			const result = await repo
				.on(UpsertSchema)
				.one()
				.where((q) => q.eq('email', 'noops@test.com'))
				.upsert({ create: { email: 'noops@test.com', name: 'NoOps', views: 0 } })

			expect(result.email).toBe('noops@test.com')
			expect(result.name).toBe('NoOps')
		})

		test('empty-update-allowed: if exists do nothing', async () => {
			const repo = makeUpsertRepo()

			await repo.on(UpsertSchema).one().create({ email: 'exists@test.com', name: 'Original', views: 5 })

			const result = await repo
				.on(UpsertSchema)
				.one()
				.where((q) => q.eq('email', 'exists@test.com'))
				.upsert({ create: { email: 'exists@test.com', name: 'IGNORED', views: 0 } })

			expect(result.name).toBe('Original')
			expect(result.views).toBe(5)
		})

		test('upsert-returns-document rule: returns resulting document', async () => {
			const repo = makeUpsertRepo()

			const insertResult = await repo
				.on(UpsertSchema)
				.one()
				.where((q) => q.eq('email', 'doc@test.com'))
				.upsert({ create: { email: 'doc@test.com', name: 'Doc', views: 0 } })
			expect(insertResult.id).toBeDefined()
			expect(insertResult.email).toBe('doc@test.com')

			const updateResult = await repo
				.on(UpsertSchema)
				.one()
				.where((q) => q.eq('email', 'doc@test.com'))
				.upsert({
					create: { email: 'doc@test.com', name: 'IGNORED', views: 0 },
					update: { name: 'DocUpdated' },
				})
			expect(updateResult.id).toBe(insertResult.id)
			expect(updateResult.name).toBe('DocUpdated')
		})

		test('validates create payload via validateCreate (onCreate defaults injected)', async () => {
			const repo = makeUpsertRepo()

			const result = await repo
				.on(UpsertSchema)
				.one()
				.where((q) => q.eq('email', 'defaults@test.com'))
				.upsert({ create: { email: 'defaults@test.com', name: 'Defaults', views: 0 } })

			expect(result.id).toBeDefined()
			expect(result.createdAt).toBe(1000)
		})

		test('validates create payload and throws OrmValidationError on invalid', async () => {
			const { OrmValidationError } = await import('../errors/index.js')
			const repo = makeUpsertRepo()

			await expect(
				repo
					.on(UpsertSchema)
					.one()
					.where((q) => q.eq('email', 'bad@test.com'))
					.upsert({ create: { email: 123 as any, name: 'Bad', views: 0 } }),
			).rejects.toBeInstanceOf(OrmValidationError)
		})

		test('upsert-filter-incompatible error from adapter boundary', async () => {
			const { OrmValidationError } = await import('../errors/index.js')

			const spy = mockInstance()
			class RestrictedAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ table: v.string() })
				readonly supportedFieldTypes = ['string', 'number', 'boolean'] as const
				readonly queryableOps = ['eq'] as const
				readonly updateOps = ['set'] as const
				async findMany() {
					return []
				}
				async upsertOne(
					_schema: any,
					_config: any,
					_filter: any,
					_create: any,
					_ops: any,
				): Promise<Record<string, unknown>> {
					throw new OrmValidationError('upsert-filter-incompatible', 'test', 'upsertOne', [
						{ cause: 'adapter requires single eq filter on unique column, received complex filter' },
					])
				}
			}
			const restrictedAdapter = new (RestrictedAdapter as any)() as InstanceType<typeof RestrictedAdapter>
			spy.mockRestore()

			const repo = Repo.from(restrictedAdapter)
				.resolve(() => ({ table: 'test' }))
				.build()

			try {
				await repo
					.on(UpsertSchema)
					.one()
					.where((q: any) => q.eq('email', 'x@test.com'))
					.upsert({ create: { email: 'x@test.com', name: 'X', views: 0 } })
				expect.unreachable()
			} catch (e) {
				expect(e).toBeInstanceOf(OrmValidationError)
				const err = e as InstanceType<typeof OrmValidationError>
				expect(err.kind).toBe('upsert-filter-incompatible')
			}
		})
	})

	describe('type-level: upsert gating', () => {
		test('adapter with upsertOne enables one().upsert', () => {
			class WithUpsertAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string', 'number'] as const
				readonly queryableOps = ['eq'] as const
				readonly updateOps = ['set'] as const
				async findMany() {
					return []
				}
				async upsertOne() {
					return {}
				}
			}
			type A = WithUpsertAdapter
			type S = import('../schema.js').AnySchema
			type One = import('./builders.js').OneBuilderSurface<S, A>
			expectTypeOf<One['upsert']>().toBeFunction()
		})

		test('adapter without upsertOne collapses one().upsert to never', () => {
			class NoUpsertAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string', 'number'] as const
				readonly queryableOps = ['eq'] as const
				readonly updateOps = ['set'] as const
				async findMany() {
					return []
				}
			}
			type A = NoUpsertAdapter
			type S = import('../schema.js').AnySchema
			type One = import('./builders.js').OneBuilderSurface<S, A>
			expectTypeOf<One['upsert']>().toBeNever()
		})

		test('adapter without upsertOne (crud-only) collapses one().upsert to never', () => {
			class CrudOnlyAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string', 'number'] as const
				readonly updateOps = ['set'] as const
				async findByPk() {
					return null
				}
			}
			type A = CrudOnlyAdapter
			type S = import('../schema.js').AnySchema
			type One = import('./builders.js').OneBuilderSurface<S, A>
			expectTypeOf<One['upsert']>().toBeNever()
		})
	})

	describe('repo.session — transactional behaviour', () => {
		const SchemaA = Schema.from('accounts')
			.pk('id', v.string(), () => `a-${Math.random().toString(36).slice(2)}`)
			.field('balance', v.number())
			.build()
		const SchemaB = Schema.from('ledger')
			.pk('id', v.string(), () => `l-${Math.random().toString(36).slice(2)}`)
			.field('amount', v.number())
			.field('accountId', v.string())
			.build()

		function makeSessionRepo() {
			const adapter = InMemoryAdapter.create({})
			return Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()
		}

		test('throw-to-rollback: uncaught throw rolls back all writes and rejects with same error', async () => {
			const repo = makeSessionRepo()
			await repo.on(SchemaA).one().create({ balance: 100 })

			const err = new Error('boom')
			await expect(
				repo.session(async () => {
					await repo.on(SchemaA).one().create({ balance: 200 })
					throw err
				}),
			).rejects.toBe(err)

			const all = await repo
				.on(SchemaA)
				.all()
				.where((q) => q.gte('balance', 0))
				.find()
			expect(all).toHaveLength(1)
			expect(all[0].balance).toBe(100)
		})

		test('return-to-commit: successful return commits and resolves with callback value', async () => {
			const repo = makeSessionRepo()
			const result = await repo.session(async () => {
				await repo.on(SchemaA).one().create({ balance: 500 })
				return 'committed'
			})

			expect(result).toBe('committed')
			const all = await repo
				.on(SchemaA)
				.all()
				.where((q) => q.gte('balance', 0))
				.find()
			expect(all).toHaveLength(1)
			expect(all[0].balance).toBe(500)
		})

		test('cross-schema session: multiple schemas share one tx; on throw both roll back', async () => {
			const repo = makeSessionRepo()
			const account = await repo.on(SchemaA).one().create({ balance: 1000 })

			await expect(
				repo.session(async () => {
					await repo
						.on(SchemaA)
						.all()
						.where((q) => q.eq('id', account.id))
						.update({ balance: 900 })
					await repo.on(SchemaB).one().create({ amount: 100, accountId: account.id })
					throw new Error('tx failure')
				}),
			).rejects.toThrow('tx failure')

			const acct = await repo.on(SchemaA).one().id(account.id).find()
			expect(acct!.balance).toBe(1000)

			const entries = await repo
				.on(SchemaB)
				.all()
				.where((q) => q.eq('accountId', account.id))
				.find()
			expect(entries).toHaveLength(0)
		})

		test('nested session: inner repo.session delegates to adapter (flat in in-memory)', async () => {
			const repo = makeSessionRepo()

			const result = await repo.session(async () => {
				await repo.on(SchemaA).one().create({ balance: 100 })
				const inner = await repo.session(async () => {
					await repo.on(SchemaA).one().create({ balance: 200 })
					return 'inner'
				})
				return inner
			})

			expect(result).toBe('inner')
			const all = await repo
				.on(SchemaA)
				.all()
				.where((q) => q.gte('balance', 0))
				.find()
			expect(all).toHaveLength(2)
		})

		test('nested session: throw in inner rolls back entire outer tx (flat nesting)', async () => {
			const repo = makeSessionRepo()
			await repo.on(SchemaA).one().create({ balance: 50 })

			await expect(
				repo.session(async () => {
					await repo.on(SchemaA).one().create({ balance: 100 })
					await repo.session(async () => {
						await repo.on(SchemaA).one().create({ balance: 200 })
						throw new Error('inner boom')
					})
				}),
			).rejects.toThrow('inner boom')

			const all = await repo
				.on(SchemaA)
				.all()
				.where((q) => q.gte('balance', 0))
				.find()
			expect(all).toHaveLength(1)
			expect(all[0].balance).toBe(50)
		})

		test('no-tx-argument rule: session callback receives no arguments', async () => {
			const repo = makeSessionRepo()
			let argCount = -1
			await repo.session(async function () {
				argCount = arguments.length
			})
			expect(argCount).toBe(0)
		})
	})

	describe('type-level: session gating', () => {
		test('missing session collapses repo.session to never', () => {
			class NoSessionAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string'] as const
				async findMany() {
					return []
				}
			}
			type A = NoSessionAdapter
			const _repo = {} as import('./repo.js').RepoSurface<A>
			expectTypeOf(_repo.session).toBeNever()
		})

		test('adapter with session enables repo.session', () => {
			class WithSessionAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string'] as const
				async session<T>(fn: () => Promise<T>): Promise<T> {
					return fn()
				}
			}
			type A = WithSessionAdapter
			const _repo = {} as import('./repo.js').RepoSurface<A>
			expectTypeOf(_repo.session).toBeFunction()
		})
	})

	describe('ALS-backed resolve', () => {
		test('resolves each operation afresh without retaining an effective config', async () => {
			const seenConfigs: unknown[] = []
			const resolvedNames: string[] = []
			const adapter = InMemoryAdapter.create({})
			const origUse = adapter.use.bind(adapter)
			;(adapter as any).use = vi.fn((schema: AnySchema, config: unknown) => {
				seenConfigs.push(config)
				return origUse(schema, config as { table: string })
			})
			const schema = Schema.from('fresh_config')
				.pk('id', v.string(), () => 'fresh-id')
				.build()
			const repo = Repo.from(adapter)
				.resolve((name) => {
					resolvedNames.push(name)
					return { table: name }
				})
				.build()

			await repo.resolve(
				(config, name) => ({ table: `scoped_${name}_${config.table}` }),
				() => repo.on(schema).all().find(),
			)
			await repo.on(schema).all().find()

			expect(resolvedNames).toEqual(['fresh_config', 'fresh_config'])
			expect(seenConfigs).toEqual([{ table: 'scoped_fresh_config_fresh_config' }, { table: 'fresh_config' }])
		})

		test('reads inside repo.resolve see the override', async () => {
			const seenConfigs: unknown[] = []
			const adapter = InMemoryAdapter.create({})
			const origUse = adapter.use.bind(adapter)
			;(adapter as any).use = vi.fn((s: any, config: any) => {
				seenConfigs.push(config)
				return origUse(s, config)
			})

			const TestSchema = Schema.from('test')
				.pk('id', v.string(), () => 'x')
				.field('name', v.string())
				.build()
			const repo = Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()

			await repo.resolve(
				(config) => ({ table: `override_${config.table}` }),
				async () => {
					await repo.on(TestSchema).all().find()
				},
			)

			expect(seenConfigs[0]).toEqual({ table: 'override_test' })
		})

		test('reads outside repo.resolve see the default config', async () => {
			const seenConfigs: unknown[] = []
			const adapter = InMemoryAdapter.create({})
			const origUse = adapter.use.bind(adapter)
			;(adapter as any).use = vi.fn((s: any, config: any) => {
				seenConfigs.push(config)
				return origUse(s, config)
			})

			const TestSchema = Schema.from('test')
				.pk('id', v.string(), () => 'x')
				.field('name', v.string())
				.build()
			const repo = Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()

			await repo.resolve(
				(config) => ({ table: `scoped_${config.table}` }),
				async () => {},
			)

			await repo.on(TestSchema).all().find()
			expect(seenConfigs[0]).toEqual({ table: 'test' })
		})

		test('two parallel repo.resolve calls do not bleed into each other', async () => {
			const seenConfigs: unknown[] = []
			const adapter = InMemoryAdapter.create({})
			const origUse = adapter.use.bind(adapter)
			;(adapter as any).use = vi.fn((s: any, config: any) => {
				seenConfigs.push(config)
				return origUse(s, config)
			})

			const TestSchema = Schema.from('test')
				.pk('id', v.string(), () => 'x')
				.field('name', v.string())
				.build()
			const repo = Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()

			await Promise.all([
				repo.resolve(
					(config) => ({ table: `tenant1_${config.table}` }),
					async () => {
						await new Promise((r) => setTimeout(r, 10))
						await repo.on(TestSchema).all().find()
					},
				),
				repo.resolve(
					(config) => ({ table: `tenant2_${config.table}` }),
					async () => {
						await new Promise((r) => setTimeout(r, 10))
						await repo.on(TestSchema).all().find()
					},
				),
			])

			expect(seenConfigs).toContainEqual({ table: 'tenant1_test' })
			expect(seenConfigs).toContainEqual({ table: 'tenant2_test' })
			expect(seenConfigs).not.toContainEqual({ table: 'tenant2_tenant1_test' })
			expect(seenConfigs).not.toContainEqual({ table: 'tenant1_tenant2_test' })
		})

		test('overrides survive across awaits inside fn', async () => {
			const seenConfigs: unknown[] = []
			const adapter = InMemoryAdapter.create({})
			const origUse = adapter.use.bind(adapter)
			;(adapter as any).use = vi.fn((s: any, config: any) => {
				seenConfigs.push(config)
				return origUse(s, config)
			})

			const TestSchema = Schema.from('test')
				.pk('id', v.string(), () => 'x')
				.field('name', v.string())
				.build()
			const repo = Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()

			await repo.resolve(
				(config) => ({ table: `async_${config.table}` }),
				async () => {
					await repo.on(TestSchema).all().find()
					await new Promise((r) => setTimeout(r, 10))
					await repo.on(TestSchema).all().find()
				},
			)

			expect(seenConfigs).toHaveLength(2)
			expect(seenConfigs[0]).toEqual({ table: 'async_test' })
			expect(seenConfigs[1]).toEqual({ table: 'async_test' })
		})
	})

	describe('class-based OrmAdapter with Repo', async () => {
		const { OrmAdapter } = await import('../orm-adapter.js')
		const { FilterGroup } = await import('../filter.js')
		const { OrmValidationError } = await import('../errors/index.js')

		function makeClassAdapter() {
			const stores = new Map<string, Map<string, Record<string, unknown>>>()
			function getStore(name: string) {
				if (!stores.has(name)) stores.set(name, new Map())
				return stores.get(name)!
			}

			class TestClassAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ table: v.string() })
				readonly supportedFieldTypes = ['string', 'number'] as const
				readonly queryableOps = ['eq'] as const
				readonly updateOps = ['set'] as const

				async findMany(
					_schema: import('../schema.js').AnySchema,
					config: unknown,
					group: import('../filter.js').FilterGroup,
				) {
					const cfg = config as { table: string }
					const store = getStore(cfg.table)
					return [...store.values()].filter((doc) => {
						for (const child of group.children) {
							if (child instanceof (FilterGroup as any).constructor) continue
							const f = child as any
							if (f.op === 'eq' && doc[f.field] !== f.value) return false
						}
						return true
					})
				}

				async createMany(
					s: import('../schema.js').AnySchema,
					config: unknown,
					data: Record<string, unknown>[],
				) {
					const cfg = config as { table: string }
					const store = getStore(cfg.table)
					const pk = s.pkField.name
					for (const d of data) store.set(String(d[pk]), { ...d })
					return data.map((d) => ({ ...d }))
				}

				async updateMany(
					s: import('../schema.js').AnySchema,
					config: unknown,
					group: import('../filter.js').FilterGroup,
					data: Record<string, unknown>,
				) {
					const rows = await this.findMany(s, config, group)
					const cfg = config as { table: string }
					const store = getStore(cfg.table)
					const pk = s.pkField.name
					return rows.map((row) => {
						const updated = { ...row, ...data }
						store.set(String(updated[pk]), updated)
						return { ...updated }
					})
				}

				async deleteMany(
					s: import('../schema.js').AnySchema,
					config: unknown,
					group: import('../filter.js').FilterGroup,
				) {
					const rows = await this.findMany(s, config, group)
					const cfg = config as { table: string }
					const store = getStore(cfg.table)
					const pk = s.pkField.name
					for (const row of rows) store.delete(String(row[pk]))
					return rows
				}
			}

			const spy = mockInstance()
			const adapter = new (TestClassAdapter as any)() as InstanceType<typeof TestClassAdapter>
			spy.mockRestore()
			return { adapter, stores }
		}

		const TestSchema = Schema.from('class_test')
			.pk('id', v.string(), () => `ct-${Math.random().toString(36).slice(2, 8)}`)
			.field('name', v.string())
			.field('age', v.number())
			.build()

		test('Repo.from(classAdapter).resolve(...).build() creates a working repo', async () => {
			const { adapter } = makeClassAdapter()
			const repo = Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()

			const created = await repo.on(TestSchema).one().create({ name: 'Alice', age: 30 })
			expect(created.name).toBe('Alice')
			expect(created.age).toBe(30)

			const found = await repo.on(TestSchema).one().id(created.id).find()
			expect(found).not.toBeNull()
			expect(found!.name).toBe('Alice')
		})

		test('dispatch validator validates config against schemaConfigPipe', async () => {
			const { adapter } = makeClassAdapter()
			const findMany = vi.spyOn(adapter, 'findMany')
			const repo = Repo.from(adapter)
				.resolve(() => ({ table: 123 }) as any)
				.build()

			try {
				await repo.on(TestSchema).all().find()
				expect.unreachable('invalid schema config should reject before adapter dispatch')
			} catch (error) {
				expect(error).toBeInstanceOf(OrmValidationError)
				expect((error as InstanceType<typeof OrmValidationError>).schema).toBe('class_test')
			}
			expect(findMany).not.toHaveBeenCalled()
		})

		test('dispatch validator validates after transforms applied', async () => {
			const { adapter } = makeClassAdapter()
			const repo = Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()

			await expect(
				repo.resolve(
					() => ({ table: 42 }) as any,
					async () => repo.on(TestSchema).all().find(),
				),
			).rejects.toBeInstanceOf(OrmValidationError)
		})

		test('createMany + findMany round-trip works', async () => {
			const { adapter } = makeClassAdapter()
			const repo = Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()

			const created = await repo
				.on(TestSchema)
				.all()
				.create([
					{ name: 'Alice', age: 30 },
					{ name: 'Bob', age: 25 },
				])
			expect(created).toHaveLength(2)

			const all = await repo.on(TestSchema).all().find()
			expect(all).toHaveLength(2)
		})

		test('update and delete work on class-based adapter', async () => {
			const { adapter } = makeClassAdapter()
			const repo = Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()

			const user = await repo.on(TestSchema).one().create({ name: 'Alice', age: 30 })
			const updated = await repo.on(TestSchema).one().id(user.id).update({ name: 'Alicia' })
			expect(updated?.name).toBe('Alicia')

			const deleted = await repo.on(TestSchema).one().id(user.id).delete()
			expect(deleted?.id).toBe(user.id)

			const found = await repo.on(TestSchema).one().id(user.id).find()
			expect(found).toBeNull()
		})
	})

	describe('repo.on().aggregate() end-to-end', () => {
		const OrderSchema = Schema.from('orders')
			.pk('id', v.string(), () => `o-${Math.random().toString(36).slice(2, 8)}`)
			.field('product', v.string())
			.field('amount', v.number())
			.field('region', v.string())
			.build()

		function makeAggRepo() {
			const adapter = InMemoryAdapter.create({})
			const repo = Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()
			return { repo, adapter }
		}

		async function seedOrders(repo: any) {
			await repo
				.on(OrderSchema)
				.all()
				.create([
					{ product: 'Widget', amount: 10, region: 'US' },
					{ product: 'Gadget', amount: 20, region: 'EU' },
					{ product: 'Widget', amount: 30, region: 'US' },
					{ product: 'Gadget', amount: 40, region: 'EU' },
					{ product: 'Widget', amount: 50, region: 'US' },
				])
		}

		test('count returns total row count', async () => {
			const { repo } = makeAggRepo()
			await seedOrders(repo)
			const result = await repo.on(OrderSchema).aggregate().count('total').run()
			expect(result).toEqual({ total: 5 })
		})

		test('count with where filter returns filtered count', async () => {
			const { repo } = makeAggRepo()
			await seedOrders(repo)
			const result = await repo
				.on(OrderSchema)
				.aggregate()
				.where((q) => q.eq('region', 'US'))
				.count('total')
				.run()
			expect(result).toEqual({ total: 3 })
		})

		test('count on empty result returns zero', async () => {
			const { repo } = makeAggRepo()
			const result = await repo.on(OrderSchema).aggregate().count('total').run()
			expect(result).toEqual({ total: 0 })
		})

		test('clone-on-step: base builder is not mutated by fan-out', async () => {
			const { repo } = makeAggRepo()
			await seedOrders(repo)
			const base = repo.on(OrderSchema).aggregate().count('a')
			const withFilter = base.where((q) => q.eq('region', 'US'))
			const resultAll = await base.count('b').run()
			const resultFiltered = await withFilter.count('c').run()
			expect(resultAll.a).toBe(5)
			expect(resultFiltered.a).toBe(3)
		})

		test('where before count produces correct result', async () => {
			const { repo } = makeAggRepo()
			await seedOrders(repo)
			const result = await repo
				.on(OrderSchema)
				.aggregate()
				.count('total')
				.where((q) => q.eq('product', 'Gadget'))
				.run()
			expect(result).toEqual({ total: 2 })
		})

		test('boundary validation rejects unknown field in where filter', async () => {
			const { repo } = makeAggRepo()
			await expect(
				repo
					.on(OrderSchema)
					.aggregate()
					.count('total')
					.where((q) => q.eq('nonexistent', 'x'))
					.run(),
			).rejects.toThrow(OrmValidationError)
		})

		test('sum returns total of numeric field', async () => {
			const { repo } = makeAggRepo()
			await seedOrders(repo)
			const result = await repo.on(OrderSchema).aggregate().sum(OrderSchema.fields.amount, 'revenue').run()
			expect(result).toEqual({ revenue: 150 })
		})

		test('avg returns average of numeric field', async () => {
			const { repo } = makeAggRepo()
			await seedOrders(repo)
			const result = await repo.on(OrderSchema).aggregate().avg(OrderSchema.fields.amount, 'avgAmount').run()
			expect(result).toEqual({ avgAmount: 30 })
		})

		test('min returns minimum value', async () => {
			const { repo } = makeAggRepo()
			await seedOrders(repo)
			const result = await repo.on(OrderSchema).aggregate().min(OrderSchema.fields.amount, 'lowest').run()
			expect(result).toEqual({ lowest: 10 })
		})

		test('max returns maximum value', async () => {
			const { repo } = makeAggRepo()
			await seedOrders(repo)
			const result = await repo.on(OrderSchema).aggregate().max(OrderSchema.fields.amount, 'highest').run()
			expect(result).toEqual({ highest: 50 })
		})

		test('countDistinct returns unique value count', async () => {
			const { repo } = makeAggRepo()
			await seedOrders(repo)
			const result = await repo
				.on(OrderSchema)
				.aggregate()
				.countDistinct(OrderSchema.fields.product, 'unique')
				.run()
			expect(result).toEqual({ unique: 2 })
		})

		test('min on string field returns lexicographic minimum', async () => {
			const { repo } = makeAggRepo()
			await seedOrders(repo)
			const result = await repo.on(OrderSchema).aggregate().min(OrderSchema.fields.region, 'firstRegion').run()
			expect(result).toEqual({ firstRegion: 'EU' })
		})

		test('max on string field returns lexicographic maximum', async () => {
			const { repo } = makeAggRepo()
			await seedOrders(repo)
			const result = await repo.on(OrderSchema).aggregate().max(OrderSchema.fields.region, 'lastRegion').run()
			expect(result).toEqual({ lastRegion: 'US' })
		})

		test('combined aggregators in single chain', async () => {
			const { repo } = makeAggRepo()
			await seedOrders(repo)
			const result = await repo
				.on(OrderSchema)
				.aggregate()
				.count('total')
				.sum(OrderSchema.fields.amount, 'revenue')
				.avg(OrderSchema.fields.amount, 'avgAmount')
				.min(OrderSchema.fields.amount, 'lowest')
				.max(OrderSchema.fields.amount, 'highest')
				.run()
			expect(result).toEqual({ total: 5, revenue: 150, avgAmount: 30, lowest: 10, highest: 50 })
		})

		test('groupBy single column returns per-group results', async () => {
			const { repo } = makeAggRepo()
			await seedOrders(repo)
			const result = await repo
				.on(OrderSchema)
				.aggregate()
				.groupBy(OrderSchema.fields.region)
				.count('cnt')
				.sum(OrderSchema.fields.amount, 'total')
				.run()
			expect(result).toHaveLength(2)
			const us = result.find((r) => r.region === 'US')
			const eu = result.find((r) => r.region === 'EU')
			expect(us).toEqual({ region: 'US', cnt: 3, total: 90 })
			expect(eu).toEqual({ region: 'EU', cnt: 2, total: 60 })
		})

		test('groupBy multi-column returns per-combo results', async () => {
			const { repo } = makeAggRepo()
			await seedOrders(repo)
			const result = await repo
				.on(OrderSchema)
				.aggregate()
				.groupBy(OrderSchema.fields.region, OrderSchema.fields.product)
				.count('cnt')
				.run()
			expect(result).toHaveLength(2)
			const usWidget = result.find((r) => r.region === 'US' && r.product === 'Widget')
			const euGadget = result.find((r) => r.region === 'EU' && r.product === 'Gadget')
			expect(usWidget?.cnt).toBe(3)
			expect(euGadget?.cnt).toBe(2)
		})

		test('where + groupBy filters before grouping', async () => {
			const { repo } = makeAggRepo()
			await seedOrders(repo)
			const result = await repo
				.on(OrderSchema)
				.aggregate()
				.where((q) => q.gt('amount', 15))
				.groupBy(OrderSchema.fields.region)
				.count('cnt')
				.run()
			const us = result.find((r) => r.region === 'US')
			const eu = result.find((r) => r.region === 'EU')
			expect(us?.cnt).toBe(2)
			expect(eu?.cnt).toBe(2)
		})

		test('having filters after aggregation', async () => {
			const { repo } = makeAggRepo()
			await seedOrders(repo)
			const result = await repo
				.on(OrderSchema)
				.aggregate()
				.groupBy(OrderSchema.fields.region)
				.count('cnt')
				.sum(OrderSchema.fields.amount, 'total')
				.having((q) => q.gt('total', 80))
				.run()
			expect(result).toHaveLength(1)
			expect(result[0].region).toBe('US')
			expect(result[0].total).toBe(90)
		})

		test('where + having work together', async () => {
			const { repo } = makeAggRepo()
			await seedOrders(repo)
			const result = await repo
				.on(OrderSchema)
				.aggregate()
				.where((q) => q.gt('amount', 15))
				.groupBy(OrderSchema.fields.region)
				.count('cnt')
				.having((q) => q.gte('cnt', 2))
				.run()
			expect(result).toHaveLength(2)
		})

		test('countDistinct with groupBy', async () => {
			const { repo } = makeAggRepo()
			await seedOrders(repo)
			const result = await repo
				.on(OrderSchema)
				.aggregate()
				.groupBy(OrderSchema.fields.region)
				.countDistinct(OrderSchema.fields.product, 'uniqueProducts')
				.run()
			const us = result.find((r) => r.region === 'US')
			const eu = result.find((r) => r.region === 'EU')
			expect(us?.uniqueProducts).toBe(1)
			expect(eu?.uniqueProducts).toBe(1)
		})

		test('step order is irrelevant: groupBy before or after aggregators', async () => {
			const { repo } = makeAggRepo()
			await seedOrders(repo)
			const resultA = await repo.on(OrderSchema).aggregate().groupBy(OrderSchema.fields.region).count('cnt').run()
			const resultB = await repo.on(OrderSchema).aggregate().count('cnt').groupBy(OrderSchema.fields.region).run()
			expect(resultA.sort((a, b) => a.region.localeCompare(b.region))).toEqual(
				resultB.sort((a, b) => a.region.localeCompare(b.region)),
			)
		})

		test('boundary validation rejects unknown groupBy field', async () => {
			const { repo } = makeAggRepo()
			await expect(
				(repo.on(OrderSchema).aggregate() as any)
					.groupBy({ name: 'nonexistent', path: ['nonexistent'] })
					.count('total')
					.run(),
			).rejects.toThrow(OrmValidationError)
		})

		test('boundary validation rejects unknown having field', async () => {
			const { repo } = makeAggRepo()
			await expect(
				repo
					.on(OrderSchema)
					.aggregate()
					.groupBy(OrderSchema.fields.region)
					.count('cnt')
					.having((q) => q.gt('nonexistent', 0))
					.run(),
			).rejects.toThrow(OrmValidationError)
		})

		test('min/max on empty store returns null', async () => {
			const { repo } = makeAggRepo()
			const result = await repo
				.on(OrderSchema)
				.aggregate()
				.min(OrderSchema.fields.amount, 'lowest')
				.max(OrderSchema.fields.amount, 'highest')
				.run()
			expect(result).toEqual({ lowest: null, highest: null })
		})

		test('avg on empty store returns zero', async () => {
			const { repo } = makeAggRepo()
			const result = await repo.on(OrderSchema).aggregate().avg(OrderSchema.fields.amount, 'avgAmount').run()
			expect(result).toEqual({ avgAmount: 0 })
		})
	})
}
