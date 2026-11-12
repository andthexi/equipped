import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { Pool } from 'pg'
import { v } from 'valleyed'
import { PostgresAdapter } from '../../../../src/orm/adapters/postgresql'
import { Migrator } from '../../../../src/orm/migrations/migrator'
import { Repo } from '../../../../src/orm/repo/repo'
import { Schema } from '../../../../src/orm/schema'
import { OrmIntrospectionError } from '../../../../src/orm/errors/introspection'
import { OrmMigrationError } from '../../../../src/orm/errors/migration'
import type { Migration } from '../../../../src/orm/migrations/types'
import { Instance } from '../../../../src/instance'

const PG_URL = process.env.PG_TEST_URL ?? 'postgresql://test:test@localhost:5432/testdb'
let pool: Pool
let canConnect = false

beforeAll(async () => {
	const spy = vi.spyOn(Instance, 'on').mockImplementation(() => {})
	try {
		pool = new Pool({ connectionString: PG_URL })
		await pool.query('SELECT 1')
		canConnect = true
	} catch {
		canConnect = false
	}
	spy.mockRestore()
})

afterAll(async () => {
	if (pool) await pool.end()
})

function skipIfNoDb() {
	if (!canConnect) return true
	return false
}

describe.skipIf(skipIfNoDb())('PostgresAdapter: real PG integration', () => {
	let adapter: PostgresAdapter
	let repo: ReturnType<typeof Repo.from<typeof adapter>>

	const onSpy = vi.spyOn(Instance, 'on').mockImplementation(() => {})

	beforeAll(() => {
		const parsed = new URL(PG_URL)
		adapter = PostgresAdapter.create({
			host: parsed.hostname,
			port: Number(parsed.port) || 5432,
			username: parsed.username,
			password: parsed.password,
			database: parsed.pathname.slice(1),
		})
		repo = Repo.from(adapter)
			.resolve((s) => ({ table: s.name }))
			.build()
	})

	afterEach(async () => {
		const client = adapter.pool
		const tables = await client.query(`
			SELECT table_name FROM information_schema.tables
			WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
		`)
		for (const row of tables.rows) {
			await client.query(`DROP TABLE IF EXISTS "${row.table_name}" CASCADE`)
		}
	})

	afterAll(async () => {
		onSpy.mockRestore()
		await adapter.pool.end()
	})

	test('end-to-end migration run covering all declarative variants', async () => {
		const migrations: Migration<typeof adapter>[] = [
			{
				id: '0001-create',
				changes: [
					{
						kind: 'createTable',
						name: 'users',
						pk: { name: 'id', type: 'string' },
						fields: [
							{ name: 'email', type: 'string', unique: true },
							{ name: 'age', type: 'number', nullable: true },
							{ name: 'active', type: 'boolean', default: true },
						],
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
						onDelete: 'cascade',
					},
				],
			},
			{
				id: '0002-evolve',
				changes: [
					{ kind: 'addField', table: 'users', field: { name: 'bio', type: 'string', nullable: true } },
					{ kind: 'renameField', table: 'users', from: 'email', to: 'emailAddress' },
					{
						kind: 'modifyField',
						table: 'users',
						name: 'age',
						to: { name: 'age', type: 'string', nullable: true },
					},
					{ kind: 'renameTable', from: 'posts', to: 'articles' },
				],
			},
			{
				id: '0003-cleanup',
				changes: [
					{ kind: 'dropField', table: 'users', name: 'bio' },
					{ kind: 'dropForeignKey', table: 'articles', name: 'fk_posts_authorId' },
					{ kind: 'dropIndex', name: 'idx_users_email_unique' },
					{ kind: 'dropTable', name: 'articles' },
				],
			},
		]

		const migrator = Migrator.from(repo, adapter).migrations(migrations).build()
		const result = await migrator.up()
		expect(result.ran).toEqual(['0001-create', '0002-evolve', '0003-cleanup'])

		const tablesResult = await adapter.pool.query(`
			SELECT table_name FROM information_schema.tables
			WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
		`)
		const tableNames = tablesResult.rows.map((r: any) => r.table_name)
		expect(tableNames).toContain('users')
		expect(tableNames).not.toContain('articles')
		expect(tableNames).toContain('equipped_migrations')
	})

	test('cluster lock serialises concurrent up() runs', async () => {
		const order: string[] = []
		const migrations: Migration<typeof adapter>[] = [
			{
				id: '0001-slow',
				changes: [
					{
						kind: 'execute',
						up: async () => {
							order.push('0001-start')
							await new Promise((r) => setTimeout(r, 100))
							order.push('0001-end')
						},
					},
				],
				tx: false,
			},
			{
				id: '0002-fast',
				changes: [
					{
						kind: 'execute',
						up: async () => {
							order.push('0002')
						},
					},
				],
				tx: false,
			},
		]

		const migrator1 = Migrator.from(repo, adapter).migrations(migrations).build()
		const migrator2 = Migrator.from(repo, adapter).migrations(migrations).build()

		await Promise.all([migrator1.up(), migrator2.up()])

		expect(order[0]).toBe('0001-start')
		expect(order[1]).toBe('0001-end')
	})

	test('tx:true rollback leaves no partial state', async () => {
		const UserSchema = Schema.from('users')
			.pk('id', v.string(), () => 'u1')
			.field('name', v.string())
			.build()

		await adapter.applyCreateTable({
			kind: 'createTable',
			name: 'users',
			pk: { name: 'id', type: 'string' },
			fields: [{ name: 'name', type: 'string' }],
		})

		const migrations: Migration<typeof adapter>[] = [
			{
				id: '0001-will-fail',
				changes: [
					{
						kind: 'execute',
						up: async (r) => {
							await r.on(UserSchema).one().create({ id: 'partial', name: 'test' })
							throw new Error('mid-migration boom')
						},
					},
				],
			},
		]

		const migrator = Migrator.from(repo, adapter).migrations(migrations).build()
		await expect(migrator.up()).rejects.toThrow(OrmMigrationError)

		const result = await adapter.pool.query(`SELECT * FROM "users" WHERE id = 'partial'`)
		expect(result.rows).toHaveLength(0)

		const tracker = await adapter.loadMigrations()
		expect(tracker).toHaveLength(0)
	})

	test('tx:false migration does not error for non-transactional ops', async () => {
		await adapter.applyCreateTable({
			kind: 'createTable',
			name: 'items',
			pk: { name: 'id', type: 'string' },
			fields: [{ name: 'name', type: 'string' }],
		})

		const migrations: Migration<typeof adapter>[] = [
			{
				id: '0001-concurrent-idx',
				tx: false,
				changes: [
					{
						kind: 'execute',
						up: async () => {
							await adapter.pool.query(
								'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_items_name ON items (name)',
							)
						},
					},
				],
			},
		]

		const migrator = Migrator.from(repo, adapter).migrations(migrations).build()
		const result = await migrator.up()
		expect(result.ran).toEqual(['0001-concurrent-idx'])
	})

	test('introspect() round-trips a known schema state', async () => {
		await adapter.applyCreateTable({
			kind: 'createTable',
			name: 'users',
			pk: { name: 'id', type: 'string' },
			fields: [
				{ name: 'email', type: 'string', unique: true },
				{ name: 'age', type: 'number', nullable: true },
				{ name: 'active', type: 'boolean', default: true },
				{ name: 'meta', type: 'object', nullable: true },
				{ name: 'created', type: 'date' },
			],
		})
		await adapter.applyAddIndex({ kind: 'addIndex', table: 'users', on: ['email', 'age'] })

		const schemas = await adapter.introspect()
		const users = schemas.find((s) => s.name === 'users')
		expect(users).toBeDefined()
		expect(users!.pk).toEqual({ name: 'id', type: 'string' })
		expect(users!.fields.find((f) => f.name === 'email')).toMatchObject({ type: 'string', nullable: false })
		expect(users!.fields.find((f) => f.name === 'age')).toMatchObject({ type: 'number', nullable: true })
		expect(users!.fields.find((f) => f.name === 'active')).toMatchObject({ type: 'boolean', nullable: false })
		expect(users!.fields.find((f) => f.name === 'meta')).toMatchObject({ type: 'object', nullable: true })
		expect(users!.fields.find((f) => f.name === 'created')).toMatchObject({ type: 'date', nullable: false })
		expect(users!.indexes.find((i) => i.on.includes('email') && i.on.includes('age'))).toBeDefined()
	})

	test('OrmIntrospectionError thrown on unsupported PG types', async () => {
		await adapter.pool.query(`CREATE TABLE "binfiles" (id text PRIMARY KEY, data bytea)`)

		await expect(adapter.introspect()).rejects.toThrow(OrmIntrospectionError)
		try {
			await adapter.introspect()
		} catch (err: any) {
			expect(err.adapter).toBe('postgresql')
			expect(err.table).toBe('binfiles')
			expect(err.cause).toContain('bytea')
		}
	})
})
