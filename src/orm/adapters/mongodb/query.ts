import { Filter, FilterGroup, type FilterChild } from '../../filter'
import type { AggregateSpec } from '../../orm-adapter'
import type { QueryOptions } from '../../query-options'
import { flattenOps, IncOp, MaxOp, MinOp, MulOp, PatchOp, PullOp, PushOp, SetOp, UnsetOp, type AnyUpdateOp } from '../../updates'

type MongoFilter = Record<string, unknown>

export function compileMongoFilter(group: FilterGroup, primaryKey: string): MongoFilter {
	const clauses: MongoFilter[] = []
	for (const child of group.children) {
		const compiled = compileChild(child, primaryKey)
		if (compiled) clauses.push(compiled)
	}

	if (clauses.length === 0) return {}
	if (clauses.length === 1) return clauses[0]
	return { $and: clauses }
}

export function compileMongoQuery(
	group: FilterGroup,
	options: QueryOptions | undefined,
	primaryKey: string,
): {
	filter: MongoFilter
	sort: Record<string, 1 | -1> | undefined
	limit: number | undefined
	skip: number | undefined
	projection: Record<string, 1> | undefined
} {
	const mongoFilter = compileMongoFilter(group, primaryKey)

	const orderBys = options?.orderBy ?? []
	const sort =
		orderBys.length > 0
			? Object.fromEntries(orderBys.map((o) => [mapField(o.field, primaryKey), o.direction === 'desc' ? -1 : 1]))
			: undefined

	const selects = options?.select ?? []
	const projection = selects.length > 0 ? Object.fromEntries(selects.map((f) => [mapField(f, primaryKey), 1])) : undefined

	return {
		filter: mongoFilter,
		sort: sort as Record<string, 1 | -1> | undefined,
		limit: options?.limit,
		skip: options?.offset,
		projection: projection as Record<string, 1> | undefined,
	}
}

function mapField(field: string, primaryKey: string): string {
	if (field === 'id' && primaryKey === '_id') return '_id'
	return field
}

function regexLiteral(value: unknown): RegExp {
	return new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
}

function compileFilter(f: Filter, primaryKey: string): MongoFilter {
	const field = mapField(f.field, primaryKey)

	switch (f.op) {
		case 'eq':
			return { [field]: { $eq: f.value } }
		case 'ne':
			return { [field]: { $ne: f.value } }
		case 'gt':
			return { [field]: { $gt: f.value } }
		case 'gte':
			return { [field]: { $gte: f.value } }
		case 'lt':
			return { [field]: { $lt: f.value } }
		case 'lte':
			return { [field]: { $lte: f.value } }
		case 'in':
			return { [field]: { $in: f.value } }
		case 'notIn':
			return { [field]: { $nin: f.value } }
		case 'like':
			return { [field]: { $regex: regexLiteral(f.value) } }
		case 'exists':
			return { [field]: { $exists: true, $ne: null } }
		case 'notExists':
			return { [field]: { $eq: null } }
		case 'contains':
			return { [field]: { $all: Array.isArray(f.value) ? f.value : [f.value] } }
		case 'notContains':
			return { [field]: { $not: { $all: Array.isArray(f.value) ? f.value : [f.value] } } }
		default:
			return { [field]: { $eq: f.value } }
	}
}

function compileChild(child: FilterChild, primaryKey: string): MongoFilter | null {
	if (child instanceof Filter) return compileFilter(child, primaryKey)
	if (child instanceof FilterGroup) return compileGroup(child, primaryKey)
	return null
}

function compileGroup(group: FilterGroup, primaryKey: string): MongoFilter | null {
	const clauses = group.children.map((c) => compileChild(c, primaryKey)).filter((c): c is MongoFilter => c !== null)
	if (clauses.length === 0) return null
	if (clauses.length === 1) return clauses[0]
	return { [group.op === 'or' ? '$or' : '$and']: clauses }
}

export function compileMongoUpdate(data: Record<string, unknown>): Record<string, unknown> {
	const $set: Record<string, unknown> = {}
	const $inc: Record<string, unknown> = {}
	const $mul: Record<string, unknown> = {}
	const $min: Record<string, unknown> = {}
	const $max: Record<string, unknown> = {}
	const $unset: Record<string, ''> = {}
	const $push: Record<string, unknown> = {}
	const $pull: Record<string, unknown> = {}

	for (const [key, value] of Object.entries(data)) {
		if (value instanceof IncOp) $inc[key] = value.value
		else if (value instanceof MulOp) $mul[key] = value.value
		else if (value instanceof MinOp) $min[key] = value.value
		else if (value instanceof MaxOp) $max[key] = value.value
		else if (value instanceof UnsetOp) $unset[key] = ''
		else if (value instanceof PushOp) $push[key] = value.value
		else if (value instanceof PullOp) $pull[key] = value.value
		else if (value instanceof PatchOp) {
			const patchVal = value.value as Record<string, unknown>
			for (const [subKey, subVal] of Object.entries(patchVal)) {
				$set[`${key}.${subKey}`] = subVal
			}
		} else $set[key] = value
	}

	const result: Record<string, unknown> = {}
	if (Object.keys($set).length) result.$set = $set
	if (Object.keys($inc).length) result.$inc = $inc
	if (Object.keys($mul).length) result.$mul = $mul
	if (Object.keys($min).length) result.$min = $min
	if (Object.keys($max).length) result.$max = $max
	if (Object.keys($unset).length) result.$unset = $unset
	if (Object.keys($push).length) result.$push = $push
	if (Object.keys($pull).length) result.$pull = $pull

	return result
}

export function compileMongoOps(ops: AnyUpdateOp[]): Record<string, unknown> {
	return compileMongoUpdate(flattenOps(ops))
}

export function compileMongoAggregate(spec: AggregateSpec, primaryKey: string): Record<string, unknown>[] {
	const pipeline: Record<string, unknown>[] = []

	if (spec.where) {
		const match = compileMongoFilter(spec.where, primaryKey)
		if (Object.keys(match).length > 0) pipeline.push({ $match: match })
	}

	const groupId: Record<string, string> | null =
		spec.groupBy.length > 0
			? Object.fromEntries(spec.groupBy.map((f) => [f, `$${mapField(f, primaryKey)}`]))
			: null

	const accumulators: Record<string, unknown> = {}
	for (const agg of spec.aggregates) {
		const fieldRef = agg.field ? `$${mapField(agg.field, primaryKey)}` : undefined
		switch (agg.fn) {
			case 'count':
				accumulators[agg.alias] = { $sum: 1 }
				break
			case 'countDistinct':
				accumulators[agg.alias] = { $addToSet: fieldRef }
				break
			case 'sum':
			case 'avg':
			case 'min':
			case 'max':
				accumulators[agg.alias] = { [`$${agg.fn}`]: fieldRef }
				break
		}
	}

	pipeline.push({ $group: { _id: groupId, ...accumulators } })

	const project: Record<string, unknown> = { _id: 0 }
	for (const f of spec.groupBy) {
		project[f] = `$_id.${f}`
	}
	for (const agg of spec.aggregates) {
		if (agg.fn === 'countDistinct') {
			project[agg.alias] = { $size: `$${agg.alias}` }
		} else {
			project[agg.alias] = 1
		}
	}
	pipeline.push({ $project: project })

	if (spec.having) {
		const havingMatch = compileMongoFilter(spec.having, '')
		if (Object.keys(havingMatch).length > 0) pipeline.push({ $match: havingMatch })
	}

	return pipeline
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { Field } = await import('../../fields')
	const { FilterGroup } = await import('../../filter')
	const { OrderBy } = await import('../../query-options')

	describe('compileMongoFilter', () => {
		test('empty filter group compiles to empty object', () => {
			const group = FilterGroup.create()
			expect(compileMongoFilter(group, 'id')).toEqual({})
		})

		test('single eq filter compiles to $eq', () => {
			const group = FilterGroup.create().eq('name', 'Alice')
			expect(compileMongoFilter(group, 'id')).toEqual({ name: { $eq: 'Alice' } })
		})

		test('ne, gt, gte, lt, lte compile to corresponding Mongo ops', () => {
			expect(compileMongoFilter(FilterGroup.create().ne('age', 5), 'id')).toEqual({ age: { $ne: 5 } })
			expect(compileMongoFilter(FilterGroup.create().gt('age', 10), 'id')).toEqual({ age: { $gt: 10 } })
			expect(compileMongoFilter(FilterGroup.create().gte('age', 20), 'id')).toEqual({ age: { $gte: 20 } })
			expect(compileMongoFilter(FilterGroup.create().lt('age', 30), 'id')).toEqual({ age: { $lt: 30 } })
			expect(compileMongoFilter(FilterGroup.create().lte('age', 40), 'id')).toEqual({ age: { $lte: 40 } })
		})

		test('in compiles to $in', () => {
			const group = FilterGroup.create().in('status', ['a', 'b'])
			expect(compileMongoFilter(group, 'id')).toEqual({ status: { $in: ['a', 'b'] } })
		})

		test('notIn compiles to $nin (canonical name notIn, Mongo op $nin)', () => {
			const group = FilterGroup.create().notIn('status', ['x', 'y'])
			expect(compileMongoFilter(group, 'id')).toEqual({ status: { $nin: ['x', 'y'] } })
		})

		test('like compiles to $regex with case-insensitive flag', () => {
			const group = FilterGroup.create().like('name', 'ali')
			const result = compileMongoFilter(group, 'id')
			expect(result.name).toEqual({ $regex: expect.any(RegExp) })
			const regex = (result.name as any).$regex as RegExp
			expect(regex.flags).toBe('i')
			expect(regex.test('Alice')).toBe(true)
		})

		test('like treats regex metacharacters as literal text', () => {
			const group = FilterGroup.create().like('name', 'a.b')
			const result = compileMongoFilter(group, 'id')
			const regex = (result.name as any).$regex as RegExp

			expect(regex.test('A.B')).toBe(true)
			expect(regex.test('acb')).toBe(false)
		})

		test('exists compiles to $exists: true, $ne: null', () => {
			const group = FilterGroup.create().exists('val')
			expect(compileMongoFilter(group, 'id')).toEqual({ val: { $exists: true, $ne: null } })
		})

		test('notExists is its own op — compiles to $eq: null', () => {
			const group = FilterGroup.create().notExists('val')
			expect(compileMongoFilter(group, 'id')).toEqual({ val: { $eq: null } })
		})

		test('contains compiles to $all', () => {
			const group = FilterGroup.create().contains('tags', ['a', 'b'])
			expect(compileMongoFilter(group, 'id')).toEqual({ tags: { $all: ['a', 'b'] } })
		})

		test('notContains compiles to $not: { $all }', () => {
			const group = FilterGroup.create().notContains('tags', ['x'])
			expect(compileMongoFilter(group, 'id')).toEqual({ tags: { $not: { $all: ['x'] } } })
		})

		test('multiple clauses produce $and', () => {
			const group = FilterGroup.create().eq('a', 1).gt('b', 2)
			const result = compileMongoFilter(group, 'id')
			expect(result).toEqual({ $and: [{ a: { $eq: 1 } }, { b: { $gt: 2 } }] })
		})

		test('nested and/or groups compile correctly', () => {
			const group = FilterGroup.create().and([
				(q) => q.eq('a', 1),
				(q) => q.or([(g) => g.eq('b', 2), (g) => g.eq('c', 3)]),
			])
			const result = compileMongoFilter(group, 'id')
			expect(result).toEqual({
				$and: [{ a: { $eq: 1 } }, { $or: [{ b: { $eq: 2 } }, { c: { $eq: 3 } }] }],
			})
		})

		test('maps id field to _id when primaryKey is _id', () => {
			const group = FilterGroup.create().eq('id', 'abc')
			expect(compileMongoFilter(group, '_id')).toEqual({ _id: { $eq: 'abc' } })
		})

		test('keeps nested field paths as Mongo dotted field names', () => {
			const defType = new Field<string>('def', ['def', 'type'], 'string')
			const group = FilterGroup.create().eq(defType, 'depends-on')

			expect(compileMongoFilter(group, 'id')).toEqual({ 'def.type': { $eq: 'depends-on' } })
		})

		test('uses nested dotted field names for non-eq ops', () => {
			const defType = new Field<string>('def', ['def', 'type'], 'string')
			const result = compileMongoFilter(FilterGroup.create().like(defType, 'depends'), 'id')

			expect(result).toEqual({ 'def.type': { $regex: expect.any(RegExp) } })
		})
	})

	describe('compileMongoQuery', () => {
		test('options: sort, limit, skip, projection', () => {
			const group = FilterGroup.create().eq('active', true)
			const options = {
				orderBy: [new OrderBy('name', 'asc'), new OrderBy('age', 'desc')],
				limit: 10,
				offset: 5,
				select: ['name', 'age'] as const,
			}
			const result = compileMongoQuery(group, options, 'id')
			expect(result.filter).toEqual({ active: { $eq: true } })
			expect(result.sort).toEqual({ name: 1, age: -1 })
			expect(result.limit).toBe(10)
			expect(result.skip).toBe(5)
			expect(result.projection).toEqual({ name: 1, age: 1 })
		})

		test('undefined options returns undefined for sort/limit/skip/projection', () => {
			const group = FilterGroup.create().eq('x', 1)
			const result = compileMongoQuery(group, undefined, 'id')
			expect(result.sort).toBeUndefined()
			expect(result.limit).toBeUndefined()
			expect(result.skip).toBeUndefined()
			expect(result.projection).toBeUndefined()
		})
	})

	describe('compileMongoUpdate', () => {
		test('plain values go into $set', () => {
			const result = compileMongoUpdate({ name: 'Alice', age: 30 })
			expect(result).toEqual({ $set: { name: 'Alice', age: 30 } })
		})

		test('IncOp goes into $inc', () => {
			const result = compileMongoUpdate({ count: new IncOp('count', 5) })
			expect(result).toEqual({ $inc: { count: 5 } })
		})

		test('MulOp goes into $mul', () => {
			const result = compileMongoUpdate({ score: new MulOp('score', 2) })
			expect(result).toEqual({ $mul: { score: 2 } })
		})

		test('MinOp/MaxOp go into $min/$max', () => {
			const result = compileMongoUpdate({
				lo: new MinOp('lo', 1),
				hi: new MaxOp('hi', 99),
			})
			expect(result).toEqual({ $min: { lo: 1 }, $max: { hi: 99 } })
		})

		test('UnsetOp goes into $unset', () => {
			const result = compileMongoUpdate({ old: new UnsetOp('old') })
			expect(result).toEqual({ $unset: { old: '' } })
		})

		test('PushOp/PullOp go into $push/$pull', () => {
			const result = compileMongoUpdate({
				tags: new PushOp('tags', 'new'),
				removed: new PullOp('removed', 'old'),
			})
			expect(result).toEqual({ $push: { tags: 'new' }, $pull: { removed: 'old' } })
		})

		test('PatchOp produces dot-notation $set entries', () => {
			const result = compileMongoUpdate({ meta: new PatchOp('meta', { a: 1, b: 2 }) })
			expect(result).toEqual({ $set: { 'meta.a': 1, 'meta.b': 2 } })
		})

		test('empty data produces empty result', () => {
			const result = compileMongoUpdate({})
			expect(result).toEqual({})
		})
	})

	describe('compileMongoOps', () => {
		test('SetOp values go into $set', () => {
			const result = compileMongoOps([new SetOp({ name: 'Bob', age: 25 })])
			expect(result).toEqual({ $set: { name: 'Bob', age: 25 } })
		})

		test('mixed ops compile to separate Mongo update operators', () => {
			const result = compileMongoOps([
				new SetOp({ name: 'Alice' }),
				new IncOp('count', 1),
				new PushOp('tags', 'x'),
			])
			expect(result).toEqual({
				$set: { name: 'Alice' },
				$inc: { count: 1 },
				$push: { tags: 'x' },
			})
		})

		test('empty ops produces empty result', () => {
			expect(compileMongoOps([])).toEqual({})
		})
	})

	describe('compileMongoAggregate', () => {
		test('bare count produces $group with $sum:1 and $project', () => {
			const spec: AggregateSpec = {
				aggregates: [{ fn: 'count', alias: 'total' }],
				groupBy: [],
			}
			expect(compileMongoAggregate(spec, '_id')).toEqual([
				{ $group: { _id: null, total: { $sum: 1 } } },
				{ $project: { _id: 0, total: 1 } },
			])
		})

		test('multi-aggregator produces all accumulators in $group', () => {
			const spec: AggregateSpec = {
				aggregates: [
					{ fn: 'count', alias: 'total' },
					{ fn: 'sum', field: 'amount', alias: 'revenue' },
					{ fn: 'avg', field: 'price', alias: 'avgPrice' },
				],
				groupBy: [],
			}
			expect(compileMongoAggregate(spec, '_id')).toEqual([
				{
					$group: {
						_id: null,
						total: { $sum: 1 },
						revenue: { $sum: '$amount' },
						avgPrice: { $avg: '$price' },
					},
				},
				{ $project: { _id: 0, total: 1, revenue: 1, avgPrice: 1 } },
			])
		})

		test('single-column groupBy produces composite _id and $project lift', () => {
			const spec: AggregateSpec = {
				aggregates: [{ fn: 'count', alias: 'total' }],
				groupBy: ['region'],
			}
			expect(compileMongoAggregate(spec, '_id')).toEqual([
				{ $group: { _id: { region: '$region' }, total: { $sum: 1 } } },
				{ $project: { _id: 0, region: '$_id.region', total: 1 } },
			])
		})

		test('multi-column groupBy via composite _id', () => {
			const spec: AggregateSpec = {
				aggregates: [{ fn: 'sum', field: 'amount', alias: 'revenue' }],
				groupBy: ['region', 'year'],
			}
			expect(compileMongoAggregate(spec, '_id')).toEqual([
				{
					$group: {
						_id: { region: '$region', year: '$year' },
						revenue: { $sum: '$amount' },
					},
				},
				{
					$project: {
						_id: 0,
						region: '$_id.region',
						year: '$_id.year',
						revenue: 1,
					},
				},
			])
		})

		test('where-only emits $match before $group', () => {
			const spec: AggregateSpec = {
				where: FilterGroup.create().eq('active', true),
				aggregates: [{ fn: 'count', alias: 'total' }],
				groupBy: [],
			}
			expect(compileMongoAggregate(spec, '_id')).toEqual([
				{ $match: { active: { $eq: true } } },
				{ $group: { _id: null, total: { $sum: 1 } } },
				{ $project: { _id: 0, total: 1 } },
			])
		})

		test('having-only emits $match after $project', () => {
			const spec: AggregateSpec = {
				aggregates: [{ fn: 'count', alias: 'total' }],
				groupBy: ['region'],
				having: FilterGroup.create().gt('total', 5),
			}
			expect(compileMongoAggregate(spec, '_id')).toEqual([
				{ $group: { _id: { region: '$region' }, total: { $sum: 1 } } },
				{ $project: { _id: 0, region: '$_id.region', total: 1 } },
				{ $match: { total: { $gt: 5 } } },
			])
		})

		test('where + having produces both $match stages', () => {
			const spec: AggregateSpec = {
				where: FilterGroup.create().eq('active', true),
				aggregates: [{ fn: 'sum', field: 'amount', alias: 'revenue' }],
				groupBy: ['region'],
				having: FilterGroup.create().gte('revenue', 1000),
			}
			expect(compileMongoAggregate(spec, '_id')).toEqual([
				{ $match: { active: { $eq: true } } },
				{
					$group: {
						_id: { region: '$region' },
						revenue: { $sum: '$amount' },
					},
				},
				{ $project: { _id: 0, region: '$_id.region', revenue: 1 } },
				{ $match: { revenue: { $gte: 1000 } } },
			])
		})

		test('countDistinct uses $addToSet in $group and $size in $project', () => {
			const spec: AggregateSpec = {
				aggregates: [{ fn: 'countDistinct', field: 'userId', alias: 'uniqueUsers' }],
				groupBy: [],
			}
			expect(compileMongoAggregate(spec, '_id')).toEqual([
				{ $group: { _id: null, uniqueUsers: { $addToSet: '$userId' } } },
				{ $project: { _id: 0, uniqueUsers: { $size: '$uniqueUsers' } } },
			])
		})

		test('min/max produce $min/$max accumulators', () => {
			const spec: AggregateSpec = {
				aggregates: [
					{ fn: 'min', field: 'price', alias: 'lowest' },
					{ fn: 'max', field: 'price', alias: 'highest' },
				],
				groupBy: [],
			}
			expect(compileMongoAggregate(spec, '_id')).toEqual([
				{
					$group: {
						_id: null,
						lowest: { $min: '$price' },
						highest: { $max: '$price' },
					},
				},
				{ $project: { _id: 0, lowest: 1, highest: 1 } },
			])
		})

		test('field-name mapping: id field maps to _id when primaryKey is _id', () => {
			const spec: AggregateSpec = {
				where: FilterGroup.create().eq('id', 'abc'),
				aggregates: [{ fn: 'count', alias: 'total' }],
				groupBy: ['id'],
			}
			expect(compileMongoAggregate(spec, '_id')).toEqual([
				{ $match: { _id: { $eq: 'abc' } } },
				{ $group: { _id: { id: '$_id' }, total: { $sum: 1 } } },
				{ $project: { _id: 0, id: '$_id.id', total: 1 } },
			])
		})

		test('countDistinct with groupBy combines $addToSet, groupBy lift, and $size', () => {
			const spec: AggregateSpec = {
				aggregates: [{ fn: 'countDistinct', field: 'category', alias: 'uniqueCats' }],
				groupBy: ['region'],
			}
			expect(compileMongoAggregate(spec, '_id')).toEqual([
				{
					$group: {
						_id: { region: '$region' },
						uniqueCats: { $addToSet: '$category' },
					},
				},
				{
					$project: {
						_id: 0,
						region: '$_id.region',
						uniqueCats: { $size: '$uniqueCats' },
					},
				},
			])
		})

		test('all six aggregators in a single pipeline', () => {
			const spec: AggregateSpec = {
				aggregates: [
					{ fn: 'count', alias: 'total' },
					{ fn: 'countDistinct', field: 'status', alias: 'uniqueStatuses' },
					{ fn: 'sum', field: 'amount', alias: 'totalAmount' },
					{ fn: 'avg', field: 'amount', alias: 'avgAmount' },
					{ fn: 'min', field: 'amount', alias: 'minAmount' },
					{ fn: 'max', field: 'amount', alias: 'maxAmount' },
				],
				groupBy: ['region'],
			}
			const pipeline = compileMongoAggregate(spec, '_id')
			expect(pipeline).toEqual([
				{
					$group: {
						_id: { region: '$region' },
						total: { $sum: 1 },
						uniqueStatuses: { $addToSet: '$status' },
						totalAmount: { $sum: '$amount' },
						avgAmount: { $avg: '$amount' },
						minAmount: { $min: '$amount' },
						maxAmount: { $max: '$amount' },
					},
				},
				{
					$project: {
						_id: 0,
						region: '$_id.region',
						total: 1,
						uniqueStatuses: { $size: '$uniqueStatuses' },
						totalAmount: 1,
						avgAmount: 1,
						minAmount: 1,
						maxAmount: 1,
					},
				},
			])
		})

		test('empty where filter is omitted from pipeline', () => {
			const spec: AggregateSpec = {
				where: FilterGroup.create(),
				aggregates: [{ fn: 'count', alias: 'total' }],
				groupBy: [],
			}
			expect(compileMongoAggregate(spec, '_id')).toEqual([
				{ $group: { _id: null, total: { $sum: 1 } } },
				{ $project: { _id: 0, total: 1 } },
			])
		})
	})
}
