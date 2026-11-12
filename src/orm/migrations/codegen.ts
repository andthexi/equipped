import type { OrmAdapterLike } from '../adapters/base.js'
import type { OrmAdapter } from '../orm-adapter.js'
import type { Repo } from '../repo/repo.js'
import type { AnySchema } from '../schema.js'
import { diffSchemas } from './diff.js'
import type { DiscoveredSchema } from './introspection-types.js'
import type { ChangeFor } from './types.js'

export type IntrospectableAdapter<A> = A extends { introspect(): Promise<DiscoveredSchema[]> } ? A : never

export class MigrationCodegen<A extends OrmAdapterLike<any>> {
	readonly #adapter: OrmAdapter & { introspect(): Promise<DiscoveredSchema[]> }
	readonly #target: ReadonlyArray<AnySchema>

	constructor(
		_repo: Repo<A>,
		adapter: OrmAdapter & { introspect(): Promise<DiscoveredSchema[]> },
		target: ReadonlyArray<AnySchema>,
	) {
		this.#adapter = adapter
		this.#target = target
	}

	async diff(): Promise<ReadonlyArray<ChangeFor<A>> | null> {
		const current = await this.#adapter.introspect()
		const changes = diffSchemas(this.#adapter, this.#target, current)
		if (changes.length === 0) return null
		return changes as unknown as ReadonlyArray<ChangeFor<A>>
	}

	async discover(): Promise<ReadonlyArray<DiscoveredSchema>> {
		return this.#adapter.introspect()
	}

	static from<A extends OrmAdapterLike<any>>(
		repo: Repo<IntrospectableAdapter<A>>,
		adapter: A & OrmAdapter & { introspect(): Promise<DiscoveredSchema[]> },
	) {
		return {
			target(schemas: ReadonlyArray<AnySchema>) {
				return {
					build(): MigrationCodegen<A> {
						return new MigrationCodegen(repo as unknown as Repo<A>, adapter, schemas)
					},
				}
			},
		}
	}
}

if (import.meta.vitest) {
	const { describe, test, expect, expectTypeOf } = import.meta.vitest
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
		test('diff() returns createTable changes for fresh DB', async () => {
			const { adapter, repo } = makeEnv()
			const codegen = MigrationCodegen.from(repo, adapter).target([UserSchema]).build()
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
			const { adapter, repo } = makeEnv()
			await repo.on(UserSchema).one().create({ id: 'u1', email: 'alice@example.com', age: 30 })
			const codegen = MigrationCodegen.from(repo, adapter).target([UserSchema]).build()
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
			const codegen = MigrationCodegen.from(repo, adapter).target([UserSchema]).build()
			const changes = await codegen.diff()
			expect(changes).toBeNull()
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
			const codegen = MigrationCodegen.from(repo, adapter).target([UserSchema]).build()
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
			const codegen = MigrationCodegen.from(repo, adapter).target([UserSchema, PostSchema]).build()
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

		test('compile-time: IntrospectableAdapter is never when adapter lacks introspect', async () => {
			const { OrmAdapter } = await import('../orm-adapter.js')
			class _NoIntrospectAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ table: v.string() })
				readonly supportedFieldTypes = ['string'] as const
			}
			type NoIntrospect = InstanceType<typeof _NoIntrospectAdapter>
			expectTypeOf<IntrospectableAdapter<NoIntrospect>>().toBeNever()
		})

		test('OrmIntrospectionError thrown on unrecognized DB type (sentinel)', async () => {
			const { adapter, repo } = makeEnv()
			// Inject a sentinel value with an invalid type into the adapter's table state
			adapter.tables.set('broken', {
				pk: { name: 'id', type: 'string' },
				fields: new Map([['weirdCol', { name: 'weirdCol', type: 'bytea' as any }]]),
			})
			const codegen = MigrationCodegen.from(repo, adapter).target([UserSchema]).build()
			const origIntrospect = adapter.introspect.bind(adapter)
			adapter.introspect = async () => {
				const schemas = await origIntrospect()
				for (const s of schemas) {
					for (const f of s.fields) {
						const validTypes = ['string', 'number', 'boolean', 'null', 'object', 'array', 'date']
						if (!validTypes.includes(f.type)) {
							throw new OrmIntrospectionError({
								adapter: 'in-memory',
								table: s.name,
								cause: `unsupported type '${f.type}' on column '${f.name}'`,
							})
						}
					}
				}
				return schemas
			}
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
