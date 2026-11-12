import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { v } from 'valleyed'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

import { Instance } from '../../../../src/instance'
import { PostgresAdapter } from '../../../../src/orm/adapters/postgresql'
import { MigrationCodegen } from '../../../../src/orm/migrations/codegen'
import { Migrator } from '../../../../src/orm/migrations/migrator'
import type { Migration } from '../../../../src/orm/migrations/types'
import { Repo } from '../../../../src/orm/repo/repo'
import { Schema } from '../../../../src/orm/schema'

const PG_TEST_URL = process.env.PG_TEST_URL

if (!PG_TEST_URL) {
	console.warn('PostgreSQL integration tests skipped: set PG_TEST_URL to an isolated, test-owned database')
}

function connectionConfig(url: string) {
	const parsed = new URL(url)
	return {
		host: parsed.hostname,
		port: Number(parsed.port) || 5432,
		username: decodeURIComponent(parsed.username),
		password: decodeURIComponent(parsed.password),
		database: parsed.pathname.slice(1),
		ssl: parsed.searchParams.get('sslmode') === 'require',
	}
}

function fixtureName(label: string) {
	return `equipped_${label}_${randomUUID().replaceAll('-', '').slice(0, 12)}`
}

describe.skipIf(!PG_TEST_URL)('PostgresAdapter: live migration and codegen integration', () => {
	let adapter: PostgresAdapter
	let publicTablesBefore: string[]
	let trackerExistedBefore: boolean
	const ownedSchemas = new Set<string>()
	const ownedMigrationIds = new Set<string>()
	const onSpy = vi.spyOn(Instance, 'on').mockImplementation(() => {})

	beforeAll(async () => {
		const probe = new Pool({ connectionString: PG_TEST_URL })
		try {
			await probe.query('SELECT 1')
		} finally {
			await probe.end()
		}

		adapter = PostgresAdapter.create(connectionConfig(PG_TEST_URL!))
		publicTablesBefore = await publicTableNames()
		trackerExistedBefore = publicTablesBefore.includes('equipped_migrations')
	})

	afterEach(async () => {
		for (const schema of ownedSchemas) {
			await adapter.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
		}
		ownedSchemas.clear()

		if (ownedMigrationIds.size > 0) {
			const tracker = await adapter.pool.query<{ tracker: string | null }>(
				`SELECT to_regclass('public.equipped_migrations')::text AS tracker`,
			)
			if (tracker.rows[0]?.tracker) {
				await adapter.pool.query('DELETE FROM "equipped_migrations" WHERE id = ANY($1::text[])', [
					[...ownedMigrationIds],
				])
			}
			ownedMigrationIds.clear()
		}
	})

	afterAll(async () => {
		if (adapter) {
			if (!trackerExistedBefore) await adapter.pool.query('DROP TABLE IF EXISTS "equipped_migrations"')
			const publicTablesAfter = await publicTableNames()
			expect(publicTablesAfter).toEqual(publicTablesBefore)
			await adapter.pool.end()
		}
		onSpy.mockRestore()
	})

	async function publicTableNames() {
		const result = await adapter.pool.query<{ table_name: string }>(`
			SELECT table_name
			FROM information_schema.tables
			WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
			ORDER BY table_name
		`)
		return result.rows.map(({ table_name }) => table_name)
	}

	async function createOwnedSchema(label: string) {
		const schema = fixtureName(label)
		ownedSchemas.add(schema)
		await adapter.pool.query(`CREATE SCHEMA "${schema}"`)
		return schema
	}

	function migrationId(label: string) {
		const id = `${fixtureName(label)}_${ownedMigrationIds.size}`
		ownedMigrationIds.add(id)
		return id
	}

	test('identity, arbitrary base, and scoped mappings migrate and persist through Repo queries', async () => {
		const namespace = await createOwnedSchema('routing')
		const UserSchema = Schema.from('users')
			.pk('id', v.string(), () => randomUUID())
			.field('email', v.string())
			.build()
		const repo = Repo.from(adapter)
			.resolve((name) => ({ schema: namespace, table: name === 'users' ? 'base_people' : name }))
			.build()
		const identityRepo = Repo.from(adapter)
			.resolve((name) => ({ schema: namespace, table: name }))
			.build()
		await adapter.applyCreateTable(
			{
				kind: 'createTable',
				name: 'identity_users',
				pk: { name: 'id', type: 'string' },
				fields: [{ name: 'email', type: 'string' }],
			},
			{ schema: namespace, table: 'identity_users' },
		)
		const IdentityUserSchema = Schema.from('identity_users').pk('id', v.string()).field('email', v.string()).build()
		await identityRepo.on(IdentityUserSchema).one().create({ id: 'identity-1', email: 'identity@example.com' })
		expect(await identityRepo.on(IdentityUserSchema).one().id('identity-1').find()).toMatchObject({
			email: 'identity@example.com',
		})
		const migration: Migration<typeof adapter> = {
			id: migrationId('routing'),
			changes: [
				{
					kind: 'createTable',
					name: 'users',
					pk: { name: 'id', type: 'string' },
					fields: [{ name: 'email', type: 'string' }],
				},
				{
					kind: 'execute',
					up: async (migrationRepo) => {
						await migrationRepo.on(UserSchema).one().create({ id: 'base-1', email: 'base@example.com' })
					},
				},
			],
		}

		await Migrator.from(repo).withLock().migrations([migration]).build().up()

		expect(await repo.on(UserSchema).one().id('base-1').find()).toMatchObject({ email: 'base@example.com' })
		const physical = await adapter.pool.query(`SELECT id, email FROM "${namespace}"."base_people"`)
		expect(physical.rows).toEqual([{ id: 'base-1', email: 'base@example.com' }])

		const scopedMigration: Migration<typeof adapter> = {
			id: migrationId('routing_scoped'),
			changes: [
				{
					kind: 'createTable',
					name: 'users',
					pk: { name: 'id', type: 'string' },
					fields: [{ name: 'email', type: 'string' }],
				},
				{
					kind: 'execute',
					up: async (migrationRepo) => {
						await migrationRepo.on(UserSchema).one().create({ id: 'scope-1', email: 'scope@example.com' })
					},
				},
			],
		}
		await repo.resolve(
			(config) => ({ ...config, table: 'scope_people' }),
			async () => {
				await Migrator.from(repo).withLock().migrations([migration, scopedMigration]).build().up()
				expect(await repo.on(UserSchema).one().id('scope-1').find()).toMatchObject({
					email: 'scope@example.com',
				})
				const scopedPhysical = await adapter.pool.query(`SELECT id, email FROM "${namespace}"."scope_people"`)
				expect(scopedPhysical.rows).toEqual([{ id: 'scope-1', email: 'scope@example.com' }])
			},
		)
		expect(await repo.on(UserSchema).one().id('scope-1').find()).toBeNull()
	})

	test('resolved rename, index, and foreign-key endpoints affect the intended physical targets', async () => {
		const namespace = await createOwnedSchema('targets')
		const mappings: Record<string, string> = {
			users: 'physical_users',
			posts: 'physical_posts',
			articles: 'physical_articles',
		}
		const repo = Repo.from(adapter)
			.resolve((name) => ({ schema: namespace, table: mappings[name] ?? name }))
			.build()
		const UserSchema = Schema.from('users').pk('id', v.string()).field('email', v.string()).build()
		const PostSchema = Schema.from('posts')
			.pk('id', v.string())
			.field('title', v.string())
			.field('authorId', v.string())
			.build()
		const ArticleSchema = Schema.from('articles')
			.pk('id', v.string())
			.field('headline', v.string())
			.field('authorId', v.string())
			.build()
		const migrations: Migration<typeof adapter>[] = [
			{
				id: migrationId('targets_create'),
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
					{ kind: 'addIndex', table: 'users', on: ['email'], name: 'literal_email_index' },
					{
						kind: 'addForeignKey',
						table: 'posts',
						on: 'authorId',
						references: { table: 'users', column: 'id' },
						name: 'literal_author_fk',
					},
					{
						kind: 'execute',
						up: async (migrationRepo) => {
							await migrationRepo.on(UserSchema).one().create({ id: 'u1', email: 'u@example.com' })
							await migrationRepo
								.on(PostSchema)
								.one()
								.create({ id: 'p1', title: 'hello', authorId: 'u1' })
						},
					},
				],
			},
			{
				id: migrationId('targets_rename'),
				changes: [
					{ kind: 'renameField', table: 'posts', from: 'title', to: 'headline' },
					{ kind: 'renameTable', from: 'posts', to: 'articles' },
				],
			},
		]

		await Migrator.from(repo).withLock().migrations(migrations).build().up()

		expect(await repo.on(ArticleSchema).one().id('p1').find()).toMatchObject({ headline: 'hello', authorId: 'u1' })
		const catalog = await adapter.pool.query(
			`SELECT
				to_regclass($1) IS NOT NULL AS renamed_table,
				to_regclass($2) IS NULL AS old_table,
				to_regclass($3) IS NOT NULL AS literal_index,
				EXISTS (
					SELECT 1 FROM information_schema.table_constraints
					WHERE constraint_schema = $4 AND table_name = 'physical_articles'
						AND constraint_name = 'literal_author_fk' AND constraint_type = 'FOREIGN KEY'
				) AS literal_fk`,
			[
				`${namespace}.physical_articles`,
				`${namespace}.physical_posts`,
				`${namespace}.literal_email_index`,
				namespace,
			],
		)
		expect(catalog.rows[0]).toEqual({ renamed_table: true, old_table: true, literal_index: true, literal_fk: true })
	})

	test('targeted codegen round-trips managed mapped tables without deleting unrelated objects', async () => {
		const namespace = await createOwnedSchema('codegen')
		await adapter.pool.query(`CREATE TABLE "${namespace}"."unrelated" (id text PRIMARY KEY)`)
		const repo = Repo.from(adapter)
			.resolve((name) => ({ schema: namespace, table: `mapped_${name}` }))
			.build()
		const UserV1 = Schema.from('users').pk('id', v.string()).field('email', v.string()).build()
		const firstCodegen = MigrationCodegen.from(repo).target([UserV1]).build()
		const createChanges = await firstCodegen.diff()
		expect(createChanges).toEqual([
			expect.objectContaining({
				kind: 'createTable',
				name: 'users',
				fields: [{ name: 'email', type: 'string' }],
			}),
		])

		const createId = migrationId('codegen_create')
		await Migrator.from(repo)
			.withLock()
			.migrations([{ id: createId, changes: createChanges! }])
			.build()
			.up()
		expect(await firstCodegen.diff()).toBeNull()

		const UserV2 = Schema.from('users')
			.pk('id', v.string())
			.field('email', v.string())
			.field('displayName', v.string())
			.build()
		const secondCodegen = MigrationCodegen.from(repo).target([UserV2]).build()
		const evolveChanges = await secondCodegen.diff()
		expect(evolveChanges).toEqual([
			{ kind: 'addField', table: 'users', field: { name: 'displayName', type: 'string' } },
		])
		const evolveId = migrationId('codegen_evolve')
		await Migrator.from(repo)
			.withLock()
			.migrations([
				{ id: createId, changes: createChanges! },
				{ id: evolveId, changes: evolveChanges! },
			])
			.build()
			.up()

		expect(await secondCodegen.diff()).toBeNull()
		const persisted = await adapter.introspectTarget({ schema: namespace, table: 'mapped_users' })
		expect(persisted?.fields.map(({ name }) => name)).toEqual(['email', 'displayName'])
		expect(await adapter.pool.query(`SELECT to_regclass($1) AS table`, [`${namespace}.unrelated`])).toMatchObject({
			rows: [{ table: `${namespace}.unrelated` }],
		})
	})
})
