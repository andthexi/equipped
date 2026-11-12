import type { OrmAdapterLike } from '../adapters/base.js'
import { OrmMigrationError } from '../errors/migration.js'
import type { OrmAdapter } from '../orm-adapter.js'
import type { Repo } from '../repo/repo.js'
import { applyChange } from './apply.js'
import { computePending, type PendingOpts } from './pending.js'
import type { AnyChange, AnyMigration, Migration } from './types.js'
import { assertNormalisedChanges } from './validate.js'

type RunResult = { ran: string[]; skipped: string[] }
export type StatusEntry = { id: string; applied: boolean; appliedAt?: number }

type HasAcquireMigrationLock<A> = 'acquireMigrationLock' extends keyof A
	? A['acquireMigrationLock'] extends <T>(fn: () => Promise<T>) => Promise<T>
		? true
		: false
	: false

type HasMethod<A, K extends PropertyKey> = K extends keyof A
	? A[K] extends (...args: any[]) => any
		? true
		: false
	: false
type MigratorSurface<A extends OrmAdapterLike<any>> = Migrator<A> &
	(HasMethod<A, 'loadMigrations'> extends true ? {} : { status: never; dry: never }) &
	(HasMethod<A, 'loadMigrations'> extends true
		? HasMethod<A, 'recordMigration'> extends true
			? {}
			: { up: never }
		: { up: never })

type MigrationsStep<A extends OrmAdapterLike<any>> = {
	migrations(migrations: ReadonlyArray<Migration<A>>): { build(): MigratorSurface<A> }
}

type LockPolicyStep<A extends OrmAdapterLike<any>> = {
	withoutLock(): MigrationsStep<A>
} & (HasAcquireMigrationLock<A> extends true ? { withLock(): MigrationsStep<A> } : {})

export class Migrator<A extends OrmAdapterLike<any>> {
	readonly #repo: Repo<A>
	readonly #adapter: OrmAdapter
	readonly #migrations: ReadonlyArray<Migration<A>>
	readonly #withoutLock: boolean

	constructor(repo: Repo<A>, adapter: OrmAdapter, migrations: ReadonlyArray<Migration<A>>, withoutLock = false) {
		this.#repo = repo
		this.#adapter = adapter
		this.#migrations = migrations
		this.#withoutLock = withoutLock
	}

	#requireMethod(name: 'loadMigrations' | 'recordMigration'): void {
		if (typeof this.#adapter[name] !== 'function') {
			const phase = name === 'loadMigrations' ? 'load' : ('record' as const)
			throw new OrmMigrationError({ id: '', phase, cause: `adapter does not implement ${name}` })
		}
	}

	async up(opts?: PendingOpts): Promise<RunResult> {
		this.#requireMethod('loadMigrations')
		this.#requireMethod('recordMigration')

		const useLock = !this.#withoutLock && typeof this.#adapter.acquireMigrationLock === 'function'
		if (useLock) {
			try {
				return await this.#adapter.acquireMigrationLock!(() => this.#runPending(opts))
			} catch (err) {
				if (err instanceof OrmMigrationError) throw err
				throw new OrmMigrationError({ id: '', phase: 'lock', cause: err })
			}
		}
		return this.#runPending(opts)
	}

	async status(): Promise<StatusEntry[]> {
		this.#requireMethod('loadMigrations')
		const applied = await this.#adapter.loadMigrations!()
		const appliedMap = new Map(applied.map((a) => [a.id, a.appliedAt]))
		const sorted = [...this.#migrations].sort((a, b) => a.id.localeCompare(b.id))
		return sorted.map((m) => {
			const appliedAt = appliedMap.get(m.id)
			if (appliedAt !== undefined) return { id: m.id, applied: true as const, appliedAt }
			return { id: m.id, applied: false as const }
		})
	}

	async dry(opts?: PendingOpts): Promise<{ would: string[] }> {
		this.#requireMethod('loadMigrations')
		const applied = await this.#adapter.loadMigrations!()
		const { pending } = computePending(this.#migrations as unknown as ReadonlyArray<AnyMigration>, applied, opts)
		return { would: pending.map((m) => m.id) }
	}

	async #runPending(opts?: PendingOpts): Promise<RunResult> {
		let applied: { id: string; appliedAt: number }[]
		try {
			applied = await this.#adapter.loadMigrations!()
		} catch (err) {
			throw new OrmMigrationError({ id: '', phase: 'load', cause: err })
		}

		const { pending, skipped } = computePending(
			this.#migrations as unknown as ReadonlyArray<AnyMigration>,
			applied,
			opts,
		)
		const ran: string[] = []

		for (const m of pending) {
			const execute = async () => {
				for (const c of m.changes) {
					try {
						await applyChange(
							this.#adapter,
							this.#repo as unknown as Repo<OrmAdapterLike<any>>,
							c as AnyChange,
						)
					} catch (err) {
						throw new OrmMigrationError({ id: m.id, phase: 'user', cause: err })
					}
				}
				try {
					await this.#adapter.recordMigration!(m.id, Date.now())
				} catch (err) {
					throw new OrmMigrationError({ id: m.id, phase: 'record', cause: err })
				}
			}

			const shouldWrapInSession = m.tx !== false && typeof this.#adapter.session === 'function'
			if (shouldWrapInSession) {
				try {
					await this.#repo.session(execute)
				} catch (err) {
					if (err instanceof OrmMigrationError) throw err
					throw new OrmMigrationError({ id: m.id, phase: 'session', cause: err })
				}
			} else {
				await execute()
			}

			ran.push(m.id)
		}

		return { ran, skipped }
	}

	static from<A extends OrmAdapterLike<any>>(repo: Repo<A>): LockPolicyStep<A> {
		if (!repo || typeof (repo as any).resolveConfig !== 'function' || !(repo as any).adapter) {
			throw new TypeError('Migrator.from requires a Repo')
		}
		const adapter = repo.adapter as A & OrmAdapter
		const policy = (withoutLock: boolean): MigrationsStep<A> => ({
			migrations(migrations: ReadonlyArray<Migration<A>>) {
				return {
					build(): MigratorSurface<A> {
						assertNormalisedChanges(adapter, migrations as any)
						return new Migrator(repo, adapter, migrations, withoutLock) as MigratorSurface<A>
					},
				}
			},
		})
		return { withoutLock: () => policy(true), withLock: () => policy(false) } as LockPolicyStep<A>
	}
}

if (import.meta.vitest) {
	const { describe, test, expect, expectTypeOf } = import.meta.vitest
	const { v } = await import('valleyed')
	const { InMemoryAdapter } = await import('../adapters/in-memory/index.js')
	const { Schema } = await import('../schema.js')
	const { Repo } = await import('../repo/repo.js')
	const { OrmValidationError } = await import('../errors/validation.js')
	const { OrmMigrationError } = await import('../errors/migration.js')

	const UserSchema = Schema.from('users')
		.pk('id', v.string(), () => `u-${Math.random().toString(36).slice(2)}`)
		.field('email', v.string())
		.build()

	function makeEnv() {
		const adapter = InMemoryAdapter.create({})
		const repo = new Repo({ adapter, resolve: (name) => ({ table: name }) })
		return { adapter, repo }
	}

	describe('Migrator', () => {
		test('addIndex migration applies and is recorded', async () => {
			const { adapter, repo } = makeEnv()
			const m: Migration<typeof adapter> = {
				id: '0001-add-email-idx',
				changes: [{ kind: 'addIndex', table: 'users', on: ['email'], unique: true }],
			}
			const migrator = Migrator.from(repo).withLock().migrations([m]).build()
			const result = await migrator.up()
			expect(result.ran).toEqual(['0001-add-email-idx'])
			expect(result.skipped).toEqual([])

			expect(adapter.indexes.has('users_email_idx')).toBe(true)
			const idx = adapter.indexes.get('users_email_idx')!
			expect(idx.table).toBe('users')
			expect(idx.on).toEqual(['email'])
			expect(idx.unique).toBe(true)

			const recorded = await adapter.loadMigrations()
			expect(recorded).toHaveLength(1)
			expect(recorded[0].id).toBe('0001-add-email-idx')
		})

		test('execute migration runs user code with the same Repo', async () => {
			const { adapter: _adapter, repo } = makeEnv()
			const m: Migration<typeof _adapter> = {
				id: '0001-seed-user',
				changes: [
					{
						kind: 'execute',
						up: async (r) => {
							await r.on(UserSchema).one().create({ id: 'seed-1', email: 'test@example.com' })
						},
					},
				],
			}
			const migrator = Migrator.from(repo).withLock().migrations([m]).build()
			await migrator.up()

			const row = await repo.on(UserSchema).one().id('seed-1').find()
			expect(row).not.toBeNull()
			expect(row!.email).toBe('test@example.com')
		})

		test('declarative changes and execute share the active resolved target', async () => {
			const { adapter, repo } = makeEnv()
			const migration: Migration<typeof adapter> = {
				id: '0001-scoped-users',
				changes: [
					{
						kind: 'createTable',
						name: 'users',
						pk: { name: 'id', type: 'string' },
						fields: [{ name: 'email', type: 'string' }],
					},
					{
						kind: 'execute',
						up: async (r) => {
							await r.on(UserSchema).one().create({ id: 'scoped-1', email: 'scope@example.com' })
						},
					},
				],
			}
			const migrator = Migrator.from(repo).withLock().migrations([migration]).build()
			const scope = (config: { table: string }) => ({ ...config, table: `tenant_${config.table}` })

			await repo.resolve(scope, () => migrator.up())

			expect((await adapter.introspect()).map(({ name }) => name)).toContain('tenant_users')
			expect(await repo.resolve(scope, () => repo.on(UserSchema).one().id('scoped-1').find())).toMatchObject({
				email: 'scope@example.com',
			})
		})

		test('duplicate id throws OrmValidationError at build()', () => {
			const { repo } = makeEnv()
			expect(() =>
				Migrator.from(repo)
					.withLock()
					.migrations([
						{ id: 'dup', changes: [] },
						{ id: 'dup', changes: [] },
					])
					.build(),
			).toThrow(OrmValidationError)

			try {
				Migrator.from(repo)
					.withLock()
					.migrations([
						{ id: 'dup', changes: [] },
						{ id: 'dup', changes: [] },
					])
					.build()
			} catch (err: any) {
				expect(err.kind).toBe('changes')
			}
		})

		test('up() skips already-applied migrations', async () => {
			const { adapter, repo } = makeEnv()
			const m1: Migration<typeof adapter> = { id: '0001', changes: [] }
			const m2: Migration<typeof adapter> = {
				id: '0002',
				changes: [{ kind: 'addIndex', table: 'users', on: ['email'] }],
			}

			await adapter.recordMigration('0001', Date.now())

			const migrator = Migrator.from(repo).withLock().migrations([m1, m2]).build()
			const result = await migrator.up()
			expect(result.ran).toEqual(['0002'])
			expect(result.skipped).toEqual(['0001'])
		})

		test('up() returns empty ran when all applied', async () => {
			const { adapter, repo } = makeEnv()
			await adapter.recordMigration('0001', Date.now())
			const migrator = Migrator.from(repo)
				.withLock()
				.migrations([{ id: '0001', changes: [] }])
				.build()
			const result = await migrator.up()
			expect(result.ran).toEqual([])
			expect(result.skipped).toEqual(['0001'])
		})

		test('failed migration rolls back via session and throws OrmMigrationError', async () => {
			const { adapter, repo } = makeEnv()
			const m1: Migration<typeof adapter> = {
				id: '0001',
				changes: [{ kind: 'addIndex', table: 'users', on: ['email'] }],
			}
			const m2: Migration<typeof adapter> = {
				id: '0002',
				changes: [
					{
						kind: 'execute',
						up: async () => {
							throw new Error('boom')
						},
					},
				],
			}
			const migrator = Migrator.from(repo).withLock().migrations([m1, m2]).build()
			await expect(migrator.up()).rejects.toThrow(OrmMigrationError)

			const recorded = await adapter.loadMigrations()
			expect(recorded.map((r) => r.id)).toEqual(['0001'])
		})

		test('multiple changes in one migration all apply', async () => {
			const { adapter, repo } = makeEnv()
			const m: Migration<typeof adapter> = {
				id: '0001-multi',
				changes: [
					{ kind: 'addIndex', table: 'users', on: ['email'], unique: true },
					{ kind: 'addIndex', table: 'users', on: ['id', 'email'], name: 'users_compound_idx' },
				],
			}
			const migrator = Migrator.from(repo).withLock().migrations([m]).build()
			await migrator.up()

			expect(adapter.indexes.size).toBe(2)
			expect(adapter.indexes.has('users_email_idx')).toBe(true)
			expect(adapter.indexes.has('users_compound_idx')).toBe(true)
		})

		test('lex-sorts migrations by id before running', async () => {
			const { adapter: _adapter, repo } = makeEnv()
			const order: string[] = []
			const m1: Migration<typeof _adapter> = {
				id: '0002',
				changes: [
					{
						kind: 'execute',
						up: async () => {
							order.push('0002')
						},
					},
				],
			}
			const m2: Migration<typeof _adapter> = {
				id: '0001',
				changes: [
					{
						kind: 'execute',
						up: async () => {
							order.push('0001')
						},
					},
				],
			}
			const migrator = Migrator.from(repo).withLock().migrations([m1, m2]).build()
			await migrator.up()
			expect(order).toEqual(['0001', '0002'])
		})

		test('createTable migration creates table metadata', async () => {
			const { adapter, repo } = makeEnv()
			const m: Migration<typeof adapter> = {
				id: '0001-create-users',
				changes: [
					{
						kind: 'createTable',
						name: 'users',
						pk: { name: 'id', type: 'string' },
						fields: [
							{ name: 'email', type: 'string', unique: true },
							{ name: 'age', type: 'number', nullable: true },
						],
					},
				],
			}
			const migrator = Migrator.from(repo).withLock().migrations([m]).build()
			await migrator.up()

			expect(adapter.tables.has('users')).toBe(true)
			const table = adapter.tables.get('users')!
			expect(table.pk).toEqual({ name: 'id', type: 'string' })
			expect(table.fields.size).toBe(2)
			expect(table.fields.get('email')).toEqual({ name: 'email', type: 'string', unique: true })
			expect(table.fields.get('age')).toEqual({ name: 'age', type: 'number', nullable: true })
		})

		test('dropTable migration removes table metadata', async () => {
			const { adapter, repo } = makeEnv()
			await adapter.applyCreateTable({
				kind: 'createTable',
				name: 'users',
				pk: { name: 'id', type: 'string' },
				fields: [],
			})
			const m: Migration<typeof adapter> = {
				id: '0001-drop-users',
				changes: [{ kind: 'dropTable', name: 'users' }],
			}
			const migrator = Migrator.from(repo).withLock().migrations([m]).build()
			await migrator.up()
			expect(adapter.tables.has('users')).toBe(false)
		})

		test('addField migration adds field to existing table', async () => {
			const { adapter, repo } = makeEnv()
			await adapter.applyCreateTable({
				kind: 'createTable',
				name: 'users',
				pk: { name: 'id', type: 'string' },
				fields: [],
			})
			const m: Migration<typeof adapter> = {
				id: '0001-add-email',
				changes: [{ kind: 'addField', table: 'users', field: { name: 'email', type: 'string' } }],
			}
			const migrator = Migrator.from(repo).withLock().migrations([m]).build()
			await migrator.up()
			expect(adapter.tables.get('users')!.fields.has('email')).toBe(true)
		})

		test('dropField migration removes field from table', async () => {
			const { adapter, repo } = makeEnv()
			await adapter.applyCreateTable({
				kind: 'createTable',
				name: 'users',
				pk: { name: 'id', type: 'string' },
				fields: [{ name: 'email', type: 'string' }],
			})
			const m: Migration<typeof adapter> = {
				id: '0001-drop-email',
				changes: [{ kind: 'dropField', table: 'users', name: 'email' }],
			}
			const migrator = Migrator.from(repo).withLock().migrations([m]).build()
			await migrator.up()
			expect(adapter.tables.get('users')!.fields.has('email')).toBe(false)
		})

		test('modifyField migration updates field spec', async () => {
			const { adapter, repo } = makeEnv()
			await adapter.applyCreateTable({
				kind: 'createTable',
				name: 'users',
				pk: { name: 'id', type: 'string' },
				fields: [{ name: 'age', type: 'string' }],
			})
			const m: Migration<typeof adapter> = {
				id: '0001-modify-age',
				changes: [
					{
						kind: 'modifyField',
						table: 'users',
						name: 'age',
						to: { name: 'age', type: 'number', nullable: true },
					},
				],
			}
			const migrator = Migrator.from(repo).withLock().migrations([m]).build()
			await migrator.up()
			expect(adapter.tables.get('users')!.fields.get('age')).toEqual({
				name: 'age',
				type: 'number',
				nullable: true,
			})
		})

		test('renameTable migration renames the table key', async () => {
			const { adapter, repo } = makeEnv()
			await adapter.applyCreateTable({
				kind: 'createTable',
				name: 'users',
				pk: { name: 'id', type: 'string' },
				fields: [],
			})
			const m: Migration<typeof adapter> = {
				id: '0001-rename-users',
				changes: [{ kind: 'renameTable', from: 'users', to: 'accounts' }],
			}
			const migrator = Migrator.from(repo).withLock().migrations([m]).build()
			await migrator.up()
			expect(adapter.tables.has('users')).toBe(false)
			expect(adapter.tables.has('accounts')).toBe(true)
		})

		test('renameField migration renames a field', async () => {
			const { adapter, repo } = makeEnv()
			await adapter.applyCreateTable({
				kind: 'createTable',
				name: 'users',
				pk: { name: 'id', type: 'string' },
				fields: [{ name: 'name', type: 'string' }],
			})
			const m: Migration<typeof adapter> = {
				id: '0001-rename-name',
				changes: [{ kind: 'renameField', table: 'users', from: 'name', to: 'fullName' }],
			}
			const migrator = Migrator.from(repo).withLock().migrations([m]).build()
			await migrator.up()
			expect(adapter.tables.get('users')!.fields.has('name')).toBe(false)
			expect(adapter.tables.get('users')!.fields.has('fullName')).toBe(true)
			expect(adapter.tables.get('users')!.fields.get('fullName')!.name).toBe('fullName')
		})

		test('dropIndex migration removes an index', async () => {
			const { adapter, repo } = makeEnv()
			await adapter.applyAddIndex({ kind: 'addIndex', table: 'users', on: ['email'], name: 'users_email_idx' })
			const m: Migration<typeof adapter> = {
				id: '0001-drop-idx',
				changes: [{ kind: 'dropIndex', table: 'users', name: 'users_email_idx' }],
			}
			const migrator = Migrator.from(repo).withLock().migrations([m]).build()
			await migrator.up()
			expect(adapter.indexes.has('users_email_idx')).toBe(false)
		})

		test('addForeignKey migration creates a FK entry', async () => {
			const { adapter, repo } = makeEnv()
			const m: Migration<typeof adapter> = {
				id: '0001-add-fk',
				changes: [
					{
						kind: 'addForeignKey',
						table: 'posts',
						on: 'authorId',
						references: { table: 'users', column: 'id' },
					},
				],
			}
			const migrator = Migrator.from(repo).withLock().migrations([m]).build()
			await migrator.up()
			expect(adapter.foreignKeys.has('posts_authorId_fk')).toBe(true)
			const fk = adapter.foreignKeys.get('posts_authorId_fk')!
			expect(fk.table).toBe('posts')
			expect(fk.on).toBe('authorId')
			expect(fk.references).toEqual({ table: 'users', column: 'id' })
		})

		test('dropForeignKey migration removes a FK entry', async () => {
			const { adapter, repo } = makeEnv()
			await adapter.applyAddForeignKey({
				kind: 'addForeignKey',
				table: 'posts',
				on: 'authorId',
				references: { table: 'users', column: 'id' },
				name: 'posts_authorId_fk',
			})
			const m: Migration<typeof adapter> = {
				id: '0001-drop-fk',
				changes: [{ kind: 'dropForeignKey', table: 'posts', name: 'posts_authorId_fk' }],
			}
			const migrator = Migrator.from(repo).withLock().migrations([m]).build()
			await migrator.up()
			expect(adapter.foreignKeys.has('posts_authorId_fk')).toBe(false)
		})

		test('full lifecycle: create table, add fields, indexes, FKs, then rename and drop', async () => {
			const { adapter, repo } = makeEnv()
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
						{ kind: 'renameField', table: 'users', from: 'email', to: 'emailAddress' },
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
			]
			const migrator = Migrator.from(repo).withLock().migrations(migrations).build()
			const result = await migrator.up()
			expect(result.ran).toEqual(['0001-create', '0002-evolve', '0003-cleanup'])

			expect(adapter.tables.has('users')).toBe(true)
			expect(adapter.tables.get('users')!.fields.has('emailAddress')).toBe(true)
			expect(adapter.tables.get('users')!.fields.has('age')).toBe(false)
			expect(adapter.tables.has('articles')).toBe(false)
			expect(adapter.indexes.has('users_email_idx')).toBe(false)
			expect(adapter.foreignKeys.has('posts_authorId_fk')).toBe(false)
		})

		test('tx:true migration that throws rolls back both user effects and tracker row', async () => {
			const { adapter, repo } = makeEnv()
			const m: Migration<typeof adapter> = {
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
			const migrator = Migrator.from(repo).withLock().migrations([m]).build()
			await expect(migrator.up()).rejects.toThrow(OrmMigrationError)

			const recorded = await adapter.loadMigrations()
			expect(recorded).toHaveLength(0)
			expect(adapter.indexes.size).toBe(0)
			const row = await repo.on(UserSchema).one().id('partial').find()
			expect(row).toBeNull()
		})

		test('tx:false migration that throws leaves partial state durable', async () => {
			const { adapter, repo } = makeEnv()
			const m: Migration<typeof adapter> = {
				id: '0001-no-tx',
				tx: false,
				changes: [
					{ kind: 'addIndex', table: 'users', on: ['email'] },
					{
						kind: 'execute',
						up: async (r) => {
							await r.on(UserSchema).one().create({ id: 'durable', email: 'stay@test.com' })
							throw new Error('partial failure')
						},
					},
				],
			}
			const migrator = Migrator.from(repo).withLock().migrations([m]).build()
			await expect(migrator.up()).rejects.toThrow(OrmMigrationError)

			const recorded = await adapter.loadMigrations()
			expect(recorded).toHaveLength(0)
			expect(adapter.indexes.has('users_email_idx')).toBe(true)
			const row = await repo.on(UserSchema).one().id('durable').find()
			expect(row).not.toBeNull()
			expect(row!.email).toBe('stay@test.com')
		})

		test('atomic-across-migrations: outer repo.session() wraps all in one tx', async () => {
			const { adapter, repo } = makeEnv()
			const m1: Migration<typeof adapter> = {
				id: '0001',
				changes: [{ kind: 'addIndex', table: 'users', on: ['email'] }],
			}
			const m2: Migration<typeof adapter> = {
				id: '0002',
				changes: [
					{
						kind: 'execute',
						up: async () => {
							throw new Error('fail in m2')
						},
					},
				],
			}
			const migrator = Migrator.from(repo).withLock().migrations([m1, m2]).build()
			await expect(repo.session(() => migrator.up())).rejects.toThrow()

			const recorded = await adapter.loadMigrations()
			expect(recorded).toHaveLength(0)
			expect(adapter.indexes.size).toBe(0)
		})

		test('simultaneous up() calls serialize via acquireMigrationLock', async () => {
			const { adapter: _adapter, repo } = makeEnv()
			const order: string[] = []
			let resolveGate!: () => void
			const gate = new Promise<void>((r) => {
				resolveGate = r
			})

			const migrations: Migration<typeof _adapter>[] = [
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

			const migrator1 = Migrator.from(repo).withLock().migrations(migrations).build()
			const migrator2 = Migrator.from(repo).withLock().migrations(migrations).build()

			const p1 = migrator1.up()
			const p2 = migrator2.up()

			await new Promise((r) => setTimeout(r, 10))
			expect(order).toEqual(['0001-start'])

			resolveGate()
			await Promise.all([p1, p2])

			expect(order).toEqual(['0001-start', '0001-end', '0002'])
		})

		test('tx:false retries cleanly from scratch after failure', async () => {
			const { adapter: _adapter, repo } = makeEnv()
			let callCount = 0
			const m: Migration<typeof _adapter> = {
				id: '0001-retry',
				tx: false,
				changes: [
					{
						kind: 'execute',
						up: async (r) => {
							callCount++
							if (callCount === 1) {
								await r.on(UserSchema).one().create({ id: 'partial', email: 'p@test.com' })
								throw new Error('first attempt fails')
							}
							await r.on(UserSchema).one().create({ id: 'complete', email: 'c@test.com' })
						},
					},
				],
			}

			const migrator = Migrator.from(repo).withLock().migrations([m]).build()
			await expect(migrator.up()).rejects.toThrow(OrmMigrationError)
			expect(callCount).toBe(1)

			const migrator2 = Migrator.from(repo).withLock().migrations([m]).build()
			const result = await migrator2.up()
			expect(result.ran).toEqual(['0001-retry'])
			expect(callCount).toBe(2)
		})

		test('type-level: withoutLock() rejected when adapter declares acquireMigrationLock', () => {
			const { repo } = makeEnv()
			const step = Migrator.from(repo).withLock().migrations([])
			expectTypeOf(step).toHaveProperty('build')
			expectTypeOf(step).not.toHaveProperty('withoutLock')
		})

		test('type-level: withoutLock() accepted when adapter lacks acquireMigrationLock', async () => {
			const { OrmAdapter } = await import('../orm-adapter.js')
			class NoLockAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ table: v.string() })
				readonly supportedFieldTypes = ['string'] as const
				async loadMigrations() {
					return []
				}
				async recordMigration() {}
				async session<T>(fn: () => Promise<T>): Promise<T> {
					return fn()
				}
			}
			const nlAdapter = new (NoLockAdapter as any)() as NoLockAdapter
			const nlRepo = new Repo({ adapter: nlAdapter, resolve: (name) => ({ table: name }) })
			const step = Migrator.from(nlRepo).withoutLock().migrations([])
			expectTypeOf(step).toHaveProperty('build')
			expectTypeOf(Migrator.from(nlRepo)).not.toHaveProperty('withLock')
		})

		test('type-level: built terminals follow migration history capabilities', async () => {
			const { OrmAdapter } = await import('../orm-adapter.js')
			class UnsupportedAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ table: v.string() })
				readonly supportedFieldTypes = ['string'] as const
			}
			const unsupported = new (UnsupportedAdapter as any)() as UnsupportedAdapter
			const unsupportedRepo = new Repo({ adapter: unsupported, resolve: (name) => ({ table: name }) })
			const built = Migrator.from(unsupportedRepo).withoutLock().migrations([]).build()
			expectTypeOf(built.status).toBeNever()
			expectTypeOf(built.dry).toBeNever()
			expectTypeOf(built.up).toBeNever()

			class ReadOnlyHistoryAdapter extends UnsupportedAdapter {
				async loadMigrations() {
					return []
				}
			}
			const readOnly = new (ReadOnlyHistoryAdapter as any)() as ReadOnlyHistoryAdapter
			const readOnlyRepo = new Repo({ adapter: readOnly, resolve: (name) => ({ table: name }) })
			const readOnlyBuilt = Migrator.from(readOnlyRepo).withoutLock().migrations([]).build()
			expectTypeOf(readOnlyBuilt.status).toBeFunction()
			expectTypeOf(readOnlyBuilt.dry).toBeFunction()
			expectTypeOf(readOnlyBuilt.up).toBeNever()
		})

		test('runtime: from rejects malformed JavaScript input', () => {
			expect(() => Migrator.from({} as any)).toThrow(TypeError)
		})

		test('up({ to }) runs only migrations up to and including the target', async () => {
			const { adapter: _adapter, repo } = makeEnv()
			const order: string[] = []
			const migrations: Migration<typeof _adapter>[] = [
				{
					id: 'm-001',
					changes: [
						{
							kind: 'execute',
							up: async () => {
								order.push('m-001')
							},
						},
					],
				},
				{
					id: 'm-002',
					changes: [
						{
							kind: 'execute',
							up: async () => {
								order.push('m-002')
							},
						},
					],
				},
				{
					id: 'm-003',
					changes: [
						{
							kind: 'execute',
							up: async () => {
								order.push('m-003')
							},
						},
					],
				},
			]
			const migrator = Migrator.from(repo).withLock().migrations(migrations).build()
			const result = await migrator.up({ to: 'm-002' })
			expect(result.ran).toEqual(['m-001', 'm-002'])
			expect(order).toEqual(['m-001', 'm-002'])
		})

		test('up({ to }) is a no-op when target already applied', async () => {
			const { adapter, repo } = makeEnv()
			await adapter.recordMigration('m-001', Date.now())
			await adapter.recordMigration('m-002', Date.now())
			const migrations: Migration<typeof adapter>[] = [
				{ id: 'm-001', changes: [] },
				{ id: 'm-002', changes: [] },
				{ id: 'm-003', changes: [] },
			]
			const migrator = Migrator.from(repo).withLock().migrations(migrations).build()
			const result = await migrator.up({ to: 'm-002' })
			expect(result.ran).toEqual([])
		})

		test('up({ to: unknown }) throws OrmMigrationError before any side effect', async () => {
			const { adapter: _adapter, repo } = makeEnv()
			let executed = false
			const migrations: Migration<typeof _adapter>[] = [
				{
					id: 'm-001',
					changes: [
						{
							kind: 'execute',
							up: async () => {
								executed = true
							},
						},
					],
				},
			]
			const migrator = Migrator.from(repo).withLock().migrations(migrations).build()
			await expect(migrator.up({ to: 'unknown' })).rejects.toThrow(OrmMigrationError)
			expect(executed).toBe(false)
			try {
				await Migrator.from(repo).withLock().migrations(migrations).build().up({ to: 'unknown' })
			} catch (err: any) {
				expect(err.phase).toBe('load')
			}
		})

		test('up({ steps: 1 }) runs exactly 1 pending migration', async () => {
			const { adapter, repo } = makeEnv()
			const migrations: Migration<typeof adapter>[] = [
				{ id: '0001', changes: [{ kind: 'addIndex', table: 'users', on: ['email'] }] },
				{ id: '0002', changes: [{ kind: 'addIndex', table: 'users', on: ['id'] }] },
				{ id: '0003', changes: [{ kind: 'addIndex', table: 'users', on: ['email', 'id'] }] },
			]
			const migrator = Migrator.from(repo).withLock().migrations(migrations).build()
			const result = await migrator.up({ steps: 1 })
			expect(result.ran).toEqual(['0001'])
			expect(adapter.indexes.size).toBe(1)
		})

		test('status() returns sorted entries with correct applied/pending flags', async () => {
			const { adapter, repo } = makeEnv()
			const now = Date.now()
			await adapter.recordMigration('0002', now)
			const migrations: Migration<typeof adapter>[] = [
				{ id: '0003', changes: [] },
				{ id: '0001', changes: [] },
				{ id: '0002', changes: [] },
			]
			const migrator = Migrator.from(repo).withLock().migrations(migrations).build()
			const entries = await migrator.status()
			expect(entries).toEqual([
				{ id: '0001', applied: false },
				{ id: '0002', applied: true, appliedAt: now },
				{ id: '0003', applied: false },
			])
		})

		test('dry() returns the same plan up() would execute, without executing', async () => {
			const { adapter, repo } = makeEnv()
			await adapter.recordMigration('0001', Date.now())
			let executed = false
			const migrations: Migration<typeof adapter>[] = [
				{ id: '0001', changes: [] },
				{
					id: '0002',
					changes: [
						{
							kind: 'execute',
							up: async () => {
								executed = true
							},
						},
					],
				},
				{ id: '0003', changes: [] },
			]
			const migrator = Migrator.from(repo).withLock().migrations(migrations).build()
			const plan = await migrator.dry()
			expect(plan).toEqual({ would: ['0002', '0003'] })
			expect(executed).toBe(false)
		})

		test('dry(opts) respects to/steps', async () => {
			const { adapter: _adapter, repo } = makeEnv()
			const migrations: Migration<typeof _adapter>[] = [
				{ id: '0001', changes: [] },
				{ id: '0002', changes: [] },
				{ id: '0003', changes: [] },
			]
			const migrator = Migrator.from(repo).withLock().migrations(migrations).build()
			expect(await migrator.dry({ to: '0002' })).toEqual({ would: ['0001', '0002'] })
			expect(await migrator.dry({ steps: 1 })).toEqual({ would: ['0001'] })
		})

		test('orphan migration in tracker throws OrmMigrationError with phase load', async () => {
			const { adapter, repo } = makeEnv()
			await adapter.recordMigration('ghost-001', Date.now())
			const migrations: Migration<typeof adapter>[] = [{ id: '0001', changes: [] }]
			const migrator = Migrator.from(repo).withLock().migrations(migrations).build()
			try {
				await migrator.up()
				expect.unreachable('should have thrown')
			} catch (err: any) {
				expect(err).toBeInstanceOf(OrmMigrationError)
				expect(err.phase).toBe('load')
				expect(err.cause).toContain('ghost-001')
			}
		})

		test('failing user code throws OrmMigrationError with phase user', async () => {
			const { adapter: _adapter, repo } = makeEnv()
			const m: Migration<typeof _adapter> = {
				id: '0001',
				changes: [
					{
						kind: 'execute',
						up: async () => {
							throw new Error('user boom')
						},
					},
				],
			}
			const migrator = Migrator.from(repo).withLock().migrations([m]).build()
			try {
				await migrator.up()
				expect.unreachable('should have thrown')
			} catch (err: any) {
				expect(err).toBeInstanceOf(OrmMigrationError)
				expect(err.phase).toBe('user')
				expect(err.id).toBe('0001')
			}
		})

		test('failing recordMigration throws OrmMigrationError with phase record', async () => {
			const { adapter, repo } = makeEnv()
			const origRecord = adapter.recordMigration.bind(adapter)
			adapter.recordMigration = async (id: string, at: number) => {
				if (id === '0001') throw new Error('record boom')
				return origRecord(id, at)
			}
			const m: Migration<typeof adapter> = { id: '0001', changes: [] }
			const migrator = Migrator.from(repo).withLock().migrations([m]).build()
			try {
				await migrator.up()
				expect.unreachable('should have thrown')
			} catch (err: any) {
				expect(err).toBeInstanceOf(OrmMigrationError)
				expect(err.phase).toBe('record')
				expect(err.id).toBe('0001')
			}
		})

		test('failing acquireMigrationLock throws OrmMigrationError with phase lock', async () => {
			const { adapter, repo } = makeEnv()
			adapter.acquireMigrationLock = async () => {
				throw new Error('lock boom')
			}
			const m: Migration<typeof adapter> = { id: '0001', changes: [] }
			const migrator = Migrator.from(repo).withLock().migrations([m]).build()
			try {
				await migrator.up()
				expect.unreachable('should have thrown')
			} catch (err: any) {
				expect(err).toBeInstanceOf(OrmMigrationError)
				expect(err.phase).toBe('lock')
			}
		})
	})
}
