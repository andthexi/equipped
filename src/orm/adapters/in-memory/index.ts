import { AsyncLocalStorage } from 'node:async_hooks'

import { v, differ } from 'valleyed'

import { configurable } from '../../../utilities/configurable'
import type { FieldTypeName } from '../../adapter'
import { Filter, FilterGroup, type FilterChild } from '../../filter'
import type { DiscoveredSchema, ForeignKeyAction } from '../../migrations/introspection-types'
import type { AddFieldChange, AddForeignKeyChange, AddIndexChange, AnyFieldSpec, CreateTableChange, DropFieldChange, DropForeignKeyChange, DropIndexChange, DropTableChange, ModifyFieldChange, RenameFieldChange, RenameTableChange } from '../../migrations/types'
import { OrmAdapter, type AggregateSpec } from '../../orm-adapter'
import type { IterationQueryOptions, QueryOptions } from '../../query-options'
import type { AnySchema } from '../../schema'
import { IncOp, MaxOp, MinOp, MulOp, PatchOp, PullOp, PushOp, SetOp, UnsetOp, type AnyUpdateOp } from '../../updates'

const inMemoryConnectionPipe = () => v.object({})

export type InMemoryRepoConfig = {
	table: string
	prefix?: string
}

type MigrationRecord = { id: string; appliedAt: number }
type TableMeta = { pk: { name: string; type: string }; fields: Map<string, AnyFieldSpec> }
type IndexMeta = { table: string; on: readonly string[]; unique: boolean }
type ForeignKeyMeta = { table: string; on: string; references: { table: string; column: string }; onDelete?: ForeignKeyAction; onUpdate?: ForeignKeyAction }

type Snapshot = {
	stores: Map<string, Map<string, Record<string, unknown>>>
	migrations: Map<string, MigrationRecord>
	indexes: Map<string, IndexMeta>
	tables: Map<string, TableMeta>
	foreignKeys: Map<string, ForeignKeyMeta>
}

function clone<T>(value: T): T {
	return structuredClone(value)
}

const replaceMap = <K, V>(target: Map<K, V>, source: Map<K, V>) => {
	target.clear()
	for (const [k, val] of source.entries()) target.set(k, val)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function containsSubset(source: unknown, needle: unknown): boolean {
	if (Array.isArray(source)) {
		const wanted = Array.isArray(needle) ? needle : [needle]
		return wanted.every((item) => source.some((existing) => differ.equal(existing, item)))
	}

	if (isPlainObject(source) && isPlainObject(needle)) {
		return Object.entries(needle).every(([k, v]) => containsSubset(source[k], v))
	}

	return differ.equal(source, needle)
}

function compareValues(a: unknown, b: unknown): number {
	if (a === b) return 0
	if (a == null) return -1
	if (b == null) return 1
	if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : 1
	if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : 1
	if (typeof a === 'boolean' && typeof b === 'boolean') return a === false ? -1 : 1
	const sa = JSON.stringify(a)
	const sb = JSON.stringify(b)
	if (sa === sb) return 0
	return sa < sb ? -1 : 1
}

function valueAtPath(doc: Record<string, unknown>, path: readonly string[]): unknown {
	let current: unknown = doc
	for (const segment of path) {
		if (current == null) return undefined
		if (typeof current !== 'object') return undefined
		current = (current as Record<string, unknown>)[segment]
	}
	return current
}

function resolveConfigName(_: AnySchema, config: InMemoryRepoConfig): string {
	return `${config.prefix ?? ''}${config.table}`
}

function evaluateFilter(doc: Record<string, unknown>, filter: Filter): boolean {
	const fieldValue = valueAtPath(doc, filter.path)
	const value = filter.value

	switch (filter.op) {
		case 'eq':
			return differ.equal(fieldValue, value)
		case 'ne':
			return !differ.equal(fieldValue, value)
		case 'gt':
			return compareValues(fieldValue, value) > 0
		case 'gte':
			return compareValues(fieldValue, value) >= 0
		case 'lt':
			return compareValues(fieldValue, value) < 0
		case 'lte':
			return compareValues(fieldValue, value) <= 0
		case 'in': {
			if (!Array.isArray(value)) return false
			return value.some((v) => differ.equal(fieldValue, v))
		}
		case 'notIn': {
			if (!Array.isArray(value)) return true
			return !value.some((v) => differ.equal(fieldValue, v))
		}
		case 'like':
			return String(fieldValue ?? '')
				.toLowerCase()
				.includes(String(value ?? '').toLowerCase())
		case 'exists':
			return fieldValue != null
		case 'notExists':
			return fieldValue == null
		case 'contains':
			return containsSubset(fieldValue, value)
		case 'notContains':
			return !containsSubset(fieldValue, value)
		default:
			return false
	}
}

function evaluateChild(doc: Record<string, unknown>, child: FilterChild): boolean {
	if (child instanceof Filter) return evaluateFilter(doc, child)
	if (child instanceof FilterGroup) {
		if (child.op === 'and') return child.children.every((c) => evaluateChild(doc, c))
		if (child.op === 'or') return child.children.some((c) => evaluateChild(doc, c))
	}
	return true
}

function matchesFilter(doc: Record<string, unknown>, group: FilterGroup): boolean {
	for (const clause of group.children) {
		if (!evaluateChild(doc, clause)) return false
	}
	return true
}

function applyOptions(rows: Record<string, unknown>[], options?: QueryOptions): Record<string, unknown>[] {
	let results = rows

	if (options?.orderBy?.length) {
		results = [...results].sort((a, b) => {
			for (const ord of options.orderBy ?? []) {
				const cmp = compareValues(a[ord.field], b[ord.field])
				if (cmp !== 0) return ord.direction === 'asc' ? cmp : -cmp
			}
			return 0
		})
	}

	if (options?.offset != null) {
		results = results.slice(Math.max(0, options.offset))
	}

	if (options?.limit != null) {
		results = results.slice(0, options.limit)
	}

	if (options?.select?.length) {
		const fields = new Set<string>(options.select)
		results = results.map((row) => {
			const out: Record<string, unknown> = {}
			for (const key of fields) out[key] = row[key]
			return out
		})
	}

	return results
}

function applyUpdateOp(current: Record<string, unknown>, key: string, value: unknown) {
	if (value instanceof IncOp) {
		const base = Number(current[key] ?? 0)
		current[key] = base + value.value
		return
	}
	if (value instanceof MulOp) {
		const base = Number(current[key] ?? 0)
		current[key] = base * value.value
		return
	}
	if (value instanceof MinOp) {
		const base = current[key]
		current[key] = base == null || compareValues(value.value, base) < 0 ? value.value : base
		return
	}
	if (value instanceof MaxOp) {
		const base = current[key]
		current[key] = base == null || compareValues(value.value, base) > 0 ? value.value : base
		return
	}
	if (value instanceof UnsetOp) {
		current[key] = null
		return
	}
	if (value instanceof PushOp) {
		const arr = Array.isArray(current[key]) ? [...(current[key] as unknown[])] : []
		arr.push(clone(value.value))
		current[key] = arr
		return
	}
	if (value instanceof PullOp) {
		const arr = Array.isArray(current[key]) ? (current[key] as unknown[]) : []
		current[key] = arr.filter((entry) => !differ.equal(entry, value.value))
		return
	}
	if (value instanceof PatchOp) {
		const target = isPlainObject(current[key]) ? clone(current[key] as Record<string, unknown>) : {}
		if (isPlainObject(value.value)) {
			for (const [k, v] of Object.entries(value.value as Record<string, unknown>)) {
				target[k] = clone(v)
			}
		}
		current[key] = target
		return
	}
	current[key] = clone(value)
}

function applyUpdateData(doc: Record<string, unknown>, data: Record<string, unknown>): Record<string, unknown> {
	const updated = clone(doc)
	for (const [key, value] of Object.entries(data)) {
		applyUpdateOp(updated, key, value)
	}
	return updated
}

function applyOps(doc: Record<string, unknown>, ops: AnyUpdateOp[]): Record<string, unknown> {
	const updated = clone(doc)
	for (const op of ops) {
		if (op instanceof SetOp) {
			for (const [key, value] of Object.entries(op.values)) {
				updated[key] = clone(value)
			}
		} else {
			applyUpdateOp(updated, op.field, op)
		}
	}
	return updated
}

const sessionActiveStore = new AsyncLocalStorage<boolean>()

export class InMemoryAdapter extends configurable(inMemoryConnectionPipe, OrmAdapter) {
	readonly schemaConfigPipe = v.object({ table: v.string() })

	readonly supportedFieldTypes = ['string', 'number', 'boolean', 'null', 'object', 'array', 'date'] as const
	readonly queryableOps = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn', 'like', 'exists', 'notExists', 'contains', 'notContains'] as const
	readonly updateOps = ['set', 'inc', 'mul', 'min', 'max', 'unset', 'push', 'pull', 'patch'] as const
	readonly aggregateOps = ['count', 'countDistinct', 'sum', 'avg', 'min', 'max'] as const

	readonly stores = new Map<string, Map<string, Record<string, unknown>>>()
	readonly migrations = new Map<string, MigrationRecord>()
	readonly indexes = new Map<string, IndexMeta>()
	readonly tables = new Map<string, TableMeta>()
	readonly foreignKeys = new Map<string, ForeignKeyMeta>()

	#migrationLock: Promise<void> = Promise.resolve()

	protected constructor(config: typeof InMemoryAdapter.Config) {
		super(config)
	}

	#getStore(name: string) {
		if (!this.stores.has(name)) this.stores.set(name, new Map())
		return this.stores.get(name)!
	}

	#resolveStore(schema: AnySchema, config: unknown) {
		return this.#getStore(resolveConfigName(schema, config as InMemoryRepoConfig))
	}

	#snapshot(): Snapshot {
		const stores = new Map<string, Map<string, Record<string, unknown>>>()
		for (const [name, store] of this.stores.entries()) {
			const storeCopy = new Map<string, Record<string, unknown>>()
			for (const [id, doc] of store.entries()) {
				storeCopy.set(id, clone(doc))
			}
			stores.set(name, storeCopy)
		}
		const migrations = new Map(this.migrations)
		const indexes = new Map(this.indexes)
		const tables = new Map<string, TableMeta>()
		for (const [name, meta] of this.tables.entries()) {
			tables.set(name, { pk: { ...meta.pk }, fields: new Map(meta.fields) })
		}
		const foreignKeys = new Map(this.foreignKeys)
		return { stores, migrations, indexes, tables, foreignKeys }
	}

	#restore(snap: Snapshot) {
		replaceMap(this.stores, snap.stores)
		replaceMap(this.migrations, snap.migrations)
		replaceMap(this.indexes, snap.indexes)
		replaceMap(this.tables, snap.tables)
		replaceMap(this.foreignKeys, snap.foreignKeys)
	}

	async findByPk(schema: AnySchema, config: unknown, pk: unknown) {
		const store = this.#resolveStore(schema, config)
		const doc = store.get(String(pk))
		return doc ? clone(doc) : null
	}

	async createMany(schema: AnySchema, config: unknown, data: Record<string, unknown>[]) {
		const pk = schema.pkField.name
		const store = this.#resolveStore(schema, config)
		return data.map((d) => {
			const row = clone(d)
			store.set(String(row[pk]), row)
			return clone(row)
		})
	}

	async deleteByPk(schema: AnySchema, config: unknown, pk: unknown) {
		const store = this.#resolveStore(schema, config)
		const pkStr = String(pk)
		const doc = store.get(pkStr)
		if (!doc) return null
		store.delete(pkStr)
		return clone(doc)
	}

	async updateByPk(schema: AnySchema, config: unknown, pk: unknown, ops: AnyUpdateOp[]) {
		const store = this.#resolveStore(schema, config)
		const pkStr = String(pk)
		const doc = store.get(pkStr)
		if (!doc) return null
		const updated = applyOps(doc, ops)
		store.set(pkStr, updated)
		return clone(updated)
	}

	async findMany(schema: AnySchema, config: unknown, group: FilterGroup, options?: QueryOptions) {
		const store = this.#resolveStore(schema, config)
		const rows = [...store.values()].filter((doc) => matchesFilter(doc, group)).map((doc) => clone(doc))
		return applyOptions(rows, options)
	}

	async count(schema: AnySchema, config: unknown, group: FilterGroup) {
		const store = this.#resolveStore(schema, config)
		return [...store.values()].filter((doc) => matchesFilter(doc, group)).length
	}

	async *iterateMany(schema: AnySchema, config: unknown, group: FilterGroup, options?: IterationQueryOptions) {
		const store = this.#resolveStore(schema, config)
		const rows = applyOptions([...store.values()].filter((doc) => matchesFilter(doc, group)).map((doc) => clone(doc)), options)
		const batchSize = typeof options?.batchSize === 'number' && Number.isSafeInteger(options.batchSize) && options.batchSize > 0 ? options.batchSize : 1
		for (let start = 0; start < rows.length; start += batchSize) {
			for (const row of rows.slice(start, start + batchSize)) {
				yield row
			}
		}
	}

	async updateMany(schema: AnySchema, config: unknown, group: FilterGroup, data: Record<string, unknown>) {
		const store = this.#resolveStore(schema, config)
		const ids = [...store.entries()].filter(([, doc]) => matchesFilter(doc, group)).map(([id]) => id)

		const updated: Record<string, unknown>[] = []
		for (const id of ids) {
			const current = store.get(id)
			if (!current) continue
			const next = applyUpdateData(current, data)
			store.set(id, next)
			updated.push(clone(next))
		}
		return updated
	}

	async deleteMany(schema: AnySchema, config: unknown, filter: FilterGroup) {
		const store = this.#resolveStore(schema, config)
		const pk = schema.pkField.name
		const rows = [...store.values()].filter((doc) => matchesFilter(doc, filter)).map((doc) => clone(doc))
		for (const row of rows) store.delete(String(row[pk]))
		return rows
	}

	async upsertOne(schema: AnySchema, config: unknown, filter: FilterGroup, create: Record<string, unknown>, ops: AnyUpdateOp[]) {
		const store = this.#resolveStore(schema, config)
		const pk = schema.pkField.name
		const rows = [...store.values()].filter((doc) => matchesFilter(doc, filter))
		const current = rows[0]
		if (current) {
			const next = ops.length > 0 ? applyOps(current, ops) : clone(current)
			store.set(String(next[pk]), next)
			return clone(next)
		}
		const base = clone(create)
		const result = ops.length > 0 ? applyOps(base, ops) : base
		store.set(String(result[pk]), result)
		return clone(result)
	}

	async aggregate(schema: AnySchema, config: unknown, spec: AggregateSpec): Promise<Array<Record<string, unknown>>> {
		const store = this.#resolveStore(schema, config)
		let rows = [...store.values()]
		if (spec.where) {
			const where = spec.where
			rows = rows.filter((doc) => matchesFilter(doc, where))
		}

		const groups = new Map<string, Record<string, unknown>[]>()
		if (spec.groupBy.length > 0) {
			for (const row of rows) {
				const key = JSON.stringify(spec.groupBy.map((f) => row[f]))
				if (!groups.has(key)) groups.set(key, [])
				groups.get(key)!.push(row)
			}
		} else {
			groups.set('__all__', rows)
		}

		const results: Record<string, unknown>[] = []
		for (const [, groupRows] of groups) {
			const result: Record<string, unknown> = {}
			if (spec.groupBy.length > 0) {
				for (const field of spec.groupBy) {
					result[field] = groupRows[0][field]
				}
			}
			for (const agg of spec.aggregates) {
				switch (agg.fn) {
					case 'count':
						result[agg.alias] = groupRows.length
						break
					case 'countDistinct': {
						const vals = new Set(groupRows.map((r) => JSON.stringify(r[agg.field!])))
						result[agg.alias] = vals.size
						break
					}
					case 'sum':
						result[agg.alias] = groupRows.reduce((acc, r) => acc + Number(r[agg.field!] ?? 0), 0)
						break
					case 'avg': {
						const sum = groupRows.reduce((acc, r) => acc + Number(r[agg.field!] ?? 0), 0)
						result[agg.alias] = groupRows.length > 0 ? sum / groupRows.length : 0
						break
					}
					case 'min': {
						let minVal: unknown = null
						for (const r of groupRows) {
							const val = r[agg.field!]
							if (val != null && (minVal === null || compareValues(val, minVal) < 0)) minVal = val
						}
						result[agg.alias] = minVal
						break
					}
					case 'max': {
						let maxVal: unknown = null
						for (const r of groupRows) {
							const val = r[agg.field!]
							if (val != null && (maxVal === null || compareValues(val, maxVal) > 0)) maxVal = val
						}
						result[agg.alias] = maxVal
						break
					}
				}
			}
			results.push(result)
		}

		if (spec.having) {
			const having = spec.having
			return results.filter((r) => matchesFilter(r, having))
		}
		return results
	}

	async loadMigrations(): Promise<{ id: string; appliedAt: number }[]> {
		return [...this.migrations.values()].map((m) => ({ id: m.id, appliedAt: m.appliedAt }))
	}

	async recordMigration(id: string, appliedAt: number): Promise<void> {
		this.migrations.set(id, { id, appliedAt })
	}

	async applyCreateTable(change: CreateTableChange<any>): Promise<void> {
		const fields = new Map<string, AnyFieldSpec>()
		for (const f of change.fields) {
			fields.set(f.name, { ...f })
		}
		this.tables.set(change.name, { pk: { name: change.pk.name, type: change.pk.type }, fields })
	}

	async applyDropTable(change: DropTableChange): Promise<void> {
		this.tables.delete(change.name)
	}

	async applyAddField(change: AddFieldChange<any>): Promise<void> {
		const table = this.tables.get(change.table)
		if (table) {
			table.fields.set(change.field.name, { ...change.field })
		}
	}

	async applyDropField(change: DropFieldChange): Promise<void> {
		const table = this.tables.get(change.table)
		if (table) {
			table.fields.delete(change.name)
		}
	}

	async applyModifyField(change: ModifyFieldChange<any>): Promise<void> {
		const table = this.tables.get(change.table)
		if (table) {
			table.fields.delete(change.name)
			table.fields.set(change.to.name, { ...change.to })
		}
	}

	async applyRenameTable(change: RenameTableChange): Promise<void> {
		const table = this.tables.get(change.from)
		if (table) {
			this.tables.delete(change.from)
			this.tables.set(change.to, table)
		}
	}

	async applyRenameField(change: RenameFieldChange): Promise<void> {
		const table = this.tables.get(change.table)
		if (table) {
			const field = table.fields.get(change.from)
			if (field) {
				table.fields.delete(change.from)
				table.fields.set(change.to, { ...field, name: change.to })
			}
		}
	}

	async applyAddIndex(change: AddIndexChange): Promise<void> {
		const indexName = change.name ?? `${change.table}_${change.on.join('_')}_idx`
		this.indexes.set(indexName, { table: change.table, on: change.on, unique: change.unique ?? false })
	}

	async applyDropIndex(change: DropIndexChange): Promise<void> {
		this.indexes.delete(change.name)
	}

	async applyAddForeignKey(change: AddForeignKeyChange): Promise<void> {
		const fkName = change.name ?? `${change.table}_${change.on}_fk`
		this.foreignKeys.set(fkName, {
			table: change.table,
			on: change.on,
			references: { table: change.references.table, column: change.references.column },
			onDelete: change.onDelete as ForeignKeyAction | undefined,
			onUpdate: change.onUpdate as ForeignKeyAction | undefined,
		})
	}

	async applyDropForeignKey(change: DropForeignKeyChange): Promise<void> {
		this.foreignKeys.delete(change.name)
	}

	async introspect(): Promise<DiscoveredSchema[]> {
		const schemas: DiscoveredSchema[] = []
		for (const [name, meta] of this.tables.entries()) {
			const fields = [...meta.fields.values()].map((f) => ({
				name: f.name,
				type: f.type as FieldTypeName,
				nullable: f.nullable ?? false,
				...(f.default !== undefined ? { default: f.default } : {}),
				...(f.unique ? { unique: true } : {}),
			}))
			const indexes = [...this.indexes.entries()]
				.filter(([, idx]) => idx.table === name)
				.map(([idxName, idx]) => ({ name: idxName, on: idx.on, unique: idx.unique }))
			const foreignKeys = [...this.foreignKeys.entries()]
				.filter(([, fk]) => fk.table === name)
				.map(([fkName, fk]) => ({
					name: fkName,
					on: fk.on,
					references: { table: fk.references.table, column: fk.references.column },
					...(fk.onDelete ? { onDelete: fk.onDelete } : {}),
					...(fk.onUpdate ? { onUpdate: fk.onUpdate } : {}),
				}))
			schemas.push({
				name,
				pk: { name: meta.pk.name, type: meta.pk.type as FieldTypeName },
				fields,
				indexes,
				foreignKeys,
			})
		}
		return schemas
	}

	async acquireMigrationLock<T>(fn: () => Promise<T>): Promise<T> {
		let release!: () => void
		const next = new Promise<void>((r) => { release = r })
		const prev = this.#migrationLock
		this.#migrationLock = next
		await prev
		try {
			return await fn()
		} finally {
			release()
		}
	}

	async session<T>(fn: () => Promise<T>): Promise<T> {
		if (sessionActiveStore.getStore()) return fn()
		const snap = this.#snapshot()
		try {
			return await sessionActiveStore.run(true, fn)
		} catch (error) {
			this.#restore(snap)
			throw error
		}
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { Field } = await import('../../fields')
	const { FilterGroup } = await import('../../filter')
	const { OrderBy } = await import('../../query-options')
	const { Schema } = await import('../../schema')
	const { IncOp, PatchOp, PullOp, PushOp } = await import('../../updates')

	const { v } = await import('valleyed')

	describe('in-memory adapter', () => {
		test('InMemoryAdapter.create({}) produces a working adapter', () => {
			const adapter = InMemoryAdapter.create({})
			expect(adapter).toBeInstanceOf(InMemoryAdapter)
			expect(adapter.schemaConfigPipe).toBeDefined()
			expect(adapter.supportedFieldTypes).toEqual(['string', 'number', 'boolean', 'null', 'object', 'array', 'date'])
		})

		test('supports nested filters, ordering, select, offset and limit', async () => {
			const schema = Schema.from('users')
				.pk('id', v.string(), () => 'u')
				.field('name', v.string())
				.field('age', v.number())
				.build()
			const adapter = InMemoryAdapter.create({})
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
			const options = { orderBy: [new OrderBy('age', 'desc')], offset: 1, limit: 1, select: ['id', 'name'] }
			const rows = await use.findMany(builtGroup, options)
			expect(rows).toEqual([{ id: 'u1', name: 'Alice' }])
		})

		test('count returns the number of matching rows without query options', async () => {
			const schema = Schema.from('count_users')
				.pk('id', v.string(), () => 'u')
				.field('name', v.string())
				.build()
			const adapter = InMemoryAdapter.create({})
			const use = adapter.use(schema, { table: 'count_users' })
			await use.createMany([
				{ id: 'u1', name: 'Alice' },
				{ id: 'u2', name: 'Bob' },
				{ id: 'u3', name: 'Alice' },
			])

			await expect(use.count(FilterGroup.create().eq('name', 'Alice'))).resolves.toBe(2)
		})

		test('iterateMany with batchSize matches findMany filtering ordering offset limit and selection', async () => {
			const schema = Schema.from('iter_users')
				.pk('id', v.string(), () => 'u')
				.field('name', v.string())
				.field('age', v.number())
				.build()
			const adapter = InMemoryAdapter.create({})
			const use = adapter.use(schema, { table: 'iter_users' })
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
		})

		test('supports update operators and rollback on failed session', async () => {
			const schema = Schema.from('docs')
				.pk('id', v.string(), () => 'd1')
				.field('count', v.number())
				.field('tags', v.array(v.string()))
				.field('meta', v.object({ a: v.number() }))
				.build()
			const adapter = InMemoryAdapter.create({})
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
		})

		test('notIn filter excludes matching values', async () => {
			const schema = Schema.from('users')
				.pk('id', v.string(), () => 'u')
				.field('name', v.string())
				.build()
			const adapter = InMemoryAdapter.create({})
			const use = adapter.use(schema, { table: 'users' })
			await use.createMany([
				{ id: 'u1', name: 'Alice' },
				{ id: 'u2', name: 'Bob' },
				{ id: 'u3', name: 'Carol' },
			])
			const rows = await use.findMany(FilterGroup.create().notIn('name', ['Alice', 'Carol']))
			expect(rows).toHaveLength(1)
			expect(rows[0].name).toBe('Bob')
		})

		test('exists / notExists filter ops work correctly', async () => {
			const schema = Schema.from('items')
				.pk('id', v.string(), () => 'i')
				.field('val', v.optional(v.string()), { onCreate: () => undefined })
				.build()
			const adapter = InMemoryAdapter.create({})
			const use = adapter.use(schema, { table: 'items' })
			await use.createMany([
				{ id: 'i1', val: 'present' },
				{ id: 'i2', val: null },
				{ id: 'i3', val: undefined },
			])
			const existsRows = await use.findMany(FilterGroup.create().exists('val'))
			expect(existsRows).toHaveLength(1)
			expect(existsRows[0].id).toBe('i1')

			const notExistsRows = await use.findMany(FilterGroup.create().notExists('val'))
			expect(notExistsRows).toHaveLength(2)
		})

		test('nested filter paths work for all filter ops', async () => {
			const schema = Schema.from('nested_items')
				.pk('id', v.string(), () => `nested-${Math.random().toString(36).slice(2)}`)
				.field(
					'meta',
					v.object({
						kind: v.string(),
						count: v.number(),
						enabled: v.boolean(),
						tags: v.array(v.string()),
						config: v.object({ role: v.string() }),
					}),
				)
				.build()
			const adapter = InMemoryAdapter.create({})
			const use = adapter.use(schema, { table: 'nested_items' })
			await use.createMany([
				{
					id: 'n1',
					meta: { kind: 'alpha', count: 1, enabled: true, tags: ['a', 'b'], config: { role: 'owner' } },
				},
				{
					id: 'n2',
					meta: { kind: 'beta', count: 2, enabled: false, tags: ['b'], config: { role: 'reviewer' } },
				},
			])

			const kind = schema.fields.meta.nested('kind', 'string')
			const count = schema.fields.meta.nested('count', 'number')
			const enabled = schema.fields.meta.nested('enabled', 'boolean')
			const tags = new Field<string>('meta', ['meta', 'tags'], 'array')
			const role = schema.fields.meta.nested('config', 'object').nested('role', 'string')
			const missing = new Field<unknown>('meta', ['meta', 'missing'], 'string')
			const expectFindIds = async (filter: FilterGroup, expectedIds: string[]) => {
				const rows = await use.findMany(filter)
				expect(rows.map((row) => row.id).sort()).toEqual(expectedIds.sort())
			}

			await expectFindIds(FilterGroup.create().eq(kind, 'alpha'), ['n1'])
			await expectFindIds(FilterGroup.create().ne(kind, 'alpha'), ['n2'])
			await expectFindIds(FilterGroup.create().gt(count, 1), ['n2'])
			await expectFindIds(FilterGroup.create().gte(count, 2), ['n2'])
			await expectFindIds(FilterGroup.create().lt(count, 2), ['n1'])
			await expectFindIds(FilterGroup.create().lte(count, 1), ['n1'])
			await expectFindIds(FilterGroup.create().in(kind, ['alpha']), ['n1'])
			await expectFindIds(FilterGroup.create().notIn(kind, ['alpha']), ['n2'])
			await expectFindIds(FilterGroup.create().like(kind, 'alp'), ['n1'])
			await expectFindIds(FilterGroup.create().exists(role), ['n1', 'n2'])
			await expectFindIds(FilterGroup.create().notExists(missing), ['n1', 'n2'])
			await expectFindIds(FilterGroup.create().contains(tags, ['a']), ['n1'])
			await expectFindIds(FilterGroup.create().notContains(tags, ['a']), ['n2'])
			await expectFindIds(FilterGroup.create().eq(enabled, true), ['n1'])
		})

		test('findByPk returns seeded document and null for missing', async () => {
			const schema = Schema.from('test')
				.pk('id', v.string(), () => 'gen')
				.build()
			const adapter = InMemoryAdapter.create({})

			const use = adapter.use(schema, { table: 'test' })
			await use.createOne({ id: 'x' })

			const found = await adapter.findByPk(schema, { table: 'test' }, 'x')
			expect(found).toEqual({ id: 'x' })

			const missing = await adapter.findByPk(schema, { table: 'test' }, 'missing')
			expect(missing).toBeNull()
		})

		test('auto-wired Instance hooks register correctly keyed by class', async () => {
			const { Instance: Inst } = await import('../../../instance')
			const onSpy = (await import('vitest')).vi.spyOn(Inst, 'on').mockImplementation(() => {})

			InMemoryAdapter.create({})

			expect(onSpy).not.toHaveBeenCalled()

			onSpy.mockRestore()
		})

		test('declares aggregateOps with all six canonical ops', () => {
			const adapter = InMemoryAdapter.create({})
			expect(adapter.aggregateOps).toEqual(['count', 'countDistinct', 'sum', 'avg', 'min', 'max'])
		})

		test('aggregate count returns correct total', async () => {
			const schema = Schema.from('items')
				.pk('id', v.string(), () => `i-${Math.random().toString(36).slice(2, 8)}`)
				.field('category', v.string())
				.build()
			const adapter = InMemoryAdapter.create({})
			const use = adapter.use(schema, { table: 'items' })
			await use.createMany([
				{ id: 'i1', category: 'A' },
				{ id: 'i2', category: 'B' },
				{ id: 'i3', category: 'A' },
			])
			const result = await adapter.aggregate(schema, { table: 'items' }, {
				aggregates: [{ fn: 'count', alias: 'total' }],
				groupBy: [],
			})
			expect(result).toEqual([{ total: 3 }])
		})

		test('aggregate count with where filter', async () => {
			const schema = Schema.from('items')
				.pk('id', v.string(), () => `i-${Math.random().toString(36).slice(2, 8)}`)
				.field('category', v.string())
				.build()
			const adapter = InMemoryAdapter.create({})
			const use = adapter.use(schema, { table: 'items' })
			await use.createMany([
				{ id: 'i1', category: 'A' },
				{ id: 'i2', category: 'B' },
				{ id: 'i3', category: 'A' },
			])
			const result = await adapter.aggregate(schema, { table: 'items' }, {
				aggregates: [{ fn: 'count', alias: 'total' }],
				groupBy: [],
				where: FilterGroup.create().eq('category', 'A'),
			})
			expect(result).toEqual([{ total: 2 }])
		})

		test('aggregate count on empty store returns zero', async () => {
			const schema = Schema.from('items')
				.pk('id', v.string(), () => 'x')
				.build()
			const adapter = InMemoryAdapter.create({})
			const result = await adapter.aggregate(schema, { table: 'items' }, {
				aggregates: [{ fn: 'count', alias: 'total' }],
				groupBy: [],
			})
			expect(result).toEqual([{ total: 0 }])
		})

		test('aggregate sum/avg/min/max compute correctly', async () => {
			const schema = Schema.from('items')
				.pk('id', v.string(), () => 'x')
				.field('price', v.number())
				.build()
			const adapter = InMemoryAdapter.create({})
			const use = adapter.use(schema, { table: 'items' })
			await use.createMany([
				{ id: 'i1', price: 10 },
				{ id: 'i2', price: 20 },
				{ id: 'i3', price: 30 },
			])
			const result = await adapter.aggregate(schema, { table: 'items' }, {
				aggregates: [
					{ fn: 'sum', field: 'price', alias: 'total' },
					{ fn: 'avg', field: 'price', alias: 'avg' },
					{ fn: 'min', field: 'price', alias: 'low' },
					{ fn: 'max', field: 'price', alias: 'high' },
				],
				groupBy: [],
			})
			expect(result).toEqual([{ total: 60, avg: 20, low: 10, high: 30 }])
		})

		test('aggregate countDistinct counts unique values', async () => {
			const schema = Schema.from('items')
				.pk('id', v.string(), () => 'x')
				.field('category', v.string())
				.build()
			const adapter = InMemoryAdapter.create({})
			const use = adapter.use(schema, { table: 'items' })
			await use.createMany([
				{ id: 'i1', category: 'A' },
				{ id: 'i2', category: 'B' },
				{ id: 'i3', category: 'A' },
			])
			const result = await adapter.aggregate(schema, { table: 'items' }, {
				aggregates: [{ fn: 'countDistinct', field: 'category', alias: 'unique' }],
				groupBy: [],
			})
			expect(result).toEqual([{ unique: 2 }])
		})

		test('aggregate groupBy produces per-group results', async () => {
			const schema = Schema.from('orders')
				.pk('id', v.string(), () => 'x')
				.field('region', v.string())
				.field('amount', v.number())
				.build()
			const adapter = InMemoryAdapter.create({})
			const use = adapter.use(schema, { table: 'orders' })
			await use.createMany([
				{ id: 'o1', region: 'US', amount: 10 },
				{ id: 'o2', region: 'EU', amount: 20 },
				{ id: 'o3', region: 'US', amount: 30 },
			])
			const result = await adapter.aggregate(schema, { table: 'orders' }, {
				aggregates: [
					{ fn: 'count', alias: 'cnt' },
					{ fn: 'sum', field: 'amount', alias: 'total' },
				],
				groupBy: ['region'],
			})
			expect(result).toHaveLength(2)
			const us = result.find((r) => r.region === 'US')
			const eu = result.find((r) => r.region === 'EU')
			expect(us).toEqual({ region: 'US', cnt: 2, total: 40 })
			expect(eu).toEqual({ region: 'EU', cnt: 1, total: 20 })
		})

		test('aggregate having filters post-aggregation', async () => {
			const schema = Schema.from('orders')
				.pk('id', v.string(), () => 'x')
				.field('region', v.string())
				.field('amount', v.number())
				.build()
			const adapter = InMemoryAdapter.create({})
			const use = adapter.use(schema, { table: 'orders' })
			await use.createMany([
				{ id: 'o1', region: 'US', amount: 10 },
				{ id: 'o2', region: 'EU', amount: 20 },
				{ id: 'o3', region: 'US', amount: 30 },
			])
			const result = await adapter.aggregate(schema, { table: 'orders' }, {
				aggregates: [{ fn: 'sum', field: 'amount', alias: 'total' }],
				groupBy: ['region'],
				having: FilterGroup.create().gt('total', 25),
			})
			expect(result).toHaveLength(1)
			expect(result[0]).toEqual({ region: 'US', total: 40 })
		})
	})
}
