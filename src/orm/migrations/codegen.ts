import type { OrmAdapterLike } from '../adapters/base.js'
import type { OrmAdapter } from '../orm-adapter.js'
import type { Repo } from '../repo/repo.js'
import type { AnySchema } from '../schema.js'
import { diffSchemas } from './diff.js'
import type { DiscoveredSchema } from './introspection-types.js'
import type { ChangeFor } from './types.js'

type TargetIntrospection = {
	introspectTarget(config: unknown): Promise<DiscoveredSchema | null>
	physicalTargetIdentity(config: unknown): string
}

type HasMethod<A, K extends PropertyKey> = K extends keyof A
	? A[K] extends (...args: any[]) => any
		? true
		: false
	: false
type HasTargetIntrospection<A> =
	HasMethod<A, 'introspectTarget'> extends true ? HasMethod<A, 'physicalTargetIdentity'> : false
type CodegenSurface<A extends OrmAdapterLike<any>> = MigrationCodegen<A> &
	(HasTargetIntrospection<A> extends true ? {} : { diff: never }) &
	(HasMethod<A, 'introspect'> extends true ? {} : { discover: never })

export class MigrationCodegen<A extends OrmAdapterLike<any>> {
	readonly #repo: Repo<A>
	readonly #adapter: OrmAdapter & TargetIntrospection & { introspect(): Promise<DiscoveredSchema[]> }
	readonly #target: ReadonlyArray<AnySchema>

	constructor(
		repo: Repo<A>,
		adapter: OrmAdapter & TargetIntrospection & { introspect(): Promise<DiscoveredSchema[]> },
		target: ReadonlyArray<AnySchema>,
	) {
		this.#repo = repo
		this.#adapter = adapter
		this.#target = target
	}

	async diff(): Promise<ReadonlyArray<ChangeFor<A>> | null> {
		const current: DiscoveredSchema[] = []
		const identities = new Map<string, string>()
		for (const schema of this.#target) {
			const config = this.#repo.resolveConfig(schema.name)
			const identity = this.#adapter.physicalTargetIdentity(config)
			const existing = identities.get(identity)
			if (existing)
				throw new Error(`Codegen targets '${existing}' and '${schema.name}' share the same physical target`)
			identities.set(identity, schema.name)
			const discovered = await this.#adapter.introspectTarget(config)
			if (discovered) current.push({ ...discovered, name: schema.name })
		}
		const changes = diffSchemas(this.#adapter, this.#target, current)
		if (changes.length === 0) return null
		return changes as unknown as ReadonlyArray<ChangeFor<A>>
	}

	async discover(): Promise<ReadonlyArray<DiscoveredSchema>> {
		return this.#adapter.introspect()
	}

	static from<A extends OrmAdapterLike<any>>(repo: Repo<A>) {
		if (!repo || typeof (repo as any).resolveConfig !== 'function' || !(repo as any).adapter) {
			throw new TypeError('MigrationCodegen.from requires a Repo')
		}
		const adapter = repo.adapter as A &
			OrmAdapter &
			TargetIntrospection & { introspect(): Promise<DiscoveredSchema[]> }
		return {
			target(schemas: ReadonlyArray<AnySchema>) {
				return {
					build(): CodegenSurface<A> {
						return new MigrationCodegen(repo, adapter, schemas) as CodegenSurface<A>
					},
				}
			},
		}
	}
}

if (import.meta.vitest) {
	const { describe, test, expect, expectTypeOf, vi } = import.meta.vitest
	const { v } = await import('valleyed')
	const { InMemoryAdapter } = await import('../adapters/in-memory/index.js')
	const { Schema } = await import('../schema.js')
	const { Repo } = await import('../repo/repo.js')
	const { OrmIntrospectionError } = await import('../errors/introspection.js')

	const UserSchema = Schema.from('users')
		.pk('id', v.string(), () => `u-${Math.random().toString(36).slice(2)}`)
		.field('email', v.string())
		.field('age', v.number())
		.build()

	const PostSchema = Schema.from('posts')
		.pk('id', v.string(), () => `p-${Math.random().toString(36).slice(2)}`)
		.field('title', v.string())
		.field('authorId', v.string())
		.build()

	function makeEnv() {
		const adapter = InMemoryAdapter.create({})
		const repo = new Repo({ adapter, resolve: (name) => ({ table: name }) })
		return { adapter, repo }
	}

	describe('MigrationCodegen', () => {
		test('an empty managed target is a no-op without introspection', async () => {
			const { adapter, repo } = makeEnv()
			const introspectTarget = vi.spyOn(adapter, 'introspectTarget')
			const codegen = MigrationCodegen.from(repo).target([]).build()

			expect(await codegen.diff()).toBeNull()
			expect(introspectTarget).not.toHaveBeenCalled()
		})

		test('diff() returns createTable changes for fresh DB', async () => {
			const { repo } = makeEnv()
			const codegen = MigrationCodegen.from(repo).target([UserSchema]).build()
			const changes = await codegen.diff()
			expect(changes).not.toBeNull()
			expect(changes).toHaveLength(1)
			expect(changes![0].kind).toBe('createTable')
			const ct = changes![0] as any
			expect(ct.name).toBe('users')
			expect(ct.pk).toEqual({ name: 'id', type: 'string' })
			expect(ct.fields).toEqual([
				{ name: 'email', type: 'string' },
				{ name: 'age', type: 'number' },
			])
		})

		test('discovers a CRUD-created container rather than proposing to create it again', async () => {
			const { repo } = makeEnv()
			await repo.on(UserSchema).one().create({ id: 'u1', email: 'alice@example.com', age: 30 })
			const codegen = MigrationCodegen.from(repo).target([UserSchema]).build()
			expect(await codegen.discover()).toEqual([
				{ name: 'users', pk: undefined, fields: [], indexes: [], foreignKeys: [] },
			])
			const changes = await codegen.diff()
			expect(changes).not.toBeNull()
			expect(changes!.every((c) => c.kind === 'addField')).toBe(true)
			expect(changes!.map((c) => (c.kind === 'addField' ? c.field.name : ''))).toEqual(['email', 'age'])
		})

		test('diff() returns null when target matches current', async () => {
			const { adapter, repo } = makeEnv()
			await adapter.applyCreateTable({
				kind: 'createTable',
				name: 'users',
				pk: { name: 'id', type: 'string' },
				fields: [
					{ name: 'email', type: 'string' },
					{ name: 'age', type: 'number' },
				],
			})
			const codegen = MigrationCodegen.from(repo).target([UserSchema]).build()
			const changes = await codegen.diff()
			expect(changes).toBeNull()
		})

		test('diff resolves mapped targets and ignores unrelated discovered tables', async () => {
			const adapter = InMemoryAdapter.create({})
			const repo = new Repo({ adapter, resolve: (name) => ({ table: `mapped_${name}` }) })
			await adapter.applyCreateTable({
				kind: 'createTable',
				name: 'mapped_users',
				pk: { name: 'id', type: 'string' },
				fields: [
					{ name: 'email', type: 'string' },
					{ name: 'age', type: 'number' },
				],
			})
			adapter.tables.set('unrelated', {
				pk: { name: 'id', type: 'string' },
				fields: new Map([['unsupported', { name: 'unsupported', type: 'bytea' as any }]]),
			})

			const codegen = MigrationCodegen.from(repo).target([UserSchema]).build()
			expect(await codegen.diff()).toBeNull()
			expect((await codegen.discover()).map((schema) => schema.name).sort()).toEqual([
				'mapped_users',
				'unrelated',
			])
		})

		test('diff uses the supplied Repo active scope and validates its resolved config', async () => {
			const adapter = InMemoryAdapter.create({})
			const repo = Repo.from(adapter)
				.resolve((name) => ({ table: `base_${name}` }))
				.build()
			await adapter.applyCreateTable({
				kind: 'createTable',
				name: 'tenant_base_users',
				pk: { name: 'id', type: 'string' },
				fields: [
					{ name: 'email', type: 'string' },
					{ name: 'age', type: 'number' },
				],
			})
			const codegen = MigrationCodegen.from(repo).target([UserSchema]).build()

			expect(
				await repo.resolve(
					(config) => ({ table: `tenant_${config.table}` }),
					() => codegen.diff(),
				),
			).toBeNull()
			await expect(
				repo.resolve(
					() => ({ table: 42 as any }),
					() => codegen.diff(),
				),
			).rejects.toThrow()
		})

		test('generated logical changes apply once through mapped Repo resolution', async () => {
			const adapter = InMemoryAdapter.create({})
			const repo = Repo.from(adapter)
				.resolve((name) => ({ table: `mapped_${name}` }))
				.build()
			const changes = await MigrationCodegen.from(repo).target([UserSchema]).build().diff()
			expect(changes?.[0]).toMatchObject({ kind: 'createTable', name: 'users' })

			const { Migrator } = await import('./migrator.js')
			await Migrator.from(repo)
				.withLock()
				.migrations([{ id: 'generated-create', changes: changes! }])
				.build()
				.up()

			expect(adapter.tables.has('mapped_users')).toBe(true)
			expect(adapter.tables.has('mapped_mapped_users')).toBe(false)
			expect(await MigrationCodegen.from(repo).target([UserSchema]).build().diff()).toBeNull()
		})

		test('diff rejects logical schemas resolving to one physical target', async () => {
			const adapter = InMemoryAdapter.create({})
			const repo = new Repo({ adapter, resolve: () => ({ table: 'shared' }) })
			const codegen = MigrationCodegen.from(repo).target([UserSchema, PostSchema]).build()
			await expect(codegen.diff()).rejects.toThrow(/'users'.*'posts'.*same physical target/)
		})

		test('discover() returns raw introspection descriptors', async () => {
			const { adapter, repo } = makeEnv()
			await adapter.applyCreateTable({
				kind: 'createTable',
				name: 'users',
				pk: { name: 'id', type: 'string' },
				fields: [{ name: 'email', type: 'string' }],
			})
			await adapter.applyAddIndex({ kind: 'addIndex', table: 'users', on: ['email'], unique: true })
			const codegen = MigrationCodegen.from(repo).target([UserSchema]).build()
			const discovered = await codegen.discover()
			expect(discovered).toHaveLength(1)
			expect(discovered[0].name).toBe('users')
			expect(discovered[0].pk).toEqual({ name: 'id', type: 'string' })
			expect(discovered[0].fields).toEqual([{ name: 'email', type: 'string', nullable: false }])
			expect(discovered[0].indexes).toEqual([{ name: 'users_email_idx', on: ['email'], unique: true }])
		})

		test('end-to-end: seed adapter state, declare target, call diff()', async () => {
			const { adapter, repo } = makeEnv()
			await adapter.applyCreateTable({
				kind: 'createTable',
				name: 'users',
				pk: { name: 'id', type: 'string' },
				fields: [{ name: 'email', type: 'string' }],
			})
			const codegen = MigrationCodegen.from(repo).target([UserSchema, PostSchema]).build()
			const changes = await codegen.diff()
			expect(changes).not.toBeNull()
			const kinds = changes!.map((c) => c.kind)
			expect(kinds).toContain('addField')
			expect(kinds).toContain('createTable')
			const addField = changes!.find((c) => c.kind === 'addField') as any
			expect(addField.table).toBe('users')
			expect(addField.field.name).toBe('age')
			const createTable = changes!.find((c) => c.kind === 'createTable') as any
			expect(createTable.name).toBe('posts')
		})

		test('compile-time: construction succeeds while terminals are capability-narrowed', async () => {
			const { OrmAdapter } = await import('../orm-adapter.js')
			class _NoIntrospectAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ table: v.string() })
				readonly supportedFieldTypes = ['string'] as const
			}
			type NoIntrospect = InstanceType<typeof _NoIntrospectAdapter>
			type NoIntrospectCodegen = CodegenSurface<NoIntrospect>
			expectTypeOf<NoIntrospectCodegen['diff']>().toBeNever()
			expectTypeOf<NoIntrospectCodegen['discover']>().toBeNever()

			class _BroadOnlyAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ table: v.string() })
				readonly supportedFieldTypes = ['string'] as const
				async introspect() {
					return []
				}
			}
			type BroadOnly = InstanceType<typeof _BroadOnlyAdapter>
			type BroadOnlyCodegen = CodegenSurface<BroadOnly>
			expectTypeOf<BroadOnlyCodegen['diff']>().toBeNever()
			expectTypeOf<BroadOnlyCodegen['discover']>().toBeFunction()
		})

		test('runtime: from rejects malformed JavaScript input', () => {
			expect(() => MigrationCodegen.from({} as any)).toThrow(TypeError)
		})

		test('OrmIntrospectionError on the requested target remains explicit', async () => {
			const { adapter } = makeEnv()
			// Inject a sentinel value with an invalid type into the adapter's table state
			adapter.tables.set('broken', {
				pk: { name: 'id', type: 'string' },
				fields: new Map([['weirdCol', { name: 'weirdCol', type: 'bytea' as any }]]),
			})
			const original = adapter.introspectTarget.bind(adapter)
			adapter.introspectTarget = async (config) => {
				const schema = await original(config)
				if (schema?.fields.some((field) => field.type === ('bytea' as any))) {
					throw new OrmIntrospectionError({
						adapter: 'in-memory',
						table: schema.name,
						cause: "unsupported type 'bytea' on column 'weirdCol'",
					})
				}
				return schema
			}
			const brokenRepo = new Repo({ adapter, resolve: () => ({ table: 'broken' }) })
			const codegen = MigrationCodegen.from(brokenRepo).target([UserSchema]).build()
			await expect(codegen.diff()).rejects.toThrow(OrmIntrospectionError)
			try {
				await codegen.diff()
			} catch (err: any) {
				expect(err.adapter).toBe('in-memory')
				expect(err.table).toBe('broken')
			}
		})
	})
}
