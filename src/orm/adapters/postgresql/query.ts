import type { AggregateOpName } from '../../adapter.js'
import { OrmValidationError } from '../../errors/index.js'
import { Filter, FilterGroup, type FilterChild } from '../../filter.js'
import type { AggregateSpec } from '../../orm-adapter.js'
import type { QueryOptions } from '../../query-options.js'
import { IncOp, MaxOp, MinOp, MulOp, PatchOp, PullOp, PushOp, UnsetOp } from '../../updates.js'

function mapField(field: string, primaryKey: string): string {
	if (field === 'id' && primaryKey !== 'id') return primaryKey
	return field
}

function likeLiteral(value: unknown): string {
	return `%${String(value).replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
}

function quoteIdentifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`
}

export function quoteQualifiedIdentifier(value: string): string {
	return value.split('.').map(quoteIdentifier).join('.')
}

function pgJsonPath(path: readonly string[]): string {
	return `'{${path.map((segment) => segment.replaceAll('\\', '\\\\').replaceAll('"', '\\"')).join(',')}}'`
}

function isNestedFilter(f: Filter): boolean {
	return f.path.length > 1
}

function rootColumn(f: Filter, primaryKey: string): string {
	return quoteIdentifier(mapField(f.path[0] ?? f.field, primaryKey))
}

function jsonPath(f: Filter): string {
	return pgJsonPath(f.path.slice(1))
}

function nestedJsonExpr(f: Filter, primaryKey: string): string {
	return `${rootColumn(f, primaryKey)} #> ${jsonPath(f)}`
}

function nestedTextExpr(f: Filter, primaryKey: string): string {
	return `${rootColumn(f, primaryKey)} #>> ${jsonPath(f)}`
}

function nestedScalarExpr(f: Filter, primaryKey: string): string {
	const text = nestedTextExpr(f, primaryKey)
	switch (f.valueType) {
		case 'number':
			return `((${text})::numeric)`
		case 'boolean':
			return `((${text})::boolean)`
		case 'date':
			return `((${text})::timestamptz)`
		case 'null':
		case 'object':
		case 'array':
			return nestedJsonExpr(f, primaryKey)
		case 'string':
		case null:
			return text
	}
}

function pgNestedParamValue(f: Filter, value: unknown): unknown {
	switch (f.valueType) {
		case 'object':
		case 'array':
		case 'null':
			return JSON.stringify(value)
		default:
			return value
	}
}

function needsJsonbParamCast(f: Filter): boolean {
	return f.valueType === 'object' || f.valueType === 'array' || f.valueType === 'null'
}

function compileOps(f: Filter, field: string, nextParam: (v: unknown) => string): string {
	switch (f.op) {
		case 'eq':
			return f.value === null ? `${field} IS NULL` : `${field} = ${nextParam(f.value)}`
		case 'ne':
			return f.value === null ? `${field} IS NOT NULL` : `${field} != ${nextParam(f.value)}`
		case 'gt':
			return `${field} > ${nextParam(f.value)}`
		case 'gte':
			return `${field} >= ${nextParam(f.value)}`
		case 'lt':
			return `${field} < ${nextParam(f.value)}`
		case 'lte':
			return `${field} <= ${nextParam(f.value)}`
		case 'in':
			return `${field} = ANY(${nextParam(f.value)})`
		case 'notIn':
			return `NOT (${field} = ANY(${nextParam(f.value)}))`
		case 'like':
			return `${field} ILIKE ${nextParam(likeLiteral(f.value))} ESCAPE '\\'`
		case 'exists':
			return `${field} IS NOT NULL`
		case 'notExists':
			return `${field} IS NULL`
		case 'contains':
			return `${field} @> ${nextParam(JSON.stringify(f.value))}::jsonb`
		case 'notContains':
			return `NOT (${field} @> ${nextParam(JSON.stringify(f.value))}::jsonb)`
		default:
			return `${field} = ${nextParam(f.value)}`
	}
}

function compileNestedOps(f: Filter, primaryKey: string, nextParam: (v: unknown) => string): string {
	const scalar = nestedScalarExpr(f, primaryKey)
	const json = nestedJsonExpr(f, primaryKey)
	const text = nestedTextExpr(f, primaryKey)
	const param = (value: unknown) => nextParam(pgNestedParamValue(f, value))
	const jsonbCast = needsJsonbParamCast(f) ? '::jsonb' : ''

	switch (f.op) {
		case 'eq':
			return f.value === null ? `${json} IS NULL` : `${scalar} = ${param(f.value)}${jsonbCast}`
		case 'ne':
			return f.value === null ? `${json} IS NOT NULL` : `${scalar} != ${param(f.value)}${jsonbCast}`
		case 'gt':
			return `${scalar} > ${param(f.value)}`
		case 'gte':
			return `${scalar} >= ${param(f.value)}`
		case 'lt':
			return `${scalar} < ${param(f.value)}`
		case 'lte':
			return `${scalar} <= ${param(f.value)}`
		case 'in':
			return `${scalar} = ANY(${nextParam(f.value)})`
		case 'notIn':
			return `NOT (${scalar} = ANY(${nextParam(f.value)}))`
		case 'like':
			return `${text} ILIKE ${nextParam(likeLiteral(f.value))} ESCAPE '\\'`
		case 'exists':
			return `${json} IS NOT NULL`
		case 'notExists':
			return `${json} IS NULL`
		case 'contains':
			return `${json} @> ${nextParam(JSON.stringify(f.value))}::jsonb`
		case 'notContains':
			return `NOT (${json} @> ${nextParam(JSON.stringify(f.value))}::jsonb)`
		default:
			return `${scalar} = ${param(f.value)}${jsonbCast}`
	}
}

function compileFilter(f: Filter, primaryKey: string, nextParam: (v: unknown) => string): string {
	if (isNestedFilter(f)) return compileNestedOps(f, primaryKey, nextParam)
	return compileOps(f, quoteIdentifier(mapField(f.field, primaryKey)), nextParam)
}

function compileChildren(group: FilterGroup, compileLeaf: (f: Filter) => string): string[] {
	return group.children.map((c) => compileChild(c, compileLeaf)).filter((c): c is string => c !== null)
}

function compileGroup(group: FilterGroup, compileLeaf: (f: Filter) => string): string | null {
	const parts = compileChildren(group, compileLeaf)
	if (parts.length === 0) return null
	if (parts.length === 1) return parts[0]
	return `(${parts.join(group.op === 'or' ? ' OR ' : ' AND ')})`
}

function compileChild(child: FilterChild, compileLeaf: (f: Filter) => string): string | null {
	if (child instanceof Filter) return compileLeaf(child)
	if (child instanceof FilterGroup) return compileGroup(child, compileLeaf)
	return null
}

function compilePgFilter(
	group: FilterGroup,
	primaryKey: string,
	startIndex = 1,
): { whereClause: string; params: unknown[]; nextParamIndex: number } {
	const params: unknown[] = []
	let paramIndex = startIndex

	function nextParam(value: unknown): string {
		params.push(value)
		return `$${paramIndex++}`
	}

	const leaf = (f: Filter) => compileFilter(f, primaryKey, nextParam)
	const whereParts = compileChildren(group, leaf)

	const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : ''
	return { whereClause, params, nextParamIndex: paramIndex }
}

function buildSetParts(
	data: Record<string, unknown>,
	startIndex: number,
): { setParts: string[]; params: unknown[]; nextParamIndex: number } {
	const params: unknown[] = []
	let paramIndex = startIndex

	const setParts = Object.entries(data).map(([key, value]) => {
		const col = `"${key}"`

		if (value instanceof IncOp) {
			params.push(value.value)
			return `${col} = ${col} + $${paramIndex++}`
		}
		if (value instanceof MulOp) {
			params.push(value.value)
			return `${col} = ${col} * $${paramIndex++}`
		}
		if (value instanceof MinOp) {
			params.push(value.value)
			return `${col} = LEAST(${col}, $${paramIndex++})`
		}
		if (value instanceof MaxOp) {
			params.push(value.value)
			return `${col} = GREATEST(${col}, $${paramIndex++})`
		}
		if (value instanceof UnsetOp) {
			return `${col} = NULL`
		}
		if (value instanceof PushOp) {
			params.push(JSON.stringify(value.value))
			return `${col} = ${col} || jsonb_build_array($${paramIndex++}::jsonb)`
		}
		if (value instanceof PullOp) {
			params.push(JSON.stringify(value.value))
			return `${col} = (SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(${col}) e WHERE e <> $${paramIndex++}::jsonb)`
		}
		if (value instanceof PatchOp) {
			params.push(JSON.stringify(value.value))
			return `${col} = ${col} || $${paramIndex++}::jsonb`
		}

		params.push(value)
		return `${col} = $${paramIndex++}`
	})

	return { setParts, params, nextParamIndex: paramIndex }
}

export function buildSelectQuery(
	group: FilterGroup,
	options: QueryOptions | undefined,
	tableName: string,
	primaryKey: string,
): { sql: string; params: unknown[] } {
	const { whereClause, params, nextParamIndex } = compilePgFilter(group, primaryKey)
	let i = nextParamIndex

	const orderParts = (options?.orderBy ?? []).map(
		(o) => `"${mapField(o.field, primaryKey)}" ${o.direction.toUpperCase()}`,
	)
	const orderClause = orderParts.length > 0 ? `ORDER BY ${orderParts.join(', ')}` : ''

	let limitClause = ''
	if (options?.limit != null) {
		params.push(options.limit)
		limitClause = `LIMIT $${i++}`
	}
	let offsetClause = ''
	if (options?.offset != null) {
		params.push(options.offset)
		offsetClause = `OFFSET $${i++}`
	}
	const selectClause = options?.select?.length
		? options.select.map((f) => `"${mapField(f, primaryKey)}"`).join(', ')
		: '*'

	const sql =
		`SELECT ${selectClause} FROM ${quoteQualifiedIdentifier(tableName)} ${whereClause} ${orderClause} ${limitClause} ${offsetClause}`
			.trim()
			.replace(/\s+/g, ' ')
	return { sql, params }
}

export function buildCountQuery(
	group: FilterGroup,
	tableName: string,
	primaryKey: string,
): { sql: string; params: unknown[] } {
	const { whereClause, params } = compilePgFilter(group, primaryKey)
	const sql = `SELECT COUNT(*) as count FROM ${quoteQualifiedIdentifier(tableName)} ${whereClause}`
		.trim()
		.replace(/\s+/g, ' ')
	return { sql, params }
}

export function buildCreateQuery(tableName: string, data: Record<string, unknown>): { sql: string; params: unknown[] } {
	const keys = Object.keys(data)
	const params = Object.values(data)
	const placeholders = keys.map((_, i) => `$${i + 1}`)
	const columns = keys.map((k) => `"${k}"`).join(', ')
	const sql = `INSERT INTO ${quoteQualifiedIdentifier(tableName)} (${columns}) VALUES (${placeholders.join(', ')}) RETURNING *`
	return { sql, params }
}

export function buildUpdateQuery(
	group: FilterGroup,
	tableName: string,
	primaryKey: string,
	data: Record<string, unknown>,
): { sql: string; params: unknown[] } {
	const { setParts, params: setParams, nextParamIndex } = buildSetParts(data, 1)
	const { whereClause, params: whereParams } = compilePgFilter(group, primaryKey, nextParamIndex)
	const params = [...setParams, ...whereParams]
	const sql = `UPDATE ${quoteQualifiedIdentifier(tableName)} SET ${setParts.join(', ')} ${whereClause} RETURNING *`
		.trim()
		.replace(/\s+/g, ' ')
	return { sql, params }
}

export function buildPkUpdateQuery(
	tableName: string,
	primaryKey: string,
	pk: unknown,
	data: Record<string, unknown>,
): { sql: string; params: unknown[] } {
	const { setParts, params: setParams, nextParamIndex } = buildSetParts(data, 1)
	setParams.push(pk)
	const sql =
		`UPDATE ${quoteQualifiedIdentifier(tableName)} SET ${setParts.join(', ')} WHERE "${primaryKey}" = $${nextParamIndex} RETURNING *`.replace(
			/\s+/g,
			' ',
		)
	return { sql, params: setParams }
}

export function buildDeleteQuery(
	group: FilterGroup,
	tableName: string,
	primaryKey: string,
): { sql: string; params: unknown[] } {
	const { whereClause, params } = compilePgFilter(group, primaryKey)
	const sql = `DELETE FROM ${quoteQualifiedIdentifier(tableName)} ${whereClause} RETURNING *`
		.trim()
		.replace(/\s+/g, ' ')
	return { sql, params }
}

export function buildUpsertQuery(
	tableName: string,
	conflictColumn: string,
	primaryKey: string,
	create: Record<string, unknown>,
	data: Record<string, unknown>,
): { sql: string; params: unknown[] } {
	const columns = Object.keys(create)
	const createParams = Object.values(create)
	const placeholders = columns.map((_, i) => `$${i + 1}`)
	const pgConflictCol = mapField(conflictColumn, primaryKey)

	let setClause: string
	const allParams = [...createParams]

	if (Object.keys(data).length > 0) {
		const { setParts, params: setParams } = buildSetParts(data, columns.length + 1)
		setClause = setParts.join(', ')
		allParams.push(...setParams)
	} else {
		setClause = `"${pgConflictCol}" = EXCLUDED."${pgConflictCol}"`
	}

	const sql =
		`INSERT INTO ${quoteQualifiedIdentifier(tableName)} (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT ("${pgConflictCol}") DO UPDATE SET ${setClause} RETURNING *`.replace(
			/\s+/g,
			' ',
		)
	return { sql, params: allParams }
}

export function extractUpsertConflictColumn(filter: FilterGroup, schemaName: string): string {
	if (filter.children.length === 1 && filter.children[0] instanceof Filter && filter.children[0].op === 'eq') {
		return filter.children[0].field
	}

	let description: string
	if (filter.children.length === 0) {
		description = 'empty filter'
	} else if (filter.children.length === 1) {
		const child = filter.children[0]
		const opDesc = child instanceof Filter ? child.op : 'group'
		description = `single non-eq filter (op: ${opDesc})`
	} else {
		description = `${filter.children.length} filter clauses`
	}

	throw new OrmValidationError('upsert-filter-incompatible', schemaName, 'upsertOne', [
		{
			cause: `PostgreSQL upsert requires a single eq filter on a UNIQUE-indexed column; received ${description}`,
		},
	])
}

function aggFnToSql(fn: AggregateOpName, field: string | undefined, primaryKey: string): string {
	if (fn === 'count') return 'COUNT(*)'
	const col = `"${mapField(field!, primaryKey)}"`
	switch (fn) {
		case 'countDistinct':
			return `COUNT(DISTINCT ${col})`
		case 'sum':
			return `SUM(${col})`
		case 'avg':
			return `AVG(${col})`
		case 'min':
			return `MIN(${col})`
		case 'max':
			return `MAX(${col})`
	}
}

function resolveHavingField(
	field: string,
	primaryKey: string,
	aliasToExpr: Map<string, string>,
	groupBySet: Set<string>,
): string {
	if (aliasToExpr.has(field)) return aliasToExpr.get(field)!
	if (groupBySet.has(field)) return `"${mapField(field, primaryKey)}"`
	return `"${field}"`
}

export function buildAggregateQuery(
	spec: AggregateSpec,
	tableName: string,
	primaryKey: string,
): { sql: string; params: unknown[] } {
	const params: unknown[] = []
	let paramIndex = 1

	function nextParam(value: unknown): string {
		params.push(value)
		return `$${paramIndex++}`
	}

	const selectParts: string[] = []
	const aliasToExpr = new Map<string, string>()

	for (const agg of spec.aggregates) {
		const expr = aggFnToSql(agg.fn, agg.field, primaryKey)
		aliasToExpr.set(agg.alias, expr)
		selectParts.push(`${expr} AS "${agg.alias}"`)
	}

	const groupByFields: string[] = []
	for (const f of spec.groupBy) {
		const col = `"${mapField(f, primaryKey)}"`
		groupByFields.push(col)
		selectParts.push(`${col} AS "${f}"`)
	}

	let whereClause = ''
	if (spec.where) {
		const whereLeaf = (f: Filter) => compileFilter(f, primaryKey, nextParam)
		const whereParts = compileChildren(spec.where, whereLeaf)
		if (whereParts.length > 0) whereClause = `WHERE ${whereParts.join(' AND ')}`
	}

	const groupByClause = groupByFields.length > 0 ? `GROUP BY ${groupByFields.join(', ')}` : ''

	let havingClause = ''
	if (spec.having) {
		const groupBySet = new Set(spec.groupBy)
		const havingLeaf = (f: Filter) =>
			compileOps(f, resolveHavingField(f.field, primaryKey, aliasToExpr, groupBySet), nextParam)
		const havingParts = compileChildren(spec.having, havingLeaf)
		if (havingParts.length > 0) havingClause = `HAVING ${havingParts.join(' AND ')}`
	}

	const sql =
		`SELECT ${selectParts.join(', ')} FROM ${quoteQualifiedIdentifier(tableName)} ${whereClause} ${groupByClause} ${havingClause}`
			.trim()
			.replace(/\s+/g, ' ')
	return { sql, params }
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { Field } = await import('../../fields.js')
	const { FilterGroup } = await import('../../filter.js')

	describe('qualified table identifiers', () => {
		test('escapes namespace and table separately', () => {
			expect(quoteQualifiedIdentifier('tenant.schema"table')).toBe('"tenant"."schema""table"')
		})
	})
	const { OrderBy } = await import('../../query-options.js')
	const { IncOp, MulOp, MinOp, MaxOp, UnsetOp, PushOp, PullOp, PatchOp, SetOp, flattenOps } =
		await import('../../updates.js')
	const { OrmValidationError } = await import('../../errors/index.js')

	describe('compilePgFilter', () => {
		test('empty filter group compiles to empty WHERE clause', () => {
			const group = FilterGroup.create()
			const { sql } = buildSelectQuery(group, undefined, 'users', 'id')
			expect(sql).toBe('SELECT * FROM "users"')
		})

		test('single eq filter compiles to WHERE field = $1', () => {
			const group = FilterGroup.create().eq('name', 'Alice')
			const { sql, params } = buildSelectQuery(group, undefined, 'users', 'id')
			expect(sql).toBe('SELECT * FROM "users" WHERE "name" = $1')
			expect(params).toEqual(['Alice'])
		})

		test('eq with null compiles to IS NULL', () => {
			const group = FilterGroup.create().eq('name', null)
			const { sql, params } = buildSelectQuery(group, undefined, 'users', 'id')
			expect(sql).toBe('SELECT * FROM "users" WHERE "name" IS NULL')
			expect(params).toEqual([])
		})

		test('ne compiles to != (or IS NOT NULL for null)', () => {
			const group = FilterGroup.create().ne('age', 5)
			const { sql, params } = buildSelectQuery(group, undefined, 'users', 'id')
			expect(sql).toBe('SELECT * FROM "users" WHERE "age" != $1')
			expect(params).toEqual([5])

			const nullGroup = FilterGroup.create().ne('age', null)
			const { sql: nullSql } = buildSelectQuery(nullGroup, undefined, 'users', 'id')
			expect(nullSql).toBe('SELECT * FROM "users" WHERE "age" IS NOT NULL')
		})

		test('gt, gte, lt, lte compile to >, >=, <, <=', () => {
			expect(buildSelectQuery(FilterGroup.create().gt('age', 10), undefined, 't', 'id').sql).toContain(
				'"age" > $1',
			)
			expect(buildSelectQuery(FilterGroup.create().gte('age', 20), undefined, 't', 'id').sql).toContain(
				'"age" >= $1',
			)
			expect(buildSelectQuery(FilterGroup.create().lt('age', 30), undefined, 't', 'id').sql).toContain(
				'"age" < $1',
			)
			expect(buildSelectQuery(FilterGroup.create().lte('age', 40), undefined, 't', 'id').sql).toContain(
				'"age" <= $1',
			)
		})

		test('in compiles to = ANY($N)', () => {
			const group = FilterGroup.create().in('status', ['a', 'b'])
			const { sql, params } = buildSelectQuery(group, undefined, 'users', 'id')
			expect(sql).toContain('"status" = ANY($1)')
			expect(params).toEqual([['a', 'b']])
		})

		test('notIn compiles to NOT (field = ANY($N)) — canonical name notIn', () => {
			const group = FilterGroup.create().notIn('status', ['x', 'y'])
			const { sql, params } = buildSelectQuery(group, undefined, 'users', 'id')
			expect(sql).toContain('NOT ("status" = ANY($1))')
			expect(params).toEqual([['x', 'y']])
		})

		test('like compiles to ILIKE with % wrapping', () => {
			const group = FilterGroup.create().like('name', 'ali')
			const { sql, params } = buildSelectQuery(group, undefined, 'users', 'id')
			expect(sql).toContain('"name" ILIKE $1')
			expect(params).toEqual(['%ali%'])
		})

		test('like escapes sql wildcard characters for literal substring matching', () => {
			const group = FilterGroup.create().like('name', String.raw`a%b_c\d`)
			const { sql, params } = buildSelectQuery(group, undefined, 'users', 'id')

			expect(sql).toContain('"name" ILIKE $1 ESCAPE')
			expect(params).toEqual([String.raw`%a\%b\_c\\d%`])
		})

		test('exists compiles to IS NOT NULL (own op, not boolean form)', () => {
			const group = FilterGroup.create().exists('val')
			const { sql, params } = buildSelectQuery(group, undefined, 'users', 'id')
			expect(sql).toContain('"val" IS NOT NULL')
			expect(params).toEqual([])
		})

		test('notExists is its own op — compiles to IS NULL', () => {
			const group = FilterGroup.create().notExists('val')
			const { sql, params } = buildSelectQuery(group, undefined, 'users', 'id')
			expect(sql).toContain('"val" IS NULL')
			expect(params).toEqual([])
		})

		test('contains compiles to @> jsonb', () => {
			const group = FilterGroup.create().contains('tags', ['a', 'b'])
			const { sql, params } = buildSelectQuery(group, undefined, 'users', 'id')
			expect(sql).toContain('"tags" @> $1::jsonb')
			expect(params).toEqual([JSON.stringify(['a', 'b'])])
		})

		test('notContains compiles to NOT (@> jsonb)', () => {
			const group = FilterGroup.create().notContains('tags', ['x'])
			const { sql, params } = buildSelectQuery(group, undefined, 'users', 'id')
			expect(sql).toContain('NOT ("tags" @> $1::jsonb)')
			expect(params).toEqual([JSON.stringify(['x'])])
		})

		test('multiple clauses produce AND-joined WHERE', () => {
			const group = FilterGroup.create().eq('a', 1).gt('b', 2)
			const { sql } = buildSelectQuery(group, undefined, 't', 'id')
			expect(sql).toContain('WHERE "a" = $1 AND "b" > $2')
		})

		test('nested and/or groups compile correctly', () => {
			const group = FilterGroup.create().and([
				(q) => q.eq('a', 1),
				(q) => q.or([(g) => g.eq('b', 2), (g) => g.eq('c', 3)]),
			])
			const { sql, params } = buildSelectQuery(group, undefined, 't', 'id')
			expect(sql).toContain('("a" = $1 AND ("b" = $2 OR "c" = $3))')
			expect(params).toEqual([1, 2, 3])
		})

		test('maps id field to primaryKey when primaryKey differs', () => {
			const group = FilterGroup.create().eq('id', 'abc')
			const { sql } = buildSelectQuery(group, undefined, 'users', 'user_id')
			expect(sql).toContain('"user_id" = $1')
		})

		test('nested eq compiles to a JSONB text path expression', () => {
			const typeField = new Field<string>('def', ['def', 'type'], 'string')
			const { sql, params } = buildSelectQuery(
				FilterGroup.create().eq(typeField, 'depends-on'),
				undefined,
				'links',
				'id',
			)

			expect(sql).toContain('"def" #>>')
			expect(sql).toContain("'{type}'")
			expect(sql).not.toContain('"def.type"')
			expect(params).toEqual(['depends-on'])
		})

		test('nested filters compile all scalar comparison ops without quoted dotted columns', () => {
			const typeField = new Field<string>('def', ['def', 'type'], 'string')
			const countField = new Field<number>('meta', ['meta', 'count'], 'number')
			const cases = [
				FilterGroup.create().ne(typeField, 'produced'),
				FilterGroup.create().gt(countField, 3),
				FilterGroup.create().gte(countField, 3),
				FilterGroup.create().lt(countField, 7),
				FilterGroup.create().lte(countField, 7),
				FilterGroup.create().in(typeField, ['depends-on']),
				FilterGroup.create().notIn(typeField, ['produced']),
				FilterGroup.create().like(typeField, 'depends'),
			]

			for (const group of cases) {
				const { sql } = buildSelectQuery(group, undefined, 'items', 'id')
				expect(sql).not.toContain('"def.type"')
				expect(sql).not.toContain('"meta.count"')
			}
			expect(buildSelectQuery(FilterGroup.create().gt(countField, 3), undefined, 'items', 'id').sql).toContain(
				'::numeric',
			)
		})

		test('nested existence and containment ops compile against JSONB paths', () => {
			const roleField = new Field<string>('meta', ['meta', 'config', 'role'], 'string')
			const tagsField = new Field<string>('meta', ['meta', 'tags'], 'array')

			const existsSql = buildSelectQuery(FilterGroup.create().exists(roleField), undefined, 'items', 'id').sql
			const notExistsSql = buildSelectQuery(
				FilterGroup.create().notExists(roleField),
				undefined,
				'items',
				'id',
			).sql
			const contains = buildSelectQuery(FilterGroup.create().contains(tagsField, ['a']), undefined, 'items', 'id')
			const notContains = buildSelectQuery(
				FilterGroup.create().notContains(tagsField, ['a']),
				undefined,
				'items',
				'id',
			)

			expect(existsSql).toContain('"meta" #>')
			expect(existsSql).toContain('IS NOT NULL')
			expect(notExistsSql).toContain('"meta" #>')
			expect(notExistsSql).toContain('IS NULL')
			expect(contains.sql).toContain('"meta" #>')
			expect(contains.sql).toContain('@>')
			expect(contains.params).toEqual([JSON.stringify(['a'])])
			expect(notContains.sql).toContain('NOT ("meta" #>')
			expect(notContains.params).toEqual([JSON.stringify(['a'])])
		})
	})

	describe('buildSelectQuery', () => {
		test('options: sort, limit, offset, select', () => {
			const group = FilterGroup.create().eq('active', true)
			const options = {
				orderBy: [new OrderBy('name', 'asc'), new OrderBy('age', 'desc')],
				limit: 10,
				offset: 5,
				select: ['name', 'age'] as const,
			}
			const { sql, params } = buildSelectQuery(group, options, 'users', 'id')
			expect(sql).toContain('SELECT "name", "age"')
			expect(sql).toContain('ORDER BY "name" ASC, "age" DESC')
			expect(sql).toContain('LIMIT $2')
			expect(sql).toContain('OFFSET $3')
			expect(params).toEqual([true, 10, 5])
		})

		test('undefined options returns basic SELECT *', () => {
			const group = FilterGroup.create().eq('x', 1)
			const { sql } = buildSelectQuery(group, undefined, 'users', 'id')
			expect(sql).toBe('SELECT * FROM "users" WHERE "x" = $1')
		})
	})

	describe('buildCreateQuery', () => {
		test('produces INSERT with RETURNING *', () => {
			const { sql, params } = buildCreateQuery('users', { name: 'Alice', age: 30 })
			expect(sql).toBe('INSERT INTO "users" ("name", "age") VALUES ($1, $2) RETURNING *')
			expect(params).toEqual(['Alice', 30])
		})
	})

	describe('buildUpdateQuery', () => {
		test('plain values produce SET col = $N', () => {
			const group = FilterGroup.create().eq('id', 'u1')
			const { sql, params } = buildUpdateQuery(group, 'users', 'id', { name: 'Bob', age: 25 })
			expect(sql).toBe('UPDATE "users" SET "name" = $1, "age" = $2 WHERE "id" = $3 RETURNING *')
			expect(params).toEqual(['Bob', 25, 'u1'])
		})

		test('IncOp produces col = col + $N', () => {
			const group = FilterGroup.create().eq('id', 'u1')
			const { sql, params } = buildUpdateQuery(group, 'users', 'id', { count: new IncOp('count', 5) })
			expect(sql).toContain('"count" = "count" + $1')
			expect(params[0]).toBe(5)
		})

		test('MulOp produces col = col * $N', () => {
			const group = FilterGroup.create().eq('id', 'u1')
			const { sql } = buildUpdateQuery(group, 'users', 'id', { score: new MulOp('score', 2) })
			expect(sql).toContain('"score" = "score" * $1')
		})

		test('MinOp/MaxOp produce LEAST/GREATEST', () => {
			const group = FilterGroup.create().eq('id', 'u1')
			const { sql } = buildUpdateQuery(group, 'users', 'id', {
				lo: new MinOp('lo', 1),
				hi: new MaxOp('hi', 99),
			})
			expect(sql).toContain('LEAST("lo", $1)')
			expect(sql).toContain('GREATEST("hi", $2)')
		})

		test('UnsetOp produces col = NULL', () => {
			const group = FilterGroup.create().eq('id', 'u1')
			const { sql } = buildUpdateQuery(group, 'users', 'id', { old: new UnsetOp('old') })
			expect(sql).toContain('"old" = NULL')
		})

		test('PushOp produces jsonb array append', () => {
			const group = FilterGroup.create().eq('id', 'u1')
			const { sql } = buildUpdateQuery(group, 'users', 'id', { tags: new PushOp('tags', 'new') })
			expect(sql).toContain('jsonb_build_array($1::jsonb)')
		})

		test('PullOp produces jsonb array removal', () => {
			const group = FilterGroup.create().eq('id', 'u1')
			const { sql } = buildUpdateQuery(group, 'users', 'id', { tags: new PullOp('tags', 'old') })
			expect(sql).toContain('jsonb_array_elements')
		})

		test('PatchOp produces jsonb merge', () => {
			const group = FilterGroup.create().eq('id', 'u1')
			const { sql } = buildUpdateQuery(group, 'users', 'id', { meta: new PatchOp('meta', { a: 1 }) })
			expect(sql).toContain('|| $1::jsonb')
		})
	})

	describe('buildPkUpdateQuery', () => {
		test('builds UPDATE with PK WHERE clause', () => {
			const { sql, params } = buildPkUpdateQuery('users', 'id', 'u1', { name: 'Bob' })
			expect(sql).toBe('UPDATE "users" SET "name" = $1 WHERE "id" = $2 RETURNING *')
			expect(params).toEqual(['Bob', 'u1'])
		})

		test('handles ops in PK update', () => {
			const { sql, params } = buildPkUpdateQuery('users', 'id', 'u1', { count: new IncOp('count', 3) })
			expect(sql).toContain('"count" = "count" + $1')
			expect(sql).toContain('WHERE "id" = $2')
			expect(params).toEqual([3, 'u1'])
		})
	})

	describe('buildDeleteQuery', () => {
		test('produces DELETE with RETURNING *', () => {
			const group = FilterGroup.create().eq('id', 'u1')
			const { sql, params } = buildDeleteQuery(group, 'users', 'id')
			expect(sql).toBe('DELETE FROM "users" WHERE "id" = $1 RETURNING *')
			expect(params).toEqual(['u1'])
		})
	})

	describe('buildUpsertQuery', () => {
		test('produces INSERT ON CONFLICT with SET parts from data', () => {
			const data = flattenOps([new SetOp({ name: 'Updated' })])
			const { sql, params } = buildUpsertQuery(
				'users',
				'email',
				'id',
				{ id: 'u1', email: 'a@b.com', name: 'Alice' },
				data,
			)
			expect(sql).toContain('INSERT INTO "users"')
			expect(sql).toContain('ON CONFLICT ("email") DO UPDATE SET')
			expect(sql).toContain('"name" = $4')
			expect(sql).toContain('RETURNING *')
			expect(params).toEqual(['u1', 'a@b.com', 'Alice', 'Updated'])
		})

		test('empty data produces no-op SET on conflict column', () => {
			const { sql, params } = buildUpsertQuery('users', 'email', 'id', { id: 'u1', email: 'a@b.com' }, {})
			expect(sql).toContain('ON CONFLICT ("email") DO UPDATE SET "email" = EXCLUDED."email"')
			expect(params).toEqual(['u1', 'a@b.com'])
		})

		test('maps conflict column via mapField when primaryKey differs', () => {
			const { sql } = buildUpsertQuery('users', 'id', 'user_id', { user_id: 'u1', name: 'A' }, {})
			expect(sql).toContain('ON CONFLICT ("user_id")')
		})

		test('handles ops in upsert SET clause', () => {
			const data = flattenOps([new IncOp('views', 1)])
			const { sql, params } = buildUpsertQuery('posts', 'slug', 'id', { id: 'p1', slug: 'hello', views: 0 }, data)
			expect(sql).toContain('"views" = "views" + $4')
			expect(params).toEqual(['p1', 'hello', 0, 1])
		})
	})

	describe('extractUpsertConflictColumn', () => {
		test('extracts field from single eq filter', () => {
			const filter = FilterGroup.create().eq('email', 'a@b.com')
			expect(extractUpsertConflictColumn(filter, 'users')).toBe('email')
		})

		test('throws upsert-filter-incompatible on empty filter', () => {
			const filter = FilterGroup.create()
			expect(() => extractUpsertConflictColumn(filter, 'users')).toThrow(OrmValidationError)
			try {
				extractUpsertConflictColumn(filter, 'users')
			} catch (e) {
				const err = e as OrmValidationError
				expect(err.kind).toBe('upsert-filter-incompatible')
				expect(err.schema).toBe('users')
				expect(err.operation).toBe('upsertOne')
				expect(err.failures[0].cause).toContain('empty filter')
			}
		})

		test('throws upsert-filter-incompatible on multiple filters', () => {
			const filter = FilterGroup.create().eq('a', 1).eq('b', 2)
			expect(() => extractUpsertConflictColumn(filter, 'users')).toThrow(OrmValidationError)
			try {
				extractUpsertConflictColumn(filter, 'users')
			} catch (e) {
				const err = e as OrmValidationError
				expect(err.kind).toBe('upsert-filter-incompatible')
				expect(err.failures[0].cause).toContain('2 filter clauses')
			}
		})

		test('throws upsert-filter-incompatible on non-eq filter', () => {
			const filter = FilterGroup.create().gt('age', 10)
			expect(() => extractUpsertConflictColumn(filter, 'users')).toThrow(OrmValidationError)
			try {
				extractUpsertConflictColumn(filter, 'users')
			} catch (e) {
				const err = e as OrmValidationError
				expect(err.kind).toBe('upsert-filter-incompatible')
				expect(err.failures[0].cause).toContain('non-eq filter')
			}
		})

		test('throws with clear message naming received filter shape', () => {
			const filter = FilterGroup.create().in('status', ['a', 'b'])
			try {
				extractUpsertConflictColumn(filter, 'test')
				expect.unreachable()
			} catch (e) {
				const err = e as OrmValidationError
				expect(err.kind).toBe('upsert-filter-incompatible')
				expect(err.failures[0].cause).toContain('single eq filter')
				expect(err.failures[0].cause).toContain('UNIQUE-indexed column')
			}
		})
	})

	describe('buildAggregateQuery', () => {
		test('bare count produces SELECT COUNT(*) AS alias', () => {
			const { sql, params } = buildAggregateQuery(
				{ aggregates: [{ fn: 'count', alias: 'total' }], groupBy: [] },
				'orders',
				'id',
			)
			expect(sql).toBe('SELECT COUNT(*) AS "total" FROM "orders"')
			expect(params).toEqual([])
		})

		test('multi-aggregator produces all functions', () => {
			const { sql, params } = buildAggregateQuery(
				{
					aggregates: [
						{ fn: 'count', alias: 'cnt' },
						{ fn: 'sum', field: 'amount', alias: 'revenue' },
						{ fn: 'avg', field: 'amount', alias: 'avgAmt' },
						{ fn: 'min', field: 'amount', alias: 'lo' },
						{ fn: 'max', field: 'amount', alias: 'hi' },
					],
					groupBy: [],
				},
				'orders',
				'id',
			)
			expect(sql).toBe(
				'SELECT COUNT(*) AS "cnt", SUM("amount") AS "revenue", AVG("amount") AS "avgAmt", MIN("amount") AS "lo", MAX("amount") AS "hi" FROM "orders"',
			)
			expect(params).toEqual([])
		})

		test('countDistinct produces COUNT(DISTINCT col)', () => {
			const { sql } = buildAggregateQuery(
				{ aggregates: [{ fn: 'countDistinct', field: 'category', alias: 'unique' }], groupBy: [] },
				'items',
				'id',
			)
			expect(sql).toBe('SELECT COUNT(DISTINCT "category") AS "unique" FROM "items"')
		})

		test('single-column groupBy produces GROUP BY clause', () => {
			const { sql } = buildAggregateQuery(
				{
					aggregates: [{ fn: 'count', alias: 'cnt' }],
					groupBy: ['region'],
				},
				'orders',
				'id',
			)
			expect(sql).toBe('SELECT COUNT(*) AS "cnt", "region" AS "region" FROM "orders" GROUP BY "region"')
		})

		test('multi-column groupBy produces all GROUP BY columns', () => {
			const { sql } = buildAggregateQuery(
				{
					aggregates: [{ fn: 'count', alias: 'cnt' }],
					groupBy: ['region', 'product'],
				},
				'orders',
				'id',
			)
			expect(sql).toBe(
				'SELECT COUNT(*) AS "cnt", "region" AS "region", "product" AS "product" FROM "orders" GROUP BY "region", "product"',
			)
		})

		test('where-only produces WHERE clause with params', () => {
			const where = FilterGroup.create().eq('status', 'active')
			const { sql, params } = buildAggregateQuery(
				{ aggregates: [{ fn: 'count', alias: 'total' }], groupBy: [], where },
				'orders',
				'id',
			)
			expect(sql).toBe('SELECT COUNT(*) AS "total" FROM "orders" WHERE "status" = $1')
			expect(params).toEqual(['active'])
		})

		test('having-only filters on aggregate alias via repeated expression', () => {
			const having = FilterGroup.create().gt('total', 10)
			const { sql, params } = buildAggregateQuery(
				{
					aggregates: [{ fn: 'count', alias: 'total' }],
					groupBy: ['region'],
					having,
				},
				'orders',
				'id',
			)
			expect(sql).toBe(
				'SELECT COUNT(*) AS "total", "region" AS "region" FROM "orders" GROUP BY "region" HAVING COUNT(*) > $1',
			)
			expect(params).toEqual([10])
		})

		test('where + having both produce correct param ordering', () => {
			const where = FilterGroup.create().eq('status', 'active')
			const having = FilterGroup.create().gte('revenue', 1000)
			const { sql, params } = buildAggregateQuery(
				{
					aggregates: [{ fn: 'sum', field: 'amount', alias: 'revenue' }],
					groupBy: ['region'],
					where,
					having,
				},
				'orders',
				'id',
			)
			expect(sql).toBe(
				'SELECT SUM("amount") AS "revenue", "region" AS "region" FROM "orders" WHERE "status" = $1 GROUP BY "region" HAVING SUM("amount") >= $2',
			)
			expect(params).toEqual(['active', 1000])
		})

		test('having on groupBy field uses column name directly', () => {
			const having = FilterGroup.create().eq('region', 'US')
			const { sql, params } = buildAggregateQuery(
				{
					aggregates: [{ fn: 'count', alias: 'cnt' }],
					groupBy: ['region'],
					having,
				},
				'orders',
				'id',
			)
			expect(sql).toBe(
				'SELECT COUNT(*) AS "cnt", "region" AS "region" FROM "orders" GROUP BY "region" HAVING "region" = $1',
			)
			expect(params).toEqual(['US'])
		})

		test('field-name mapping: id maps to primaryKey when primaryKey differs', () => {
			const { sql } = buildAggregateQuery(
				{
					aggregates: [{ fn: 'countDistinct', field: 'id', alias: 'uniqueIds' }],
					groupBy: [],
				},
				'users',
				'user_id',
			)
			expect(sql).toBe('SELECT COUNT(DISTINCT "user_id") AS "uniqueIds" FROM "users"')
		})

		test('groupBy with id field maps to primaryKey', () => {
			const { sql } = buildAggregateQuery(
				{
					aggregates: [{ fn: 'count', alias: 'cnt' }],
					groupBy: ['id'],
				},
				'users',
				'user_id',
			)
			expect(sql).toContain('GROUP BY "user_id"')
			expect(sql).toContain('"user_id" AS "id"')
		})

		test('complex having with AND/OR groups', () => {
			const having = FilterGroup.create().and([
				(q) => q.gt('cnt', 5),
				(q) => q.or([(g) => g.eq('region', 'US'), (g) => g.eq('region', 'EU')]),
			])
			const { sql, params } = buildAggregateQuery(
				{
					aggregates: [{ fn: 'count', alias: 'cnt' }],
					groupBy: ['region'],
					having,
				},
				'orders',
				'id',
			)
			expect(sql).toContain('HAVING (COUNT(*) > $1 AND ("region" = $2 OR "region" = $3))')
			expect(params).toEqual([5, 'US', 'EU'])
		})
	})
}
