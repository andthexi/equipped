import { assertNormalisedAggregate, assertNormalisedFilter, type FilterGroup } from '../../filter.js'
import type { AggregateSpec } from '../../orm-adapter.js'
import type { IterationOptions, OrderBy } from '../../query-options.js'
import type { AnyPreloadDef } from '../../relations.js'
import {
	validateCreate,
	validateCreateMany,
	validateUpdate,
	validateUpsertConflicts,
	type SchemaCreateInput,
	type SchemaUpdateInput,
} from '../../schema-validations.js'
import type { AnySchema } from '../../schema.js'
import { SetOp, isUpdateOp, type AnyUpdateOp } from '../../updates.js'
import type { SchemaContext, UpsertInput } from '../builders.js'
import { planSelection } from './computeds.js'
import {
	assertNormalisedFindReadShape,
	normaliseAllFindReadShape,
	normaliseAllIterateReadShape,
	normaliseAllPaginateReadShape,
	type ReadLimitSource,
	type ReadOffsetSource,
} from './query-shape.js'
import type { Paginated, SelectedWithPreloads } from './types.js'

export async function runOneRead<S extends AnySchema, Sel extends string, P extends readonly AnyPreloadDef[]>(
	context: SchemaContext<S>,
	state: {
		where: FilterGroup
		select: readonly Sel[] | undefined
		preloads: P
	},
): Promise<SelectedWithPreloads<S, Sel, P> | null> {
	assertNormalisedFilter(context.schema, state.where)
	assertNormalisedFindReadShape(context.schema, 'findOne', state)
	const row = await context.use.findOne(state.where)
	if (!row) return null
	return context.shapeOneRow(state.select, state.preloads, row)
}

export async function runAllRead<S extends AnySchema, Sel extends string, P extends readonly AnyPreloadDef[]>(
	context: SchemaContext<S>,
	state: {
		where: FilterGroup
		select: readonly Sel[] | undefined
		preloads: P
		orderBy: readonly OrderBy[]
		limitSource?: ReadLimitSource
		offsetSource?: ReadOffsetSource
	},
): Promise<SelectedWithPreloads<S, Sel, P>[]> {
	assertNormalisedFilter(context.schema, state.where)
	const query = normaliseAllFindReadShape(context.schema, 'findMany', state)
	const plan = planSelection(context.schema, state.select as readonly string[] | undefined)
	const rows = await context.use.findMany(state.where, {
		select: plan.adapterSelect,
		orderBy: [...state.orderBy],
		limit: query.limit,
		offset: query.offset,
	})
	return context.shapeRows(state.select, state.preloads, rows)
}

export async function runAllCount<S extends AnySchema>(
	context: SchemaContext<S>,
	state: { where: FilterGroup },
): Promise<number> {
	assertNormalisedFilter(context.schema, state.where)
	return context.use.count(state.where)
}

function toPaginated<T>(items: T[], total: number, limit: number | undefined, current: number): Paginated<T> {
	const start = 1
	if (limit === undefined) {
		return {
			pages: { current: 1, start, last: 1, previous: null, next: null },
			docs: { limit: items.length, total: items.length, count: items.length },
			items,
		}
	}
	const last = Math.ceil(total / limit) || 1
	const previous = current <= start || current > last ? null : current - 1
	const next = current >= last ? null : current + 1
	return {
		pages: { current, start, last, previous, next },
		docs: { limit, total, count: items.length },
		items,
	}
}

export async function runAllPaginate<S extends AnySchema, Sel extends string, P extends readonly AnyPreloadDef[]>(
	context: SchemaContext<S>,
	state: {
		where: FilterGroup
		select: readonly Sel[] | undefined
		preloads: P
		orderBy: readonly OrderBy[]
		limitSource?: ReadLimitSource
		offsetSource?: ReadOffsetSource
	},
): Promise<Paginated<SelectedWithPreloads<S, Sel, P>>> {
	assertNormalisedFilter(context.schema, state.where)
	const query = normaliseAllPaginateReadShape(context.schema, 'paginate', state)
	const plan = planSelection(context.schema, state.select as readonly string[] | undefined)
	const use = context.use
	if (query.limit === undefined) {
		const rows = await use.findMany(state.where, {
			select: plan.adapterSelect,
			orderBy: [...state.orderBy],
		})
		const items = await context.shapeRows(state.select, state.preloads, rows)
		return toPaginated(items, items.length, query.limit, query.current)
	}
	const [rows, total] = await Promise.all([
		use.findMany(state.where, {
			select: plan.adapterSelect,
			orderBy: [...state.orderBy],
			limit: query.limit,
			offset: query.offset,
		}),
		use.count(state.where),
	])
	const items = await context.shapeRows(state.select, state.preloads, rows)
	return toPaginated(items, total, query.limit, query.current)
}

export async function* runAllIterate<S extends AnySchema, Sel extends string, P extends readonly AnyPreloadDef[]>(
	context: SchemaContext<S>,
	state: {
		where: FilterGroup
		select: readonly Sel[] | undefined
		preloads: P
		orderBy: readonly OrderBy[]
		limitSource?: ReadLimitSource
		offsetSource?: ReadOffsetSource
	},
	options?: IterationOptions,
): AsyncGenerator<SelectedWithPreloads<S, Sel, P>, void, void> {
	assertNormalisedFilter(context.schema, state.where)
	const query = normaliseAllIterateReadShape(context.schema, 'iterate', state, options)
	const plan = planSelection(context.schema, state.select as readonly string[] | undefined)

	for await (const row of context.use.iterateMany(state.where, {
		select: plan.adapterSelect,
		orderBy: [...state.orderBy],
		limit: query.limit,
		offset: query.offset,
		...(query.batchSize === undefined ? {} : { batchSize: query.batchSize }),
	})) {
		const shaped = await context.shapeRows(state.select, state.preloads, [row])
		const first = shaped[0]
		if (first) yield first
	}
}

export async function runOneCreate<S extends AnySchema, Sel extends string, P extends readonly AnyPreloadDef[]>(
	context: SchemaContext<S>,
	state: { select: readonly Sel[] | undefined; preloads: P },
	data: SchemaCreateInput<S>,
): Promise<SelectedWithPreloads<S, Sel, P>> {
	const validated = validateCreate(context.schema, data as any)
	const row = await context.use.createOne(validated as any)
	const [resolved] = await context.shapeRows(state.select, state.preloads, [row])
	return resolved
}

export async function runAllCreate<S extends AnySchema, Sel extends string, P extends readonly AnyPreloadDef[]>(
	context: SchemaContext<S>,
	state: { select: readonly Sel[] | undefined; preloads: P },
	data: SchemaCreateInput<S>[],
): Promise<SelectedWithPreloads<S, Sel, P>[]> {
	const validated = validateCreateMany(context.schema, data as any)
	const rows = await context.use.createMany(validated as any)
	return context.shapeRows(state.select, state.preloads, rows)
}

export async function runOneUpdate<S extends AnySchema, Sel extends string, P extends readonly AnyPreloadDef[]>(
	context: SchemaContext<S>,
	state: { where: FilterGroup; select: readonly Sel[] | undefined; preloads: P },
	data: SchemaUpdateInput<S>,
): Promise<SelectedWithPreloads<S, Sel, P> | null> {
	assertNormalisedFilter(context.schema, state.where)
	const validated = validateUpdate(context.schema, data as any)
	const row = await context.use.updateOne(state.where, validated as any)
	return context.shapeOneRow(state.select, state.preloads, row)
}

export async function runAllUpdate<S extends AnySchema, Sel extends string, P extends readonly AnyPreloadDef[]>(
	context: SchemaContext<S>,
	state: { where: FilterGroup; select: readonly Sel[] | undefined; preloads: P },
	data: SchemaUpdateInput<S>,
): Promise<SelectedWithPreloads<S, Sel, P>[]> {
	assertNormalisedFilter(context.schema, state.where)
	const validated = validateUpdate(context.schema, data as any)
	const rows = await context.use.updateMany(state.where, validated as any)
	return context.shapeRows(state.select, state.preloads, rows)
}

export async function runOneUpsert<S extends AnySchema, Sel extends string, P extends readonly AnyPreloadDef[]>(
	context: SchemaContext<S>,
	state: { where: FilterGroup; select: readonly Sel[] | undefined; preloads: P },
	data: UpsertInput<S>,
): Promise<SelectedWithPreloads<S, Sel, P>> {
	assertNormalisedFilter(context.schema, state.where)
	const create = validateCreate(context.schema, data.create as any)
	const ops: AnyUpdateOp[] = []
	if ('update' in data) {
		const validated = validateUpdate(context.schema, data.update as any)
		const plainValues: Record<string, unknown> = {}
		for (const [key, value] of Object.entries(validated)) {
			if (isUpdateOp(value)) {
				ops.push(value)
			} else {
				plainValues[key] = value
			}
		}
		if (Object.keys(plainValues).length > 0) {
			ops.unshift(new SetOp(plainValues))
		}
	}
	if (ops.length > 0) {
		validateUpsertConflicts(context.schema, data.create as Record<string, unknown>, ops)
	}
	const row = await context.use.upsertOne(state.where, create as any, ops)
	return (await context.shapeOneRow(state.select, state.preloads, row)) as SelectedWithPreloads<S, Sel, P>
}

export async function runOneDelete<S extends AnySchema, Sel extends string, P extends readonly AnyPreloadDef[]>(
	context: SchemaContext<S>,
	state: { where: FilterGroup; select: readonly Sel[] | undefined; preloads: P },
): Promise<SelectedWithPreloads<S, Sel, P> | null> {
	assertNormalisedFilter(context.schema, state.where)
	const row = await context.use.deleteOne(state.where)
	return context.shapeOneRow(state.select, state.preloads, row)
}

export async function runAllDelete<S extends AnySchema, Sel extends string, P extends readonly AnyPreloadDef[]>(
	context: SchemaContext<S>,
	state: { where: FilterGroup; select: readonly Sel[] | undefined; preloads: P },
): Promise<SelectedWithPreloads<S, Sel, P>[]> {
	assertNormalisedFilter(context.schema, state.where)
	const rows = await context.use.deleteMany(state.where)
	return context.shapeRows(state.select, state.preloads, rows)
}

export async function runAggregate<S extends AnySchema>(
	context: SchemaContext<S>,
	spec: AggregateSpec,
): Promise<Array<Record<string, unknown>>> {
	assertNormalisedAggregate(context.schema, context.use, spec)
	return context.use.aggregate(spec)
}
