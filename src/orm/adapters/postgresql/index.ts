import { AsyncLocalStorage } from 'node:async_hooks'

import { Pool, type PoolClient } from 'pg'
import Cursor from 'pg-cursor'
import { v } from 'valleyed'

import { EquippedError } from '../../../errors/index.js'
import { configurable } from '../../../utilities/index.js'
import type { FieldTypeName } from '../../adapter.js'
import type { FilterGroup } from '../../filter.js'
import type { DiscoveredSchema, ForeignKeyAction } from '../../migrations/introspection-types.js'
import type {
	AddFieldChange,
	AddForeignKeyChange,
	AddIndexChange,
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
import { flattenOps, type AnyUpdateOp } from '../../updates.js'
import {
	buildAggregateQuery,
	buildCountQuery,
	buildCreateQuery,
	buildDeleteQuery,
	buildPkUpdateQuery,
	buildSelectQuery,
	buildUpdateQuery,
	buildUpsertQuery,
	extractUpsertConflictColumn,
} from './query.js'

export type PostgresqlRepoConfig = {
	schema?: string
	table: string
}

export type PostgresqlConnectionConfig = {
	host: string
	port: number
	username: string
	password: string
	database: string
	ssl?: boolean
}

const postgresqlConnectionPipe = () =>
	v.object({
		host: v.string(),
		port: v.number(),
		username: v.string(),
		password: v.string(),
		database: v.string(),
		ssl: v.defaults(v.boolean(), false),
	})

const TRACKER_TABLE = 'equipped_migrations'
const ADVISORY_LOCK_KEY = 3_735_928_559
const DEFAULT_CURSOR_BATCH_SIZE = 1000

type PostgresCursor<T extends Record<string, unknown>> = {
	read: (rowCount: number) => Promise<T[]>
	close: () => Promise<void>
}

const FIELD_TYPE_TO_PG: Record<string, string> = {
	string: 'text',
	number: 'double precision',
	boolean: 'boolean',
	date: 'timestamptz',
	null: 'text',
	object: 'jsonb',
	array: 'jsonb',
}

const PG_TO_FIELD_TYPE: Record<string, FieldTypeName> = {
	text: 'string',
	'character varying': 'string',
	varchar: 'string',
	char: 'string',
	character: 'string',
	'double precision': 'number',
	real: 'number',
	integer: 'number',
	smallint: 'number',
	numeric: 'number',
	decimal: 'number',
	boolean: 'boolean',
	'timestamp with time zone': 'date',
	'timestamp without time zone': 'date',
	timestamptz: 'date',
	timestamp: 'date',
	date: 'date',
	jsonb: 'object',
	json: 'object',
}

export class PostgresAdapter extends configurable(postgresqlConnectionPipe, OrmAdapter) {
	readonly schemaConfigPipe = v.object({
		schema: v.optional(v.string()),
		table: v.string(),
	})

	readonly supportedFieldTypes = ['string', 'number', 'boolean', 'null', 'object', 'array', 'date'] as const
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

	readonly pool: Pool
	#sessionStore = new AsyncLocalStorage<PoolClient | undefined>()

	protected constructor(config: typeof PostgresAdapter.Config) {
		super(config)
		this.pool = new Pool({
			host: config.host,
			port: config.port,
			user: config.username,
			password: config.password,
			database: config.database,
			ssl: config.ssl ? { rejectUnauthorized: false } : false,
		})
	}

	#getClient() {
		return this.#sessionStore.getStore() ?? this.pool
	}

	#resolveTableName(config: PostgresqlRepoConfig) {
		return config.schema && config.schema !== 'public' ? `${config.schema}.${config.table}` : config.table
	}

	async connect() {}

	async disconnect() {
		try {
			await this.pool.end()
		} catch (error) {
			throw new EquippedError('Failed to disconnect PostgreSQL pool', { adapter: 'postgresql' }, error)
		}
	}

	async findByPk(schema: AnySchema, config: unknown, pk: unknown) {
		const c = config as PostgresqlRepoConfig
		try {
			const tableName = this.#resolveTableName(c)
			const pkName = schema.pkField.name
			const result = await this.#getClient().query(`SELECT * FROM "${tableName}" WHERE "${pkName}" = $1`, [pk])
			return result.rows[0] ?? null
		} catch (error) {
			throw new EquippedError(
				'PostgreSQL findByPk failed',
				{ adapter: 'postgresql', operation: 'findByPk', table: c.table },
				error,
			)
		}
	}

	async createMany(_schema: AnySchema, config: unknown, data: Record<string, unknown>[]) {
		const c = config as PostgresqlRepoConfig
		try {
			const tableName = this.#resolveTableName(c)
			const client = this.#getClient()
			const results: Record<string, unknown>[] = []
			for (const doc of data) {
				const { sql, params } = buildCreateQuery(tableName, doc)
				const result = await client.query(sql, params)
				results.push(result.rows[0])
			}
			return results
		} catch (error) {
			throw new EquippedError(
				'PostgreSQL createMany failed',
				{ adapter: 'postgresql', operation: 'createMany', table: c.table },
				error,
			)
		}
	}

	async updateByPk(schema: AnySchema, config: unknown, pk: unknown, ops: AnyUpdateOp[]) {
		const c = config as PostgresqlRepoConfig
		try {
			const tableName = this.#resolveTableName(c)
			const pkName = schema.pkField.name
			const data = flattenOps(ops)
			if (Object.keys(data).length === 0) {
				const result = await this.#getClient().query(`SELECT * FROM "${tableName}" WHERE "${pkName}" = $1`, [
					pk,
				])
				return result.rows[0] ?? null
			}
			const { sql, params } = buildPkUpdateQuery(tableName, pkName, pk, data)
			const result = await this.#getClient().query(sql, params)
			return result.rows[0] ?? null
		} catch (error) {
			throw new EquippedError(
				'PostgreSQL updateByPk failed',
				{ adapter: 'postgresql', operation: 'updateByPk', table: c.table },
				error,
			)
		}
	}

	async deleteByPk(schema: AnySchema, config: unknown, pk: unknown) {
		const c = config as PostgresqlRepoConfig
		try {
			const tableName = this.#resolveTableName(c)
			const pkName = schema.pkField.name
			const result = await this.#getClient().query(
				`DELETE FROM "${tableName}" WHERE "${pkName}" = $1 RETURNING *`,
				[pk],
			)
			return result.rows[0] ?? null
		} catch (error) {
			throw new EquippedError(
				'PostgreSQL deleteByPk failed',
				{ adapter: 'postgresql', operation: 'deleteByPk', table: c.table },
				error,
			)
		}
	}

	async raw(_schema: AnySchema, config: unknown, command: string, params: unknown[] = []) {
		const c = config as PostgresqlRepoConfig
		try {
			const result = await this.#getClient().query(command, params)
			return result
		} catch (error) {
			if (error instanceof EquippedError) throw error
			throw new EquippedError(
				'PostgreSQL raw failed',
				{ adapter: 'postgresql', operation: 'raw', table: c.table },
				error,
			)
		}
	}

	async findMany(schema: AnySchema, config: unknown, filter: FilterGroup, options?: QueryOptions) {
		const c = config as PostgresqlRepoConfig
		try {
			const tableName = this.#resolveTableName(c)
			const { sql, params } = buildSelectQuery(filter, options, tableName, schema.pkField.name)
			const result = await this.#getClient().query(sql, params)
			return result.rows
		} catch (error) {
			throw new EquippedError(
				'PostgreSQL findMany failed',
				{ adapter: 'postgresql', operation: 'findMany', table: c.table },
				error,
			)
		}
	}

	async count(schema: AnySchema, config: unknown, filter: FilterGroup) {
		const c = config as PostgresqlRepoConfig
		try {
			const tableName = this.#resolveTableName(c)
			const { sql, params } = buildCountQuery(filter, tableName, schema.pkField.name)
			const result = await this.#getClient().query(sql, params)
			return Number(result.rows[0]?.count ?? 0)
		} catch (error) {
			throw new EquippedError(
				'PostgreSQL count failed',
				{ adapter: 'postgresql', operation: 'count', table: c.table },
				error,
			)
		}
	}

	async *iterateMany(schema: AnySchema, config: unknown, filter: FilterGroup, options?: IterationQueryOptions) {
		const c = config as PostgresqlRepoConfig
		let client: PoolClient | undefined
		let releaseClient = false
		let cursor: PostgresCursor<Record<string, unknown>> | undefined
		try {
			const tableName = this.#resolveTableName(c)
			const { sql, params } = buildSelectQuery(filter, options, tableName, schema.pkField.name)
			const sessionClient = this.#sessionStore.getStore()
			if (sessionClient) {
				client = sessionClient
			} else {
				client = await this.pool.connect()
				releaseClient = true
			}
			cursor = client.query(new Cursor<Record<string, unknown>>(sql, params) as any) as PostgresCursor<
				Record<string, unknown>
			>
			const batchSize = options?.batchSize ?? DEFAULT_CURSOR_BATCH_SIZE

			while (true) {
				const rows = await cursor.read(batchSize)
				if (rows.length === 0) break
				for (const row of rows) yield row
			}
		} catch (error) {
			throw new EquippedError(
				'PostgreSQL iterateMany failed',
				{ adapter: 'postgresql', operation: 'iterateMany', table: c.table },
				error,
			)
		} finally {
			try {
				await cursor?.close()
			} finally {
				if (releaseClient) client?.release()
			}
		}
	}

	async updateMany(schema: AnySchema, config: unknown, filter: FilterGroup, data: Record<string, unknown>) {
		const c = config as PostgresqlRepoConfig
		try {
			const tableName = this.#resolveTableName(c)
			const { sql, params } = buildUpdateQuery(filter, tableName, schema.pkField.name, data)
			const result = await this.#getClient().query(sql, params)
			return result.rows
		} catch (error) {
			throw new EquippedError(
				'PostgreSQL updateMany failed',
				{ adapter: 'postgresql', operation: 'updateMany', table: c.table },
				error,
			)
		}
	}

	async deleteMany(schema: AnySchema, config: unknown, filter: FilterGroup) {
		const c = config as PostgresqlRepoConfig
		try {
			const tableName = this.#resolveTableName(c)
			const { sql, params } = buildDeleteQuery(filter, tableName, schema.pkField.name)
			const result = await this.#getClient().query(sql, params)
			return result.rows
		} catch (error) {
			throw new EquippedError(
				'PostgreSQL deleteMany failed',
				{ adapter: 'postgresql', operation: 'deleteMany', table: c.table },
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
		const c = config as PostgresqlRepoConfig
		try {
			const tableName = this.#resolveTableName(c)
			const conflictColumn = extractUpsertConflictColumn(filter, schema.name)
			const data = ops.length > 0 ? flattenOps(ops) : {}
			const { sql, params } = buildUpsertQuery(tableName, conflictColumn, schema.pkField.name, create, data)
			const result = await this.#getClient().query(sql, params)
			return result.rows[0]
		} catch (error) {
			if (error instanceof EquippedError) throw error
			throw new EquippedError(
				'PostgreSQL upsertOne failed',
				{ adapter: 'postgresql', operation: 'upsertOne', table: c.table },
				error,
			)
		}
	}

	async aggregate(schema: AnySchema, config: unknown, spec: AggregateSpec): Promise<Array<Record<string, unknown>>> {
		const c = config as PostgresqlRepoConfig
		try {
			const tableName = this.#resolveTableName(c)
			const { sql, params } = buildAggregateQuery(spec, tableName, schema.pkField.name)
			const result = await this.#getClient().query(sql, params)
			return result.rows.map((row: Record<string, unknown>) => {
				const mapped: Record<string, unknown> = {}
				for (const agg of spec.aggregates) {
					const val = row[agg.alias]
					if (agg.fn === 'min' || agg.fn === 'max') {
						mapped[agg.alias] = val
					} else {
						mapped[agg.alias] = typeof val === 'string' ? Number(val) : Number(val ?? 0)
					}
				}
				for (const field of spec.groupBy) {
					mapped[field] = row[field]
				}
				return mapped
			})
		} catch (error) {
			if (error instanceof EquippedError) throw error
			throw new EquippedError(
				'PostgreSQL aggregate failed',
				{ adapter: 'postgresql', operation: 'aggregate', table: c.table },
				error,
			)
		}
	}

	async loadMigrations(): Promise<{ id: string; appliedAt: number }[]> {
		const client = this.#getClient()
		await client.query(`
			CREATE TABLE IF NOT EXISTS "${TRACKER_TABLE}" (
				id text PRIMARY KEY,
				applied_at bigint NOT NULL
			)
		`)
		const result = await client.query(`SELECT id, applied_at FROM "${TRACKER_TABLE}"`)
		return result.rows.map((row: any) => ({ id: row.id, appliedAt: Number(row.applied_at) }))
	}

	async recordMigration(id: string, appliedAt: number): Promise<void> {
		const client = this.#getClient()
		await client.query(`INSERT INTO "${TRACKER_TABLE}" (id, applied_at) VALUES ($1, $2)`, [id, appliedAt])
	}

	async acquireMigrationLock<T>(fn: () => Promise<T>): Promise<T> {
		const client = this.#getClient()
		await client.query(`SELECT pg_advisory_lock($1)`, [ADVISORY_LOCK_KEY])
		try {
			return await fn()
		} finally {
			await client.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY])
		}
	}

	async applyCreateTable(change: CreateTableChange<any>): Promise<void> {
		const pkType = FIELD_TYPE_TO_PG[change.pk.type] ?? 'text'
		const cols = [`"${change.pk.name}" ${pkType} PRIMARY KEY`]
		for (const f of change.fields) {
			cols.push(this.#renderColumnDef(f))
		}
		await this.#getClient().query(`CREATE TABLE "${change.name}" (${cols.join(', ')})`)
	}

	async applyDropTable(change: DropTableChange): Promise<void> {
		await this.#getClient().query(`DROP TABLE "${change.name}"`)
	}

	async applyAddField(change: AddFieldChange<any>): Promise<void> {
		const colDef = this.#renderColumnDef(change.field)
		await this.#getClient().query(`ALTER TABLE "${change.table}" ADD COLUMN ${colDef}`)
	}

	async applyDropField(change: DropFieldChange): Promise<void> {
		await this.#getClient().query(`ALTER TABLE "${change.table}" DROP COLUMN "${change.name}"`)
	}

	async applyModifyField(change: ModifyFieldChange<any>): Promise<void> {
		const client = this.#getClient()
		const table = `"${change.table}"`
		const col = `"${change.name}"`
		const newType = FIELD_TYPE_TO_PG[change.to.type] ?? 'text'
		await client.query(`ALTER TABLE ${table} ALTER COLUMN ${col} TYPE ${newType} USING ${col}::${newType}`)
		if (change.to.nullable) {
			await client.query(`ALTER TABLE ${table} ALTER COLUMN ${col} DROP NOT NULL`)
		} else {
			await client.query(`ALTER TABLE ${table} ALTER COLUMN ${col} SET NOT NULL`)
		}
		if (change.to.default !== undefined) {
			await client.query(
				`ALTER TABLE ${table} ALTER COLUMN ${col} SET DEFAULT ${this.#renderDefault(change.to.default)}`,
			)
		} else {
			await client.query(`ALTER TABLE ${table} ALTER COLUMN ${col} DROP DEFAULT`)
		}
		if (change.to.name !== change.name) {
			await client.query(`ALTER TABLE ${table} RENAME COLUMN ${col} TO "${change.to.name}"`)
		}
	}

	async applyRenameTable(change: RenameTableChange): Promise<void> {
		await this.#getClient().query(`ALTER TABLE "${change.from}" RENAME TO "${change.to}"`)
	}

	async applyRenameField(change: RenameFieldChange): Promise<void> {
		await this.#getClient().query(`ALTER TABLE "${change.table}" RENAME COLUMN "${change.from}" TO "${change.to}"`)
	}

	async applyAddIndex(change: AddIndexChange): Promise<void> {
		const name = change.name ?? this.#deriveIndexName(change.table, change.on as string[], change.unique)
		const unique = change.unique ? 'UNIQUE ' : ''
		const cols = (change.on as string[]).map((c) => `"${c}"`).join(', ')
		await this.#getClient().query(`CREATE ${unique}INDEX "${name}" ON "${change.table}" (${cols})`)
	}

	async applyDropIndex(change: DropIndexChange): Promise<void> {
		await this.#getClient().query(`DROP INDEX "${change.name}"`)
	}

	async applyAddForeignKey(change: AddForeignKeyChange): Promise<void> {
		const name = change.name ?? `fk_${change.table}_${change.on}`
		let sql = `ALTER TABLE "${change.table}" ADD CONSTRAINT "${name}" FOREIGN KEY ("${change.on}") REFERENCES "${change.references.table}" ("${change.references.column}")`
		if (change.onDelete) sql += ` ON DELETE ${this.#renderFkAction(change.onDelete)}`
		if (change.onUpdate) sql += ` ON UPDATE ${this.#renderFkAction(change.onUpdate)}`
		await this.#getClient().query(sql)
	}

	async applyDropForeignKey(change: DropForeignKeyChange): Promise<void> {
		await this.#getClient().query(`ALTER TABLE "${change.table}" DROP CONSTRAINT "${change.name}"`)
	}

	async introspect(): Promise<DiscoveredSchema[]> {
		const { OrmIntrospectionError } = await import('../../errors/introspection.js')
		const client = this.#getClient()

		const tablesResult = await client.query(
			`
			SELECT table_name FROM information_schema.tables
			WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name != $1
		`,
			[TRACKER_TABLE],
		)

		const schemas: DiscoveredSchema[] = []

		for (const tableRow of tablesResult.rows) {
			const tableName = tableRow.table_name

			const colsResult = await client.query(
				`
				SELECT column_name, data_type, is_nullable, column_default
				FROM information_schema.columns
				WHERE table_schema = 'public' AND table_name = $1
				ORDER BY ordinal_position
			`,
				[tableName],
			)

			const pkResult = await client.query(
				`
				SELECT kcu.column_name
				FROM information_schema.table_constraints tc
				JOIN information_schema.key_column_usage kcu
					ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
				WHERE tc.table_schema = 'public' AND tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY'
			`,
				[tableName],
			)

			const pkColName = pkResult.rows[0]?.column_name as string | undefined

			const uniqueResult = await client.query(
				`
				SELECT kcu.column_name
				FROM information_schema.table_constraints tc
				JOIN information_schema.key_column_usage kcu
					ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
				WHERE tc.table_schema = 'public' AND tc.table_name = $1 AND tc.constraint_type = 'UNIQUE'
			`,
				[tableName],
			)
			const uniqueCols = new Set(uniqueResult.rows.map((r: any) => r.column_name))

			let pk: { name: string; type: FieldTypeName } | undefined
			const fields: {
				name: string
				type: FieldTypeName
				nullable: boolean
				default?: string | number | boolean | null
				unique?: boolean
			}[] = []

			for (const col of colsResult.rows) {
				const pgType = (col.data_type as string).toLowerCase()
				const fieldType = PG_TO_FIELD_TYPE[pgType]
				if (!fieldType) {
					throw new OrmIntrospectionError({
						adapter: 'postgresql',
						table: tableName,
						cause: `Unsupported column type '${pgType}' on column '${col.column_name}'`,
					})
				}

				if (col.column_name === pkColName) {
					pk = { name: col.column_name, type: fieldType }
					continue
				}

				const nullable = col.is_nullable === 'YES'
				const raw = col.column_default as string | null
				const def = this.#parseDefault(raw)

				fields.push({
					name: col.column_name,
					type: fieldType,
					nullable,
					...(def !== undefined ? { default: def } : {}),
					...(uniqueCols.has(col.column_name) ? { unique: true } : {}),
				})
			}

			const idxResult = await client.query(
				`
				SELECT indexname, indexdef
				FROM pg_indexes
				WHERE schemaname = 'public' AND tablename = $1
			`,
				[tableName],
			)

			const indexes: { name: string; on: readonly string[]; unique: boolean }[] = []
			for (const idx of idxResult.rows) {
				const idxName = idx.indexname as string
				const idxDef = idx.indexdef as string
				if (idxDef.includes('PRIMARY KEY') || idxName.endsWith('_pkey')) continue
				const unique = idxDef.toUpperCase().includes('UNIQUE')
				const colMatch = idxDef.match(/\(([^)]+)\)/)
				const cols = colMatch ? colMatch[1].split(',').map((c: string) => c.trim().replace(/"/g, '')) : []
				indexes.push({ name: idxName, on: cols, unique })
			}

			const fkResult = await client.query(
				`
				SELECT
					tc.constraint_name,
					kcu.column_name,
					ccu.table_name AS foreign_table_name,
					ccu.column_name AS foreign_column_name,
					rc.delete_rule,
					rc.update_rule
				FROM information_schema.table_constraints tc
				JOIN information_schema.key_column_usage kcu
					ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
				JOIN information_schema.constraint_column_usage ccu
					ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
				JOIN information_schema.referential_constraints rc
					ON tc.constraint_name = rc.constraint_name AND tc.table_schema = rc.constraint_schema
				WHERE tc.table_schema = 'public' AND tc.table_name = $1 AND tc.constraint_type = 'FOREIGN KEY'
			`,
				[tableName],
			)

			const foreignKeys: {
				name: string
				on: string
				references: { table: string; column: string }
				onDelete?: ForeignKeyAction
				onUpdate?: ForeignKeyAction
			}[] = []
			for (const fk of fkResult.rows) {
				foreignKeys.push({
					name: fk.constraint_name,
					on: fk.column_name,
					references: { table: fk.foreign_table_name, column: fk.foreign_column_name },
					...(fk.delete_rule && fk.delete_rule !== 'NO ACTION'
						? { onDelete: this.#parseFkAction(fk.delete_rule) }
						: {}),
					...(fk.update_rule && fk.update_rule !== 'NO ACTION'
						? { onUpdate: this.#parseFkAction(fk.update_rule) }
						: {}),
				})
			}

			schemas.push({ name: tableName, pk, fields, indexes, foreignKeys })
		}

		return schemas
	}

	#renderColumnDef(f: {
		name: string
		type: string
		nullable?: boolean
		default?: string | number | boolean | null
		unique?: boolean
	}): string {
		const pgType = FIELD_TYPE_TO_PG[f.type] ?? 'text'
		let def = `"${f.name}" ${pgType}`
		if (!f.nullable) def += ' NOT NULL'
		if (f.default !== undefined) def += ` DEFAULT ${this.#renderDefault(f.default)}`
		if (f.unique) def += ' UNIQUE'
		return def
	}

	#renderDefault(val: string | number | boolean | null | undefined): string {
		if (val === null) return 'NULL'
		if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`
		if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE'
		return String(val)
	}

	#deriveIndexName(table: string, cols: string[], unique?: boolean): string {
		const base = `idx_${table}_${cols.join('_')}`
		return unique ? `${base}_unique` : base
	}

	#renderFkAction(action: string): string {
		const map: Record<string, string> = {
			cascade: 'CASCADE',
			restrict: 'RESTRICT',
			setnull: 'SET NULL',
			noaction: 'NO ACTION',
		}
		return map[action.toLowerCase()] ?? 'NO ACTION'
	}

	#parseFkAction(rule: string): ForeignKeyAction {
		const map: Record<string, ForeignKeyAction> = {
			CASCADE: 'cascade',
			RESTRICT: 'restrict',
			'SET NULL': 'setNull',
		}
		return map[rule.toUpperCase()] ?? 'noAction'
	}

	#parseDefault(raw: string | null): string | number | boolean | null | undefined {
		if (raw === null || raw === undefined) return undefined
		if (raw === 'NULL' || raw === 'NULL::text') return null
		if (raw === 'true' || raw === 'TRUE') return true
		if (raw === 'false' || raw === 'FALSE') return false
		const numMatch = raw.match(/^(-?\d+(?:\.\d+)?)$/)
		if (numMatch) return Number(numMatch[1])
		const strMatch = raw.match(/^'(.*)'(?:::.*)?$/)
		if (strMatch) return strMatch[1].replace(/''/g, "'")
		return undefined
	}

	async session<T>(fn: () => Promise<T>): Promise<T> {
		if (this.#sessionStore.getStore()) return fn()
		let client: PoolClient | undefined
		try {
			client = await this.pool.connect()
			await client.query('BEGIN')
			const result = await this.#sessionStore.run(client, fn)
			await client.query('COMMIT')
			return result
		} catch (error) {
			if (client) {
				try {
					await client.query('ROLLBACK')
				} catch {
					// ignore rollback errors and report original failure
				}
			}
			if (error instanceof EquippedError) throw error
			throw new EquippedError('PostgreSQL session failed', { adapter: 'postgresql', operation: 'session' }, error)
		} finally {
			client?.release()
		}
	}
}

if (import.meta.vitest) {
	const { describe, test, expect, expectTypeOf, vi, beforeEach, afterEach } = import.meta.vitest

	const testConnectionConfig = {
		host: 'localhost',
		port: 5432,
		username: 'test',
		password: 'test',
		database: 'testdb',
		ssl: false,
	} as const

	describe('PostgresAdapter: class-via-configurable shape', () => {
		let onSpy: ReturnType<typeof vi.spyOn>

		beforeEach(async () => {
			const { Instance } = await import('../../../instance/index.js')
			onSpy = vi.spyOn(Instance, 'on').mockImplementation(() => {})
		})

		afterEach(() => {
			onSpy.mockRestore()
		})

		test('PostgresAdapter.create returns instance with correct capability declarations', () => {
			const adapter = PostgresAdapter.create(testConnectionConfig)

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
		})

		test('PostgresAdapter.create validates connection config', () => {
			expect(() => PostgresAdapter.create({ host: 123, port: 'bad' } as any)).toThrow()
		})

		test('pool is exposed as a readonly instance field', () => {
			const adapter = PostgresAdapter.create(testConnectionConfig)

			expect(adapter.pool).toBeInstanceOf(Pool)
		})

		test('schemaConfigPipe is declared as readonly with table-name shape', () => {
			const adapter = PostgresAdapter.create(testConnectionConfig)

			expect(adapter.schemaConfigPipe).toBeDefined()
		})

		test('auto-wires Instance hooks for connect and disconnect', () => {
			PostgresAdapter.create(testConnectionConfig)

			expect(onSpy).toHaveBeenCalledWith(
				'start',
				expect.any(Function),
				expect.objectContaining({ class: PostgresAdapter }),
			)
			expect(onSpy).toHaveBeenCalledWith(
				'close',
				expect.any(Function),
				expect.objectContaining({ class: PostgresAdapter }),
			)
		})

		test('adapter.use returns OrmUse-shaped object', async () => {
			const { Schema } = await import('../../schema.js')

			const schema = Schema.from('test')
				.pk('id', v.string(), () => 'x')
				.build()
			const adapter = PostgresAdapter.create(testConnectionConfig)
			const use = adapter.use(schema, { table: 'test' })

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

		test('type-level: capability declarations use as const', () => {
			const _adapter = PostgresAdapter.create(testConnectionConfig)

			type Ops = typeof _adapter.updateOps
			expectTypeOf<Ops>().toEqualTypeOf<
				readonly ['set', 'inc', 'mul', 'min', 'max', 'unset', 'push', 'pull', 'patch']
			>()

			type Types = typeof _adapter.supportedFieldTypes
			expectTypeOf<Types>().toEqualTypeOf<
				readonly ['string', 'number', 'boolean', 'null', 'object', 'array', 'date']
			>()

			type QOps = typeof _adapter.queryableOps
			expectTypeOf<QOps>().toEqualTypeOf<
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

		test('type-level: Repo.from with PostgresAdapter enables all builder methods', async () => {
			const { Repo } = await import('../../repo/repo.js')
			const { Schema } = await import('../../schema.js')

			const adapter = PostgresAdapter.create(testConnectionConfig)
			const repo = Repo.from(adapter)
				.resolve(() => ({ table: 'test', schema: undefined }))
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

		test('type-level: raw arg-tuple infers (command: string, params?: unknown[]) from PostgresAdapter', async () => {
			const { Repo } = await import('../../repo/repo.js')
			const { Schema } = await import('../../schema.js')

			const adapter = PostgresAdapter.create(testConnectionConfig)
			const repo = Repo.from(adapter)
				.resolve(() => ({ table: 'test', schema: undefined }))
				.build()
			const _TestSchema = Schema.from('test')
				.pk('id', v.string(), () => 'x')
				.build()
			const _ref = repo.on(_TestSchema)

			expectTypeOf(_ref.raw).parameters.toEqualTypeOf<[command: string, params?: unknown[]]>()
		})

		test('type-level: per-call <T> override narrows PostgresAdapter raw return type', async () => {
			const { Repo } = await import('../../repo/repo.js')
			const { Schema } = await import('../../schema.js')

			const adapter = PostgresAdapter.create(testConnectionConfig)
			const repo = Repo.from(adapter)
				.resolve(() => ({ table: 'test', schema: undefined }))
				.build()
			const _TestSchema = Schema.from('test')
				.pk('id', v.string(), () => 'x')
				.build()
			const _ref = repo.on(_TestSchema)

			expectTypeOf(_ref.raw<{ id: string }[]>).returns.toEqualTypeOf<Promise<{ id: string }[]>>()
		})

		test('count forwards COUNT query to pool.query and returns a number', async () => {
			const { Schema } = await import('../../schema.js')
			const { FilterGroup } = await import('../../filter.js')

			const schema = Schema.from('pg_count')
				.pk('id', v.string(), () => 'x')
				.field('name', v.string())
				.build()
			const adapter = PostgresAdapter.create(testConnectionConfig)
			let capturedSql: unknown
			let capturedParams: unknown
			;(adapter.pool as any).query = async (sql: unknown, params: unknown) => {
				capturedSql = sql
				capturedParams = params
				return { rows: [{ count: '4' }] }
			}

			const result = await adapter.count(schema, { table: 'users' }, FilterGroup.create().eq('name', 'Alice'))
			expect(capturedSql).toBe('SELECT COUNT(*) as count FROM "users" WHERE "name" = $1')
			expect(capturedParams).toEqual(['Alice'])
			expect(result).toBe(4)
		})

		test('raw forwards (command, params) to pool.query at runtime', async () => {
			const { Schema } = await import('../../schema.js')

			const schema = Schema.from('pg_raw')
				.pk('id', v.string(), () => 'x')
				.build()
			const adapter = PostgresAdapter.create(testConnectionConfig)
			let capturedCommand: unknown
			let capturedParams: unknown
			const mockResult = { rows: [{ id: '1' }], rowCount: 1 }
			;(adapter.pool as any).query = async (cmd: unknown, params: unknown) => {
				capturedCommand = cmd
				capturedParams = params
				return mockResult
			}
			const result = await adapter
				.use(schema, { table: 'users' })
				.raw('SELECT * FROM users WHERE id = $1', ['abc'])
			expect(capturedCommand).toBe('SELECT * FROM users WHERE id = $1')
			expect(capturedParams).toEqual(['abc'])
			expect(result).toBe(mockResult)
		})

		test('raw defaults params to [] when omitted', async () => {
			const { Schema } = await import('../../schema.js')

			const schema = Schema.from('pg_raw2')
				.pk('id', v.string(), () => 'x')
				.build()
			const adapter = PostgresAdapter.create(testConnectionConfig)
			let capturedParams: unknown
			;(adapter.pool as any).query = async (_cmd: unknown, params: unknown) => {
				capturedParams = params
				return { rows: [] }
			}
			await adapter.use(schema, { table: 'users' }).raw('SELECT 1')
			expect(capturedParams).toEqual([])
		})

		test('iterateMany opens a dedicated cursor client, reads in batchSize chunks, and releases on completion', async () => {
			const { Schema } = await import('../../schema.js')
			const { FilterGroup } = await import('../../filter.js')
			const { OrderBy } = await import('../../query-options.js')

			const schema = Schema.from('pg_iter')
				.pk('id', v.string(), () => 'x')
				.field('age', v.number())
				.build()
			const adapter = PostgresAdapter.create(testConnectionConfig)
			let capturedCursor: Cursor<Record<string, unknown>> | undefined
			const release = vi.fn()
			const cursor = {
				read: vi
					.fn()
					.mockResolvedValueOnce([{ id: 'u3', age: 40 }])
					.mockResolvedValueOnce([{ id: 'u1', age: 30 }])
					.mockResolvedValueOnce([]),
				close: vi.fn().mockResolvedValue(undefined),
			}
			const client = {
				query: vi.fn((query: Cursor<Record<string, unknown>>) => {
					capturedCursor = query
					return cursor
				}),
				release,
			}
			;(adapter.pool as any).connect = vi.fn(async () => client)

			const rows: Record<string, unknown>[] = []
			for await (const row of adapter
				.use(schema, { table: 'people' })
				.iterateMany(FilterGroup.create().gt('age', 19), {
					orderBy: [new OrderBy('age', 'desc')],
					offset: 1,
					limit: 2,
					batchSize: 1,
				})) {
				rows.push(row)
			}

			expect((adapter.pool as any).connect).toHaveBeenCalledTimes(1)
			expect(capturedCursor).toBeInstanceOf(Cursor)
			const capturedCursorConfig = capturedCursor as unknown as { text: string; values: unknown[] }
			expect(capturedCursorConfig.text).toBe(
				'SELECT * FROM "people" WHERE "age" > $1 ORDER BY "age" DESC LIMIT $2 OFFSET $3',
			)
			expect(capturedCursorConfig.values).toEqual(['19', '2', '1'])
			expect(cursor.read).toHaveBeenNthCalledWith(1, 1)
			expect(cursor.read).toHaveBeenNthCalledWith(2, 1)
			expect(cursor.read).toHaveBeenNthCalledWith(3, 1)
			expect(cursor.close).toHaveBeenCalledTimes(1)
			expect(release).toHaveBeenCalledTimes(1)
			expect(rows).toEqual([
				{ id: 'u3', age: 40 },
				{ id: 'u1', age: 30 },
			])
		})

		test('iterateMany closes cursor and releases dedicated client on early break', async () => {
			const { Schema } = await import('../../schema.js')
			const { FilterGroup } = await import('../../filter.js')

			const schema = Schema.from('pg_iter_break')
				.pk('id', v.string(), () => 'x')
				.build()
			const adapter = PostgresAdapter.create(testConnectionConfig)
			const release = vi.fn()
			const cursor = {
				read: vi.fn().mockResolvedValueOnce([{ id: 'u1' }, { id: 'u2' }]),
				close: vi.fn().mockResolvedValue(undefined),
			}
			;(adapter.pool as any).connect = vi.fn(async () => ({
				query: vi.fn(() => cursor),
				release,
			}))

			const rows: Record<string, unknown>[] = []
			for await (const row of adapter.use(schema, { table: 'people' }).iterateMany(FilterGroup.create())) {
				rows.push(row)
				break
			}

			expect(rows).toEqual([{ id: 'u1' }])
			expect(cursor.close).toHaveBeenCalledTimes(1)
			expect(release).toHaveBeenCalledTimes(1)
		})

		test('iterateMany closes cursor and releases dedicated client when the consumer throws', async () => {
			const { Schema } = await import('../../schema.js')
			const { FilterGroup } = await import('../../filter.js')

			const schema = Schema.from('pg_iter_throw')
				.pk('id', v.string(), () => 'x')
				.build()
			const adapter = PostgresAdapter.create(testConnectionConfig)
			const release = vi.fn()
			const cursor = {
				read: vi.fn().mockResolvedValueOnce([{ id: 'u1' }]),
				close: vi.fn().mockResolvedValue(undefined),
			}
			;(adapter.pool as any).connect = vi.fn(async () => ({
				query: vi.fn(() => cursor),
				release,
			}))
			const consumerError = new Error('consumer failed')

			await expect(async () => {
				for await (const _row of adapter.use(schema, { table: 'people' }).iterateMany(FilterGroup.create())) {
					throw consumerError
				}
			}).rejects.toThrow(consumerError)

			expect(cursor.close).toHaveBeenCalledTimes(1)
			expect(release).toHaveBeenCalledTimes(1)
		})

		test('iterateMany inside a session uses the active client and leaves release ownership to session', async () => {
			const { Schema } = await import('../../schema.js')
			const { FilterGroup } = await import('../../filter.js')

			const schema = Schema.from('pg_iter_session')
				.pk('id', v.string(), () => 'x')
				.build()
			const adapter = PostgresAdapter.create(testConnectionConfig)
			const events: string[] = []
			const release = vi.fn(() => events.push('release'))
			const cursor = {
				read: vi
					.fn()
					.mockResolvedValueOnce([{ id: 'u1' }])
					.mockResolvedValueOnce([]),
				close: vi.fn(async () => events.push('cursor.close')),
			}
			const client = {
				query: vi.fn((query: string | Cursor<Record<string, unknown>>) => {
					if (typeof query === 'string') {
						events.push(query)
						return { rows: [] }
					}
					events.push('cursor.open')
					return cursor
				}),
				release,
			}
			;(adapter.pool as any).connect = vi.fn(async () => client)

			const rows: Record<string, unknown>[] = []
			await adapter.session(async () => {
				for await (const row of adapter
					.use(schema, { table: 'people' })
					.iterateMany(FilterGroup.create(), { batchSize: 1 })) {
					rows.push(row)
				}
				events.push('session.body.done')
			})

			expect((adapter.pool as any).connect).toHaveBeenCalledTimes(1)
			expect(rows).toEqual([{ id: 'u1' }])
			expect(events).toEqual(['BEGIN', 'cursor.open', 'cursor.close', 'session.body.done', 'COMMIT', 'release'])
			expect(release).toHaveBeenCalledTimes(1)
		})

		test('session method is exposed on the adapter', () => {
			const adapter = PostgresAdapter.create(testConnectionConfig)
			expect(adapter.session).toBeDefined()
			expect(adapter.session).toBeTypeOf('function')
		})

		test('declares aggregateOps with all six canonical ops', () => {
			const adapter = PostgresAdapter.create(testConnectionConfig)
			expect(adapter.aggregateOps).toEqual(['count', 'countDistinct', 'sum', 'avg', 'min', 'max'])
		})

		test('type-level: aggregateOps is a readonly tuple of all six ops', () => {
			const _adapter = PostgresAdapter.create(testConnectionConfig)
			type AggOps = typeof _adapter.aggregateOps
			expectTypeOf<AggOps>().toEqualTypeOf<readonly ['count', 'countDistinct', 'sum', 'avg', 'min', 'max']>()
		})

		test('aggregate method forwards spec to pool.query and returns mapped rows', async () => {
			const { Schema } = await import('../../schema.js')

			const schema = Schema.from('pg_agg')
				.pk('id', v.string(), () => 'x')
				.field('amount', v.number())
				.field('region', v.string())
				.build()
			const adapter = PostgresAdapter.create(testConnectionConfig)
			let capturedSql: unknown
			let capturedParams: unknown
			;(adapter.pool as any).query = async (sql: unknown, params: unknown) => {
				capturedSql = sql
				capturedParams = params
				return { rows: [{ total: '5' }] }
			}
			const result = await adapter.aggregate(
				schema,
				{ table: 'orders' },
				{
					aggregates: [{ fn: 'count', alias: 'total' }],
					groupBy: [],
				},
			)
			expect(capturedSql).toBe('SELECT COUNT(*) AS "total" FROM "orders"')
			expect(capturedParams).toEqual([])
			expect(result).toEqual([{ total: 5 }])
		})

		test('aggregate converts PG bigint/numeric strings to numbers for count/sum/avg', async () => {
			const { Schema } = await import('../../schema.js')

			const schema = Schema.from('pg_agg_types')
				.pk('id', v.string(), () => 'x')
				.field('amount', v.number())
				.build()
			const adapter = PostgresAdapter.create(testConnectionConfig)
			;(adapter.pool as any).query = async () => ({
				rows: [{ cnt: '10', revenue: '250.50', avgAmt: '25.05' }],
			})
			const result = await adapter.aggregate(
				schema,
				{ table: 'orders' },
				{
					aggregates: [
						{ fn: 'count', alias: 'cnt' },
						{ fn: 'sum', field: 'amount', alias: 'revenue' },
						{ fn: 'avg', field: 'amount', alias: 'avgAmt' },
					],
					groupBy: [],
				},
			)
			expect(result[0].cnt).toBe(10)
			expect(result[0].revenue).toBe(250.5)
			expect(result[0].avgAmt).toBe(25.05)
		})

		test('aggregate preserves original type for min/max', async () => {
			const { Schema } = await import('../../schema.js')

			const schema = Schema.from('pg_agg_minmax')
				.pk('id', v.string(), () => 'x')
				.field('name', v.string())
				.build()
			const adapter = PostgresAdapter.create(testConnectionConfig)
			;(adapter.pool as any).query = async () => ({
				rows: [{ lowest: 'Alice', highest: 'Zara' }],
			})
			const result = await adapter.aggregate(
				schema,
				{ table: 'users' },
				{
					aggregates: [
						{ fn: 'min', field: 'name', alias: 'lowest' },
						{ fn: 'max', field: 'name', alias: 'highest' },
					],
					groupBy: [],
				},
			)
			expect(result[0].lowest).toBe('Alice')
			expect(result[0].highest).toBe('Zara')
		})

		test('aggregate includes groupBy fields in result rows', async () => {
			const { Schema } = await import('../../schema.js')

			const schema = Schema.from('pg_agg_group')
				.pk('id', v.string(), () => 'x')
				.field('region', v.string())
				.build()
			const adapter = PostgresAdapter.create(testConnectionConfig)
			;(adapter.pool as any).query = async () => ({
				rows: [
					{ cnt: '3', region: 'US' },
					{ cnt: '2', region: 'EU' },
				],
			})
			const result = await adapter.aggregate(
				schema,
				{ table: 'orders' },
				{
					aggregates: [{ fn: 'count', alias: 'cnt' }],
					groupBy: ['region'],
				},
			)
			expect(result).toEqual([
				{ cnt: 3, region: 'US' },
				{ cnt: 2, region: 'EU' },
			])
		})

		test('type-level: Repo.from with PostgresAdapter enables aggregate method', async () => {
			const { Repo } = await import('../../repo/repo.js')
			const { Schema } = await import('../../schema.js')

			const adapter = PostgresAdapter.create(testConnectionConfig)
			const repo = Repo.from(adapter)
				.resolve(() => ({ table: 'test', schema: undefined }))
				.build()
			const _TestSchema = Schema.from('test')
				.pk('id', v.string(), () => 'x')
				.build()

			const _ref = repo.on(_TestSchema)
			expectTypeOf(_ref.aggregate).toBeFunction()
		})
	})

	describe('PostgresAdapter: migration methods', () => {
		let onSpy: ReturnType<typeof vi.spyOn>
		let adapter: PostgresAdapter
		let queries: { sql: string; params?: unknown[] }[]

		beforeEach(async () => {
			const { Instance } = await import('../../../instance/index.js')
			onSpy = vi.spyOn(Instance, 'on').mockImplementation(() => {})
			adapter = PostgresAdapter.create(testConnectionConfig)
			queries = []
			;(adapter.pool as any).query = async (sql: string, params?: unknown[]) => {
				queries.push({ sql, params })
				return { rows: [] }
			}
		})

		afterEach(() => {
			onSpy.mockRestore()
		})

		test('loadMigrations creates tracker table then selects rows', async () => {
			;(adapter.pool as any).query = async (sql: string, params?: unknown[]) => {
				queries.push({ sql, params })
				if (sql.includes('SELECT id')) {
					return { rows: [{ id: '0001', applied_at: '1700000000000' }] }
				}
				return { rows: [] }
			}
			const result = await adapter.loadMigrations()
			expect(queries).toHaveLength(2)
			expect(queries[0].sql).toContain('CREATE TABLE IF NOT EXISTS')
			expect(queries[0].sql).toContain('equipped_migrations')
			expect(queries[1].sql).toContain('SELECT id, applied_at')
			expect(result).toEqual([{ id: '0001', appliedAt: 1700000000000 }])
		})

		test('recordMigration inserts into tracker table', async () => {
			await adapter.recordMigration('0001-init', 1700000000000)
			expect(queries).toHaveLength(1)
			expect(queries[0].sql).toContain('INSERT INTO')
			expect(queries[0].sql).toContain('equipped_migrations')
			expect(queries[0].params).toEqual(['0001-init', 1700000000000])
		})

		test('acquireMigrationLock wraps fn with pg_advisory_lock/unlock', async () => {
			const result = await adapter.acquireMigrationLock(async () => {
				queries.push({ sql: 'USER_FN' })
				return 42
			})
			expect(result).toBe(42)
			expect(queries[0].sql).toContain('pg_advisory_lock')
			expect(queries[1].sql).toBe('USER_FN')
			expect(queries[2].sql).toContain('pg_advisory_unlock')
		})

		test('acquireMigrationLock unlocks even on error', async () => {
			await expect(
				adapter.acquireMigrationLock(async () => {
					throw new Error('boom')
				}),
			).rejects.toThrow('boom')
			expect(queries[0].sql).toContain('pg_advisory_lock')
			expect(queries[1].sql).toContain('pg_advisory_unlock')
		})

		test('applyCreateTable generates correct DDL', async () => {
			await adapter.applyCreateTable({
				kind: 'createTable',
				name: 'users',
				pk: { name: 'id', type: 'string' },
				fields: [
					{ name: 'email', type: 'string', unique: true },
					{ name: 'age', type: 'number', nullable: true },
					{ name: 'active', type: 'boolean', default: true },
				],
			})
			expect(queries).toHaveLength(1)
			const sql = queries[0].sql
			expect(sql).toContain('CREATE TABLE "users"')
			expect(sql).toContain('"id" text PRIMARY KEY')
			expect(sql).toContain('"email" text NOT NULL UNIQUE')
			expect(sql).toContain('"age" double precision')
			expect(sql).not.toContain('"age" double precision NOT NULL')
			expect(sql).toContain('"active" boolean NOT NULL DEFAULT TRUE')
		})

		test('applyDropTable generates DROP TABLE', async () => {
			await adapter.applyDropTable({ kind: 'dropTable', name: 'users' })
			expect(queries[0].sql).toBe('DROP TABLE "users"')
		})

		test('applyAddField generates ALTER TABLE ADD COLUMN', async () => {
			await adapter.applyAddField({
				kind: 'addField',
				table: 'users',
				field: { name: 'bio', type: 'string', nullable: true, default: 'none' },
			})
			expect(queries[0].sql).toContain('ALTER TABLE "users" ADD COLUMN')
			expect(queries[0].sql).toContain('"bio" text')
			expect(queries[0].sql).not.toContain('NOT NULL')
			expect(queries[0].sql).toContain("DEFAULT 'none'")
		})

		test('applyDropField generates ALTER TABLE DROP COLUMN', async () => {
			await adapter.applyDropField({ kind: 'dropField', table: 'users', name: 'bio' })
			expect(queries[0].sql).toBe('ALTER TABLE "users" DROP COLUMN "bio"')
		})

		test('applyModifyField generates ALTER COLUMN statements for type, nullable, default', async () => {
			await adapter.applyModifyField({
				kind: 'modifyField',
				table: 'users',
				name: 'age',
				to: { name: 'age', type: 'string', nullable: true, default: null },
			})
			expect(queries[0].sql).toContain('ALTER COLUMN "age" TYPE text')
			expect(queries[1].sql).toContain('DROP NOT NULL')
			expect(queries[2].sql).toContain('SET DEFAULT NULL')
		})

		test('applyModifyField renames column when to.name differs', async () => {
			await adapter.applyModifyField({
				kind: 'modifyField',
				table: 'users',
				name: 'age',
				to: { name: 'years', type: 'number' },
			})
			const renameSql = queries.find((q) => q.sql.includes('RENAME COLUMN'))
			expect(renameSql).toBeDefined()
			expect(renameSql!.sql).toContain('RENAME COLUMN "age" TO "years"')
		})

		test('applyRenameTable generates ALTER TABLE RENAME', async () => {
			await adapter.applyRenameTable({ kind: 'renameTable', from: 'users', to: 'accounts' })
			expect(queries[0].sql).toBe('ALTER TABLE "users" RENAME TO "accounts"')
		})

		test('applyRenameField generates ALTER TABLE RENAME COLUMN', async () => {
			await adapter.applyRenameField({ kind: 'renameField', table: 'users', from: 'name', to: 'fullName' })
			expect(queries[0].sql).toBe('ALTER TABLE "users" RENAME COLUMN "name" TO "fullName"')
		})

		test('applyAddIndex generates CREATE INDEX with auto-derived name', async () => {
			await adapter.applyAddIndex({ kind: 'addIndex', table: 'users', on: ['email'] })
			expect(queries[0].sql).toBe('CREATE INDEX "idx_users_email" ON "users" ("email")')
		})

		test('applyAddIndex generates CREATE UNIQUE INDEX with explicit name', async () => {
			await adapter.applyAddIndex({
				kind: 'addIndex',
				table: 'users',
				on: ['email'],
				unique: true,
				name: 'my_idx',
			})
			expect(queries[0].sql).toBe('CREATE UNIQUE INDEX "my_idx" ON "users" ("email")')
		})

		test('applyAddIndex auto-derives unique suffix when unique and no name', async () => {
			await adapter.applyAddIndex({ kind: 'addIndex', table: 'posts', on: ['author', 'title'], unique: true })
			expect(queries[0].sql).toBe(
				'CREATE UNIQUE INDEX "idx_posts_author_title_unique" ON "posts" ("author", "title")',
			)
		})

		test('applyDropIndex generates DROP INDEX', async () => {
			await adapter.applyDropIndex({ kind: 'dropIndex', name: 'idx_users_email' })
			expect(queries[0].sql).toBe('DROP INDEX "idx_users_email"')
		})

		test('applyAddForeignKey generates ALTER TABLE ADD CONSTRAINT with auto-derived name', async () => {
			await adapter.applyAddForeignKey({
				kind: 'addForeignKey',
				table: 'posts',
				on: 'authorId',
				references: { table: 'users', column: 'id' },
				onDelete: 'cascade',
				onUpdate: 'setNull',
			})
			const sql = queries[0].sql
			expect(sql).toContain('ALTER TABLE "posts" ADD CONSTRAINT "fk_posts_authorId"')
			expect(sql).toContain('FOREIGN KEY ("authorId") REFERENCES "users" ("id")')
			expect(sql).toContain('ON DELETE CASCADE')
			expect(sql).toContain('ON UPDATE SET NULL')
		})

		test('applyAddForeignKey uses explicit name when provided', async () => {
			await adapter.applyAddForeignKey({
				kind: 'addForeignKey',
				table: 'posts',
				on: 'authorId',
				references: { table: 'users', column: 'id' },
				name: 'custom_fk',
			})
			expect(queries[0].sql).toContain('ADD CONSTRAINT "custom_fk"')
		})

		test('applyDropForeignKey generates ALTER TABLE DROP CONSTRAINT', async () => {
			await adapter.applyDropForeignKey({ kind: 'dropForeignKey', table: 'posts', name: 'fk_posts_authorId' })
			expect(queries[0].sql).toBe('ALTER TABLE "posts" DROP CONSTRAINT "fk_posts_authorId"')
		})

		test('introspect queries information_schema and builds DiscoveredSchema[]', async () => {
			;(adapter.pool as any).query = async (sql: string, params?: unknown[]) => {
				queries.push({ sql, params })
				if (sql.includes('information_schema.tables')) {
					return { rows: [{ table_name: 'users' }] }
				}
				if (sql.includes('information_schema.columns')) {
					return {
						rows: [
							{ column_name: 'id', data_type: 'text', is_nullable: 'NO', column_default: null },
							{
								column_name: 'email',
								data_type: 'character varying',
								is_nullable: 'NO',
								column_default: null,
							},
							{ column_name: 'age', data_type: 'integer', is_nullable: 'YES', column_default: '25' },
						],
					}
				}
				if (sql.includes('PRIMARY KEY')) {
					return { rows: [{ column_name: 'id' }] }
				}
				if (sql.includes("constraint_type = 'UNIQUE'")) {
					return { rows: [{ column_name: 'email' }] }
				}
				if (sql.includes('pg_indexes')) {
					return {
						rows: [
							{
								indexname: 'users_email_idx',
								indexdef: 'CREATE UNIQUE INDEX users_email_idx ON public.users USING btree (email)',
							},
						],
					}
				}
				if (sql.includes("constraint_type = 'FOREIGN KEY'")) {
					return { rows: [] }
				}
				return { rows: [] }
			}
			const schemas = await adapter.introspect()
			expect(schemas).toHaveLength(1)
			const s = schemas[0]
			expect(s.name).toBe('users')
			expect(s.pk).toEqual({ name: 'id', type: 'string' })
			expect(s.fields).toEqual([
				{ name: 'email', type: 'string', nullable: false, unique: true },
				{ name: 'age', type: 'number', nullable: true, default: 25 },
			])
			expect(s.indexes).toEqual([{ name: 'users_email_idx', on: ['email'], unique: true }])
			expect(s.foreignKeys).toEqual([])
		})

		test('introspect throws OrmIntrospectionError on unsupported PG type', async () => {
			const { OrmIntrospectionError } = await import('../../errors/introspection.js')
			;(adapter.pool as any).query = async (sql: string) => {
				if (sql.includes('information_schema.tables')) {
					return { rows: [{ table_name: 'files' }] }
				}
				if (sql.includes('information_schema.columns')) {
					return {
						rows: [
							{ column_name: 'id', data_type: 'text', is_nullable: 'NO', column_default: null },
							{ column_name: 'data', data_type: 'bytea', is_nullable: 'YES', column_default: null },
						],
					}
				}
				if (sql.includes('PRIMARY KEY')) {
					return { rows: [{ column_name: 'id' }] }
				}
				if (sql.includes("constraint_type = 'UNIQUE'")) {
					return { rows: [] }
				}
				return { rows: [] }
			}
			await expect(adapter.introspect()).rejects.toThrow(OrmIntrospectionError)
			try {
				await adapter.introspect()
			} catch (err: any) {
				expect(err.adapter).toBe('postgresql')
				expect(err.table).toBe('files')
				expect(err.cause).toContain('bytea')
			}
		})

		test('introspect parses foreign keys with cascade actions', async () => {
			;(adapter.pool as any).query = async (sql: string) => {
				if (sql.includes('information_schema.tables')) {
					return { rows: [{ table_name: 'posts' }] }
				}
				if (sql.includes('information_schema.columns')) {
					return {
						rows: [
							{ column_name: 'id', data_type: 'text', is_nullable: 'NO', column_default: null },
							{ column_name: 'author_id', data_type: 'text', is_nullable: 'NO', column_default: null },
						],
					}
				}
				if (sql.includes('PRIMARY KEY')) {
					return { rows: [{ column_name: 'id' }] }
				}
				if (sql.includes("constraint_type = 'UNIQUE'")) {
					return { rows: [] }
				}
				if (sql.includes('pg_indexes')) {
					return { rows: [] }
				}
				if (sql.includes("constraint_type = 'FOREIGN KEY'")) {
					return {
						rows: [
							{
								constraint_name: 'fk_posts_author_id',
								column_name: 'author_id',
								foreign_table_name: 'users',
								foreign_column_name: 'id',
								delete_rule: 'CASCADE',
								update_rule: 'SET NULL',
							},
						],
					}
				}
				return { rows: [] }
			}
			const schemas = await adapter.introspect()
			expect(schemas[0].foreignKeys).toEqual([
				{
					name: 'fk_posts_author_id',
					on: 'author_id',
					references: { table: 'users', column: 'id' },
					onDelete: 'cascade',
					onUpdate: 'setNull',
				},
			])
		})

		test('introspect excludes tracker table from results', async () => {
			;(adapter.pool as any).query = async (sql: string, params?: unknown[]) => {
				if (sql.includes('information_schema.tables')) {
					expect(params).toContain('equipped_migrations')
					return { rows: [] }
				}
				return { rows: [] }
			}
			const schemas = await adapter.introspect()
			expect(schemas).toEqual([])
		})

		test('type-level: PostgresAdapter declares all migration methods', () => {
			expectTypeOf(adapter.loadMigrations).toBeFunction()
			expectTypeOf(adapter.recordMigration).toBeFunction()
			expectTypeOf(adapter.acquireMigrationLock).toBeFunction()
			expectTypeOf(adapter.applyCreateTable).toBeFunction()
			expectTypeOf(adapter.applyDropTable).toBeFunction()
			expectTypeOf(adapter.applyAddField).toBeFunction()
			expectTypeOf(adapter.applyDropField).toBeFunction()
			expectTypeOf(adapter.applyModifyField).toBeFunction()
			expectTypeOf(adapter.applyRenameTable).toBeFunction()
			expectTypeOf(adapter.applyRenameField).toBeFunction()
			expectTypeOf(adapter.applyAddIndex).toBeFunction()
			expectTypeOf(adapter.applyDropIndex).toBeFunction()
			expectTypeOf(adapter.applyAddForeignKey).toBeFunction()
			expectTypeOf(adapter.applyDropForeignKey).toBeFunction()
			expectTypeOf(adapter.introspect).toBeFunction()
		})

		test('type-level: Migrator.from rejects withoutLock for PostgresAdapter', async () => {
			const { Repo } = await import('../../repo/repo.js')
			const { Migrator } = await import('../../migrations/migrator.js')
			const repo = Repo.from(adapter)
				.resolve(() => ({ table: 'test', schema: undefined }))
				.build()
			const step = Migrator.from(repo, adapter).migrations([])
			expectTypeOf(step).toHaveProperty('build')
			expectTypeOf(step).not.toHaveProperty('withoutLock')
		})

		test('applyCreateTable maps all field types to correct PG types', async () => {
			await adapter.applyCreateTable({
				kind: 'createTable',
				name: 'all_types',
				pk: { name: 'id', type: 'string' },
				fields: [
					{ name: 'f_num', type: 'number' },
					{ name: 'f_bool', type: 'boolean' },
					{ name: 'f_date', type: 'date' },
					{ name: 'f_null', type: 'null' },
					{ name: 'f_obj', type: 'object' },
					{ name: 'f_arr', type: 'array' },
				],
			})
			const sql = queries[0].sql
			expect(sql).toContain('"f_num" double precision NOT NULL')
			expect(sql).toContain('"f_bool" boolean NOT NULL')
			expect(sql).toContain('"f_date" timestamptz NOT NULL')
			expect(sql).toContain('"f_null" text NOT NULL')
			expect(sql).toContain('"f_obj" jsonb NOT NULL')
			expect(sql).toContain('"f_arr" jsonb NOT NULL')
		})

		test('applyModifyField sets NOT NULL when nullable is falsy', async () => {
			await adapter.applyModifyField({
				kind: 'modifyField',
				table: 'users',
				name: 'email',
				to: { name: 'email', type: 'string' },
			})
			expect(queries[1].sql).toContain('SET NOT NULL')
		})

		test('applyModifyField drops default when to.default is undefined', async () => {
			await adapter.applyModifyField({
				kind: 'modifyField',
				table: 'users',
				name: 'age',
				to: { name: 'age', type: 'number' },
			})
			expect(queries[2].sql).toContain('DROP DEFAULT')
		})

		test('applyAddField with string default escapes single quotes', async () => {
			await adapter.applyAddField({
				kind: 'addField',
				table: 'users',
				field: { name: 'bio', type: 'string', default: "it's" },
			})
			expect(queries[0].sql).toContain("DEFAULT 'it''s'")
		})

		test('end-to-end: Migrator.from(repo, adapter) wires up correctly', async () => {
			const { Repo } = await import('../../repo/repo.js')
			const { Migrator } = await import('../../migrations/migrator.js')
			const { Schema } = await import('../../schema.js')

			Schema.from('users')
				.pk('id', v.string(), () => 'x')
				.field('email', v.string())
				.build()
			const repo = Repo.from(adapter)
				.resolve(() => ({ table: 'test', schema: undefined }))
				.build()

			let loadCalls = 0
			const mockClient = {
				query: async (sql: string, _params?: unknown[]) => {
					if (sql.includes('pg_advisory_lock') || sql.includes('pg_advisory_unlock')) return { rows: [] }
					if (sql.includes('CREATE TABLE IF NOT EXISTS')) return { rows: [] }
					if (sql.includes('SELECT id, applied_at')) {
						loadCalls++
						return { rows: [] }
					}
					if (sql.includes('INSERT INTO')) return { rows: [] }
					if (sql.includes('CREATE TABLE')) return { rows: [] }
					if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
					return { rows: [] }
				},
				release: () => {},
			}
			;(adapter.pool as any).query = mockClient.query
			;(adapter.pool as any).connect = async () => mockClient

			const migrator = Migrator.from(repo, adapter)
				.migrations([
					{
						id: '0001',
						changes: [
							{
								kind: 'createTable',
								name: 'users',
								pk: { name: 'id', type: 'string' },
								fields: [{ name: 'email', type: 'string' }],
							},
						],
					},
				])
				.build()

			const result = await migrator.up()
			expect(result.ran).toEqual(['0001'])
			expect(loadCalls).toBe(1)
		})
	})
}
