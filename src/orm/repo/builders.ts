import type { InferRawArgs, InferRawReturn } from '../adapter.js'
import type { OrmUse } from '../adapters/base.js'
import { OrmNotFoundError, type OrmNotFoundOperation } from '../errors/index.js'
import { toFieldName, type AnyField, type Field } from '../fields.js'
import { FilterGroup, type FilterFactory } from '../filter.js'
import type { AggregateSpec } from '../orm-adapter.js'
import { OrderBy, type IterationOptions } from '../query-options.js'
import type { AnyPreloadDef } from '../relations.js'
import type { SchemaCreateInput, SchemaUpdateInput } from '../schema-validations.js'
import type { AnySchema, SchemaOutput } from '../schema.js'
import { applyComputedSelection, planSelection } from './internals/computeds.js'
import {
	runAggregate,
	runAllCount,
	runAllCreate,
	runAllDelete,
	runAllIterate,
	runAllPaginate,
	runAllRead,
	runAllUpdate,
	runOneCreate,
	runOneDelete,
	runOneRead,
	runOneUpdate,
	runOneUpsert,
} from './internals/executors.js'
import { resolvePreloads } from './internals/preloads.js'
import type { ReadLimitSource, ReadOffsetSource } from './internals/query-shape.js'
import type { Paginated, SelectedWithPreloads } from './internals/types.js'

export type { Paginated }

type MaybeNull<T, Req extends boolean> = Req extends true ? T : T | null
type SchemaPrimaryKeyValue<S extends AnySchema> = SchemaOutput<S>[S['pkField']['name'] & keyof SchemaOutput<S>]
export type UpsertInput<S extends AnySchema> =
	{ create: SchemaCreateInput<S> } | { create: SchemaCreateInput<S>; update: SchemaUpdateInput<S> }
type ReadState<Sel extends string, P extends readonly AnyPreloadDef[] = readonly AnyPreloadDef[]> = {
	where?: FilterGroup
	select?: readonly Sel[]
	preloads?: P
}

export type HasMethod<A, Method extends string> = Method extends keyof A
	? A[Method] extends (...args: any) => any
		? true
		: false
	: false

export type OneBuilderSurface<
	S extends AnySchema,
	A = unknown,
	Sel extends string = never,
	P extends readonly AnyPreloadDef[] = [],
	Req extends boolean = false,
> = OneBuilder<S, A, Sel, P, Req> &
	(HasMethod<A, 'updateMany'> extends true ? {} : { update: never }) &
	(HasMethod<A, 'deleteMany'> extends true ? {} : { delete: never }) &
	(HasMethod<A, 'upsertOne'> extends true ? {} : { upsert: never })

export type AllBuilderSurface<
	S extends AnySchema,
	A = unknown,
	Sel extends string = never,
	P extends readonly AnyPreloadDef[] = [],
> = AllBuilder<S, A, Sel, P> &
	(HasMethod<A, 'iterateMany'> extends true ? {} : { iterate: never }) &
	(HasMethod<A, 'updateMany'> extends true ? {} : { update: never }) &
	(HasMethod<A, 'deleteMany'> extends true ? {} : { delete: never }) &
	(HasMethod<A, 'count'> extends true ? {} : { count: never }) &
	([HasMethod<A, 'findMany'>, HasMethod<A, 'count'>] extends [true, true] ? {} : { paginate: never })

type HasNonEmptyAggregateOps<A> = A extends { aggregateOps: readonly [any, ...any[]] } ? true : false

export type SchemaRefSurface<S extends AnySchema, A = unknown> = Omit<SchemaRef<S, A>, 'raw' | 'aggregate'> &
	(HasMethod<A, 'raw'> extends true
		? { raw: <T = InferRawReturn<A>>(...args: InferRawArgs<A>) => Promise<T> }
		: { raw: never }) &
	([HasMethod<A, 'aggregate'>, HasNonEmptyAggregateOps<A>] extends [true, true]
		? { aggregate: SchemaRef<S, A>['aggregate'] }
		: { aggregate: never })

type ReadBuilderFor<
	TBuilder,
	S extends AnySchema,
	A,
	Sel extends string,
	P extends readonly AnyPreloadDef[],
> = TBuilder extends {
	_builderKind: 'one'
	_req: infer Req extends boolean
}
	? OneBuilderSurface<S, A, Sel, P, Req>
	: TBuilder extends { _builderKind: 'all' }
		? AllBuilderSurface<S, A, Sel, P>
		: never

export class SchemaContext<S extends AnySchema> {
	constructor(
		readonly schema: S,
		private readonly getUse: (target: AnySchema) => OrmUse,
	) {}

	async shapeRows<Sel extends string, P extends readonly AnyPreloadDef[]>(
		select: readonly Sel[] | undefined,
		preloads: P,
		rows: Record<string, unknown>[],
	): Promise<SelectedWithPreloads<S, Sel, P>[]> {
		const plan = planSelection(this.schema, select)
		const selected = applyComputedSelection(this.schema, rows, plan)
		if (preloads.length === 0) return selected as SelectedWithPreloads<S, Sel, P>[]
		return (await resolvePreloads(selected, preloads, this.getUse)) as SelectedWithPreloads<S, Sel, P>[]
	}

	async shapeOneRow<Sel extends string, P extends readonly AnyPreloadDef[]>(
		select: readonly Sel[] | undefined,
		preloads: P,
		row: Record<string, unknown> | null,
	): Promise<SelectedWithPreloads<S, Sel, P> | null> {
		if (!row) return null
		const [resolved] = await this.shapeRows(select, preloads, [row])
		return resolved ?? null
	}

	get use() {
		return this.getUse(this.schema)
	}
}

abstract class ReadSelectState<
	S extends AnySchema,
	A = unknown,
	Sel extends string = never,
	P extends readonly AnyPreloadDef[] = [],
> {
	protected readonly _context: SchemaContext<S>
	protected _where: FilterGroup
	protected _select: readonly Sel[] | undefined
	protected _preloads: P

	constructor(context: SchemaContext<S>, state?: ReadState<Sel, P>) {
		this._context = context
		this._where = state?.where ? state.where.clone() : FilterGroup.create()
		this._select = state?.select
		this._preloads = state?.preloads ?? ([] as unknown as P)
	}

	where(factory: FilterFactory): this {
		const nextGroup = factory(this._where.clone())
		return this._clone<Sel, P>({
			where: nextGroup,
			select: this._select as readonly Sel[] | undefined,
			preloads: this._preloads,
		}) as unknown as this
	}

	select<NewSel extends keyof SchemaOutput<S> & string>(
		fields: readonly NewSel[],
	): ReadBuilderFor<this, S, A, NewSel, P> {
		return this._clone<NewSel, P>({ select: fields })
	}

	preload<NewP extends readonly AnyPreloadDef[]>(defs: NewP): ReadBuilderFor<this, S, A, Sel, NewP> {
		return this._clone<Sel, NewP>({ preloads: defs })
	}

	protected _readState<NewSel extends string = Sel, NewP extends readonly AnyPreloadDef[] = P>(
		next: ReadState<NewSel, NewP> = {} as ReadState<NewSel, NewP>,
	): ReadState<NewSel, NewP> {
		return {
			where: next.where ?? this._where.clone(),
			select: next.select ?? (this._select as unknown as NewSel[]),
			preloads: next.preloads ?? ([...this._preloads] as unknown as NewP),
		}
	}

	protected abstract _clone<NewSel extends string, NewP extends readonly AnyPreloadDef[]>(
		_next: ReadState<NewSel, NewP>,
	): ReadBuilderFor<this, S, A, NewSel, NewP>
}

export class SchemaRef<S extends AnySchema, A = unknown> {
	readonly #context: SchemaContext<S>

	constructor(context: SchemaContext<S>) {
		this.#context = context
	}

	one(): OneBuilderSurface<S, A, never, []> {
		return new OneBuilder<S, A, never, []>(this.#context) as OneBuilderSurface<S, A, never, []>
	}

	all(): AllBuilderSurface<S, A, never, []> {
		return new AllBuilder<S, A, never, []>(this.#context) as AllBuilderSurface<S, A, never, []>
	}

	aggregate(): AggregateBuilder<S, A, {}, {}, false, false, false> {
		return new AggregateBuilder<S, A, {}, {}, false, false, false>(this.#context)
	}

	raw(...args: any[]) {
		return this.#context.use.raw(...args)
	}
}

export class OneBuilder<
	S extends AnySchema,
	A = unknown,
	Sel extends string = never,
	P extends readonly AnyPreloadDef[] = [],
	Req extends boolean = false,
> extends ReadSelectState<S, A, Sel, P> {
	declare readonly _builderKind: 'one'
	declare readonly _req: Req

	protected _required: boolean
	protected _requiredMessage: string | undefined

	constructor(
		context: SchemaContext<S>,
		state?: ReadState<Sel, P>,
		reqState?: { required: boolean; message?: string },
	) {
		super(context, state)
		this._required = reqState?.required ?? false
		this._requiredMessage = reqState?.message
	}

	id(value: SchemaPrimaryKeyValue<S>): this {
		const nextGroup = this._where.clone().eq(this._context.schema.pkField, value)
		return this._clone<Sel, P>({
			where: nextGroup,
			select: this._select as readonly Sel[] | undefined,
			preloads: this._preloads,
		}) as this
	}

	required(this: OneBuilder<S, A, Sel, P, false>, message?: string): OneBuilderSurface<S, A, Sel, P, true> {
		return new OneBuilder<S, A, Sel, P, true>(this._context, this._readState(), {
			required: true,
			message,
		}) as OneBuilderSurface<S, A, Sel, P, true>
	}

	private _assertFound(result: unknown, operation: OrmNotFoundOperation): void {
		if (this._required && result === null) {
			throw new OrmNotFoundError({
				schema: this._context.schema.name,
				operation,
				where: this._where,
				message: this._requiredMessage,
			})
		}
	}

	protected _clone<NewSel extends string, NewP extends readonly AnyPreloadDef[]>(next: ReadState<NewSel, NewP>) {
		return new OneBuilder<S, A, NewSel, NewP, Req>(this._context, this._readState(next), {
			required: this._required,
			message: this._requiredMessage,
		}) as any
	}

	create(data: SchemaCreateInput<S>) {
		return runOneCreate(
			this._context,
			{
				select: this._select,
				preloads: this._preloads,
			},
			data,
		)
	}

	async update(data: SchemaUpdateInput<S>): Promise<MaybeNull<SelectedWithPreloads<S, Sel, P>, Req>> {
		const result = await runOneUpdate(
			this._context,
			{
				where: this._where,
				select: this._select,
				preloads: this._preloads,
			},
			data,
		)
		this._assertFound(result, 'updateOne')
		return result as any
	}

	upsert(data: UpsertInput<S>) {
		return runOneUpsert(
			this._context,
			{
				where: this._where,
				select: this._select,
				preloads: this._preloads,
			},
			data,
		)
	}

	async delete(): Promise<MaybeNull<SelectedWithPreloads<S, Sel, P>, Req>> {
		const result = await runOneDelete(this._context, {
			where: this._where,
			select: this._select,
			preloads: this._preloads,
		})
		this._assertFound(result, 'deleteOne')
		return result as any
	}

	async find(): Promise<MaybeNull<SelectedWithPreloads<S, Sel, P>, Req>> {
		const result = await runOneRead(this._context, {
			where: this._where,
			select: this._select,
			preloads: this._preloads,
		})
		this._assertFound(result, 'findOne')
		return result as any
	}
}

export class AllBuilder<
	S extends AnySchema,
	A = unknown,
	Sel extends string = never,
	P extends readonly AnyPreloadDef[] = [],
> extends ReadSelectState<S, A, Sel, P> {
	declare readonly _builderKind: 'all'

	#orderBy: OrderBy[]
	#limitSource: ReadLimitSource | undefined
	#offsetSource: ReadOffsetSource | undefined

	constructor(
		context: SchemaContext<S>,
		state?: ReadState<Sel, P>,
		queryState?: { orderBy?: OrderBy[]; limitSource?: ReadLimitSource; offsetSource?: ReadOffsetSource },
	) {
		super(context, state)
		this.#orderBy = queryState?.orderBy ?? []
		this.#limitSource = queryState?.limitSource
		this.#offsetSource = queryState?.offsetSource
	}

	#withQuery(
		queryOverride: Partial<{ orderBy: OrderBy[]; limitSource: ReadLimitSource; offsetSource: ReadOffsetSource }>,
	) {
		const has = (key: keyof typeof queryOverride) => Object.prototype.hasOwnProperty.call(queryOverride, key)
		return new AllBuilder<S, A, Sel, P>(this._context, this._readState(), {
			orderBy: has('orderBy') ? queryOverride.orderBy : [...this.#orderBy],
			limitSource: has('limitSource') ? queryOverride.limitSource : this.#limitSource,
			offsetSource: has('offsetSource') ? queryOverride.offsetSource : this.#offsetSource,
		}) as this
	}

	protected _clone<NewSel extends string, NewP extends readonly AnyPreloadDef[]>(next: ReadState<NewSel, NewP>) {
		return new AllBuilder<S, A, NewSel, NewP>(
			this._context,
			this._readState({
				where: next.where,
				select: next.select,
				preloads: next.preloads,
			}),
			{ orderBy: [...this.#orderBy], limitSource: this.#limitSource, offsetSource: this.#offsetSource },
		) as any
	}

	orderBy(field: string | AnyField, direction: 'asc' | 'desc' = 'asc') {
		return this.#withQuery({ orderBy: [...this.#orderBy, new OrderBy(field, direction)] })
	}

	limit(limit: number) {
		return this.#withQuery({ limitSource: { value: limit } })
	}

	offset(offset: number) {
		return this.#withQuery({ offsetSource: { kind: 'offset', value: offset } })
	}

	page(page: number) {
		return this.#withQuery({ offsetSource: { kind: 'page', value: page } })
	}

	create(data: SchemaCreateInput<S>[]) {
		return runAllCreate(
			this._context,
			{
				select: this._select,
				preloads: this._preloads,
			},
			data,
		)
	}

	update(data: SchemaUpdateInput<S>) {
		return runAllUpdate(
			this._context,
			{
				where: this._where,
				select: this._select,
				preloads: this._preloads,
			},
			data,
		)
	}

	delete() {
		return runAllDelete(this._context, {
			where: this._where,
			select: this._select,
			preloads: this._preloads,
		})
	}

	find() {
		return runAllRead(this._context, {
			where: this._where,
			select: this._select,
			preloads: this._preloads,
			orderBy: this.#orderBy,
			limitSource: this.#limitSource,
			offsetSource: this.#offsetSource,
		})
	}

	count() {
		return runAllCount(this._context, { where: this._where })
	}

	paginate(): Promise<Paginated<SelectedWithPreloads<S, Sel, P>>> {
		return runAllPaginate(this._context, {
			where: this._where,
			select: this._select,
			preloads: this._preloads,
			orderBy: this.#orderBy,
			limitSource: this.#limitSource,
			offsetSource: this.#offsetSource,
		})
	}

	iterate(options?: IterationOptions) {
		return runAllIterate(
			this._context,
			{
				where: this._where,
				select: this._select,
				preloads: this._preloads,
				orderBy: this.#orderBy,
				limitSource: this.#limitSource,
				offsetSource: this.#offsetSource,
			},
			options,
		)
	}
}

type AggregateEntry = AggregateSpec['aggregates'][number]

type FieldsToGroupKeys<F extends readonly AnyField[]> = {
	[E in F[number] as E extends Field<any, infer N> ? N : never]: E extends Field<infer V> ? V : never
}

export class AggregateBuilder<
	S extends AnySchema,
	A = unknown,
	Aggs = {},
	GroupKeys = {},
	HasGroupBy extends boolean = false,
	HasWhere extends boolean = false,
	HasHaving extends boolean = false,
> {
	readonly #context: SchemaContext<S>
	readonly #where: FilterGroup
	readonly #having: FilterGroup
	readonly #aggregates: readonly AggregateEntry[]
	readonly #groupBy: readonly string[]

	constructor(
		context: SchemaContext<S>,
		state?: {
			where?: FilterGroup
			having?: FilterGroup
			aggregates?: readonly AggregateEntry[]
			groupBy?: readonly string[]
		},
	) {
		this.#context = context
		this.#where = state?.where ? state.where.clone() : FilterGroup.create()
		this.#having = state?.having ? state.having.clone() : FilterGroup.create()
		this.#aggregates = state?.aggregates ?? []
		this.#groupBy = state?.groupBy ?? []
	}

	get #state() {
		return { where: this.#where, having: this.#having, aggregates: this.#aggregates, groupBy: this.#groupBy }
	}

	where(
		...args: HasWhere extends true ? [never] : [factory: FilterFactory]
	): AggregateBuilder<S, A, Aggs, GroupKeys, HasGroupBy, true, HasHaving> {
		const factory = args[0] as FilterFactory
		return new AggregateBuilder<S, A, Aggs, GroupKeys, HasGroupBy, true, HasHaving>(this.#context, {
			...this.#state,
			where: factory(this.#where.clone()),
		})
	}

	having(
		...args: HasHaving extends true ? [never] : [factory: FilterFactory]
	): AggregateBuilder<S, A, Aggs, GroupKeys, HasGroupBy, HasWhere, true> {
		const factory = args[0] as FilterFactory
		return new AggregateBuilder<S, A, Aggs, GroupKeys, HasGroupBy, HasWhere, true>(this.#context, {
			...this.#state,
			having: factory(this.#having.clone()),
		})
	}

	groupBy<F extends readonly Field<string | number | boolean | Date>[]>(
		...fields: HasGroupBy extends true ? [never] : [...F]
	): AggregateBuilder<S, A, Aggs, GroupKeys & FieldsToGroupKeys<F>, true, HasWhere, HasHaving> {
		return new AggregateBuilder<S, A, Aggs, GroupKeys & FieldsToGroupKeys<F>, true, HasWhere, HasHaving>(
			this.#context,
			{
				...this.#state,
				groupBy: (fields as readonly AnyField[]).map((f) => toFieldName(f)),
			},
		)
	}

	count<K extends string>(
		...[alias]: K extends keyof Aggs ? [never] : [alias: K]
	): AggregateBuilder<S, A, Aggs & Record<K, number>, GroupKeys, HasGroupBy, HasWhere, HasHaving> {
		return new AggregateBuilder<S, A, Aggs & Record<K, number>, GroupKeys, HasGroupBy, HasWhere, HasHaving>(
			this.#context,
			{
				...this.#state,
				aggregates: [...this.#aggregates, { fn: 'count', alias: alias as string }],
			},
		)
	}

	countDistinct<K extends string>(
		field: AnyField,
		...[alias]: K extends keyof Aggs ? [never] : [alias: K]
	): AggregateBuilder<S, A, Aggs & Record<K, number>, GroupKeys, HasGroupBy, HasWhere, HasHaving> {
		return new AggregateBuilder<S, A, Aggs & Record<K, number>, GroupKeys, HasGroupBy, HasWhere, HasHaving>(
			this.#context,
			{
				...this.#state,
				aggregates: [
					...this.#aggregates,
					{ fn: 'countDistinct', field: toFieldName(field), alias: alias as string },
				],
			},
		)
	}

	sum<K extends string>(
		field: Field<number>,
		...[alias]: K extends keyof Aggs ? [never] : [alias: K]
	): AggregateBuilder<S, A, Aggs & Record<K, number>, GroupKeys, HasGroupBy, HasWhere, HasHaving> {
		return new AggregateBuilder<S, A, Aggs & Record<K, number>, GroupKeys, HasGroupBy, HasWhere, HasHaving>(
			this.#context,
			{
				...this.#state,
				aggregates: [...this.#aggregates, { fn: 'sum', field: toFieldName(field), alias: alias as string }],
			},
		)
	}

	avg<K extends string>(
		field: Field<number>,
		...[alias]: K extends keyof Aggs ? [never] : [alias: K]
	): AggregateBuilder<S, A, Aggs & Record<K, number>, GroupKeys, HasGroupBy, HasWhere, HasHaving> {
		return new AggregateBuilder<S, A, Aggs & Record<K, number>, GroupKeys, HasGroupBy, HasWhere, HasHaving>(
			this.#context,
			{
				...this.#state,
				aggregates: [...this.#aggregates, { fn: 'avg', field: toFieldName(field), alias: alias as string }],
			},
		)
	}

	min<F extends Field<number | string | Date>, K extends string>(
		field: F,
		...[alias]: K extends keyof Aggs ? [never] : [alias: K]
	): AggregateBuilder<
		S,
		A,
		Aggs & Record<K, F extends Field<infer V> ? V : never>,
		GroupKeys,
		HasGroupBy,
		HasWhere,
		HasHaving
	> {
		return new AggregateBuilder<
			S,
			A,
			Aggs & Record<K, F extends Field<infer V> ? V : never>,
			GroupKeys,
			HasGroupBy,
			HasWhere,
			HasHaving
		>(this.#context, {
			...this.#state,
			aggregates: [...this.#aggregates, { fn: 'min', field: toFieldName(field), alias: alias as string }],
		})
	}

	max<F extends Field<number | string | Date>, K extends string>(
		field: F,
		...[alias]: K extends keyof Aggs ? [never] : [alias: K]
	): AggregateBuilder<
		S,
		A,
		Aggs & Record<K, F extends Field<infer V> ? V : never>,
		GroupKeys,
		HasGroupBy,
		HasWhere,
		HasHaving
	> {
		return new AggregateBuilder<
			S,
			A,
			Aggs & Record<K, F extends Field<infer V> ? V : never>,
			GroupKeys,
			HasGroupBy,
			HasWhere,
			HasHaving
		>(this.#context, {
			...this.#state,
			aggregates: [...this.#aggregates, { fn: 'max', field: toFieldName(field), alias: alias as string }],
		})
	}

	async run(
		..._: [keyof Aggs] extends [never] ? [never] : []
	): Promise<HasGroupBy extends true ? (Aggs & GroupKeys)[] : Aggs> {
		const spec: AggregateSpec = {
			aggregates: this.#aggregates,
			groupBy: this.#groupBy,
		}
		if (this.#where.children.length > 0) {
			spec.where = this.#where
		}
		if (this.#having.children.length > 0) {
			spec.having = this.#having
		}
		const rows = await runAggregate(this.#context, spec)
		if (this.#groupBy.length > 0) {
			return rows as any
		}
		return rows[0] as any
	}
}

if (import.meta.vitest) {
	const { describe, test, expect, expectTypeOf, beforeEach, vi } = import.meta.vitest
	const { v } = await import('valleyed')
	const { InMemoryAdapter } = await import('../adapters/in-memory/index.js')
	const { OrmValidationError } = await import('../errors/index.js')
	const { OrmAdapter } = await import('../orm-adapter.js')
	const { Relations } = await import('../relations.js')
	const { Repo } = await import('./repo.js')
	const { Schema } = await import('../schema.js')

	describe('builders', () => {
		let repo: any
		beforeEach(() => {
			const adapter = InMemoryAdapter.create({})
			repo = Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()
		})

		test('update() executes and returns updated row', async () => {
			const UserSchema = Schema.from('users')
				.pk('id', v.string(), () => `u-${Math.random().toString(36).slice(2, 8)}`)
				.field('email', v.string())
				.field('name', v.string())
				.build()

			const created = await repo.on(UserSchema).one().create({ email: 'up@test.com', name: 'Before' })
			const updated = await repo.on(UserSchema).one().id(created.id).update({ name: 'After' })
			expect(updated?.name).toBe('After')
			const found = await repo.on(UserSchema).one().id(created.id).find()
			expect(found?.name).toBe('After')
		})

		test('find() returns rows', async () => {
			const UserSchema = Schema.from('users')
				.pk('id', v.string(), () => `u-${Math.random().toString(36).slice(2, 8)}`)
				.field('email', v.string())
				.field('name', v.string())
				.build()

			await repo
				.on(UserSchema)
				.all()
				.create([
					{ email: 'a@x.com', name: 'Alice' },
					{ email: 'b@x.com', name: 'Bob' },
				])

			const rows = await repo
				.on(UserSchema)
				.all()
				.where((q) => q.or([(g) => g.eq('name', 'Alice'), (g) => g.eq('name', 'Bob')]))
				.find()
			expect(rows).toHaveLength(2)
		})

		test('write branches do not leak filters', async () => {
			const UserSchema = Schema.from('users')
				.pk('id', v.string(), () => `u-${Math.random().toString(36).slice(2, 8)}`)
				.field('email', v.string())
				.field('name', v.string())
				.build()

			await repo
				.on(UserSchema)
				.all()
				.create([
					{ email: 'alice@x.com', name: 'Alice' },
					{ email: 'bob@x.com', name: 'Bob' },
				])

			const base = repo.on(UserSchema).all()
			await base.where((q) => q.eq('name', 'Alice')).update({ name: 'A Updated' })
			await base.where((q) => q.eq('name', 'Bob')).update({ name: 'B Updated' })

			const all = await repo.on(UserSchema).all().orderBy('name', 'asc').find()
			expect(all.map((r) => r.name)).toEqual(['A Updated', 'B Updated'])
		})
	})

	describe('.required() modifier', () => {
		const UserSchema = Schema.from('users')
			.pk('id', v.string(), () => `u-${Math.random().toString(36).slice(2, 8)}`)
			.field('email', v.string())
			.field('name', v.string())
			.build()

		let repo: any
		beforeEach(() => {
			const adapter = InMemoryAdapter.create({})
			repo = Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()
		})

		describe('type narrowing', () => {
			type IsExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
			type TestA = {
				findOne: (...a: any[]) => any
				createOne: (...a: any[]) => any
				createMany: (...a: any[]) => any
				updateMany: (...a: any[]) => any
				deleteMany: (...a: any[]) => any
				upsertOne: (...a: any[]) => any
				findMany: (...a: any[]) => any
				deleteOne: (...a: any[]) => any
				updateOne: (...a: any[]) => any
			}
			type S = typeof UserSchema
			type Result = import('./internals/types.js').SelectedWithPreloads<S, never, []>
			type NameOnly = import('./internals/types.js').SelectedWithPreloads<S, 'name', []>

			test('find() returns T | null without .required()', () => {
				type R = ReturnType<OneBuilderSurface<S, TestA, never, [], false>['find']>
				const _: IsExact<R, Promise<Result | null>> = true
				void _
			})

			test('find() returns T with .required()', () => {
				type R = ReturnType<OneBuilderSurface<S, TestA, never, [], true>['find']>
				const _: IsExact<R, Promise<Result>> = true
				void _
			})

			test('update() returns T with .required()', () => {
				type R = ReturnType<OneBuilderSurface<S, TestA, never, [], true>['update']>
				const _: IsExact<R, Promise<Result>> = true
				void _
			})

			test('delete() returns T with .required()', () => {
				type R = ReturnType<OneBuilderSurface<S, TestA, never, [], true>['delete']>
				const _: IsExact<R, Promise<Result>> = true
				void _
			})

			test('create() return type unchanged regardless of Req', () => {
				type WithReq = ReturnType<OneBuilderSurface<S, TestA, never, [], true>['create']>
				type WithoutReq = ReturnType<OneBuilderSurface<S, TestA, never, [], false>['create']>
				const _: IsExact<WithReq, WithoutReq> = true
				void _
			})

			test('.required() preserves Req through select()', () => {
				type R = ReturnType<OneBuilderSurface<S, TestA, 'name', [], true>['find']>
				const _: IsExact<R, Promise<NameOnly>> = true
				void _
			})

			test('.required() once-per-step: Req=true surface has uncallable required()', () => {
				type ReqBuilder = OneBuilderSurface<S, TestA, never, [], true>
				type RequiredMethod = ReqBuilder['required']
				type ThisParam = ThisParameterType<RequiredMethod>
				type _check = ThisParam extends OneBuilder<S, TestA, never, [], false> ? true : false
				const _: _check = true
				void _
			})
		})

		describe('runtime throw behaviour', () => {
			test('.required().find() throws OrmNotFoundError when no row matched', async () => {
				await expect(repo.on(UserSchema).one().required().id('nonexistent').find()).rejects.toThrow(
					OrmNotFoundError,
				)
			})

			test('.required().update() throws OrmNotFoundError when no row matched', async () => {
				await expect(
					repo.on(UserSchema).one().required().id('nonexistent').update({ name: 'X' }),
				).rejects.toThrow(OrmNotFoundError)
			})

			test('.required().delete() throws OrmNotFoundError when no row matched', async () => {
				await expect(repo.on(UserSchema).one().required().id('nonexistent').delete()).rejects.toThrow(
					OrmNotFoundError,
				)
			})

			test('thrown error carries schema, operation, and where', async () => {
				try {
					await repo.on(UserSchema).one().required().id('u-abc').find()
					expect.unreachable('should have thrown')
				} catch (e) {
					expect(e).toBeInstanceOf(OrmNotFoundError)
					const err = e as InstanceType<typeof OrmNotFoundError>
					expect(err.schema).toBe('users')
					expect(err.operation).toBe('findOne')
					expect(err.where).toBeInstanceOf(FilterGroup)
				}
			})

			test('update throws with operation updateOne', async () => {
				try {
					await repo.on(UserSchema).one().required().id('u-abc').update({ name: 'X' })
					expect.unreachable('should have thrown')
				} catch (e) {
					expect((e as any).operation).toBe('updateOne')
				}
			})

			test('delete throws with operation deleteOne', async () => {
				try {
					await repo.on(UserSchema).one().required().id('u-abc').delete()
					expect.unreachable('should have thrown')
				} catch (e) {
					expect((e as any).operation).toBe('deleteOne')
				}
			})
		})

		describe('no throw when row exists', () => {
			test('.required().find() returns the row when found', async () => {
				const created = await repo.on(UserSchema).one().create({ email: 'a@b.com', name: 'A' })
				const found = await repo.on(UserSchema).one().required().id(created.id).find()
				expect(found.name).toBe('A')
			})

			test('.required().update() returns the updated row', async () => {
				const created = await repo.on(UserSchema).one().create({ email: 'a@b.com', name: 'A' })
				const updated = await repo.on(UserSchema).one().required().id(created.id).update({ name: 'B' })
				expect(updated.name).toBe('B')
			})

			test('.required().delete() returns the deleted row', async () => {
				const created = await repo.on(UserSchema).one().create({ email: 'a@b.com', name: 'A' })
				const deleted = await repo.on(UserSchema).one().required().id(created.id).delete()
				expect(deleted.name).toBe('A')
			})
		})

		describe('custom message', () => {
			test('.required(message) uses custom message on throw', async () => {
				try {
					await repo.on(UserSchema).one().required('user must exist').id('u-abc').find()
					expect.unreachable('should have thrown')
				} catch (e) {
					expect((e as any).message).toBe('user must exist')
				}
			})

			test('default message for PK-keyed chain', async () => {
				try {
					await repo.on(UserSchema).one().required().id('u-abc').find()
					expect.unreachable('should have thrown')
				} catch (e) {
					expect((e as any).message).toBe('users.findOne: no row matched id=u-abc')
				}
			})
		})

		describe('default behaviour preserved', () => {
			test('find() returns null without .required()', async () => {
				const result = await repo.on(UserSchema).one().id('nonexistent').find()
				expect(result).toBeNull()
			})

			test('update() returns null without .required()', async () => {
				const result = await repo.on(UserSchema).one().id('nonexistent').update({ name: 'X' })
				expect(result).toBeNull()
			})

			test('delete() returns null without .required()', async () => {
				const result = await repo.on(UserSchema).one().id('nonexistent').delete()
				expect(result).toBeNull()
			})
		})

		describe('runtime no-op for create/upsert', () => {
			test('.required() before create() returns the created row', async () => {
				const created = await repo.on(UserSchema).one().required().create({ email: 'x@y.com', name: 'X' })
				expect(created.email).toBe('x@y.com')
				expect(created.name).toBe('X')
			})

			test('.required() before upsert() returns the upserted row', async () => {
				const upserted = await repo
					.on(UserSchema)
					.one()
					.required()
					.where((q: any) => q.eq('email', 'x@y.com'))
					.upsert({ create: { email: 'x@y.com', name: 'X' } })
				expect(upserted.email).toBe('x@y.com')
				expect(upserted.name).toBe('X')
			})
		})
	})

	describe('read query-shape validation and page state', () => {
		let itemCounter = 0
		let userCounter = 0
		let postCounter = 0

		const ItemSchema = Schema.from('paged_items')
			.pk('id', v.string(), () => `item-${++itemCounter}`)
			.field('position', v.number())
			.field('name', v.string())
			.build()

		const UserSchema = Schema.from('query_shape_users')
			.pk('id', v.string(), () => `user-${++userCounter}`)
			.field('name', v.string())
			.build()

		const PostSchema = Schema.from('query_shape_posts')
			.pk('id', v.string(), () => `post-${++postCounter}`)
			.field('userId', v.string())
			.field('title', v.string())
			.build()

		const UserRels = Relations.from(UserSchema).hasMany('posts', PostSchema.fields.userId).build()
		const PostRels = Relations.from(PostSchema).belongsTo('author', PostSchema.fields.userId, UserSchema).build()

		function makeRepo() {
			const adapter = InMemoryAdapter.create({})
			return Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()
		}

		async function seedItems(repo: any, count: number) {
			await repo
				.on(ItemSchema)
				.all()
				.create(
					Array.from({ length: count }, (_, index) => ({ position: index + 1, name: `Item ${index + 1}` })),
				)
		}

		function expectQueryShapeError(error: unknown, field?: string) {
			expect(error).toBeInstanceOf(OrmValidationError)
			const err = error as InstanceType<typeof OrmValidationError>
			expect(err.kind).toBe('query-shape')
			if (field) expect(err.failures.some((failure) => failure.field === field)).toBe(true)
		}

		test('.page(n) is 1-based offset sugar for .find()', async () => {
			const repo = makeRepo()
			await seedItems(repo, 10)

			const rows = await repo.on(ItemSchema).all().orderBy('position', 'asc').limit(3).page(2).find()

			expect(rows.map((row) => row.position)).toEqual([4, 5, 6])
		})

		test('.page(2).limit(50).find() uses the final effective limit for offset', async () => {
			const repo = makeRepo()
			await seedItems(repo, 125)

			const rows = await repo.on(ItemSchema).all().orderBy('position', 'asc').page(2).limit(50).find()

			expect(rows).toHaveLength(50)
			expect(rows[0].position).toBe(51)
			expect(rows.at(-1)?.position).toBe(100)
		})

		test('duplicate .limit(...) calls keep last-wins behavior', async () => {
			const repo = makeRepo()
			await seedItems(repo, 10)

			const rows = await repo.on(ItemSchema).all().orderBy('position', 'asc').limit(7).limit(3).find()

			expect(rows.map((row) => row.position)).toEqual([1, 2, 3])
		})

		test('.offset(...) and .page(...) are last-source-wins', async () => {
			const repo = makeRepo()
			await seedItems(repo, 20)

			const offsetWins = await repo
				.on(ItemSchema)
				.all()
				.orderBy('position', 'asc')
				.limit(5)
				.page(2)
				.offset(10)
				.find()
			const pageWins = await repo
				.on(ItemSchema)
				.all()
				.orderBy('position', 'asc')
				.limit(5)
				.offset(10)
				.page(2)
				.find()

			expect(offsetWins.map((row) => row.position)).toEqual([11, 12, 13, 14, 15])
			expect(pageWins.map((row) => row.position)).toEqual([6, 7, 8, 9, 10])
		})

		test('invalid page, limit, and offset values fail as query-shape errors at find()', async () => {
			const repo = makeRepo()

			for (const [field, read] of [
				[
					'page',
					() =>
						repo
							.on(ItemSchema)
							.all()
							.page(0 as any)
							.find(),
				],
				[
					'limit',
					() =>
						repo
							.on(ItemSchema)
							.all()
							.limit(0 as any)
							.find(),
				],
				[
					'limit',
					() =>
						repo
							.on(ItemSchema)
							.all()
							.limit(undefined as any)
							.page(2)
							.find(),
				],
				[
					'offset',
					() =>
						repo
							.on(ItemSchema)
							.all()
							.offset(-1 as any)
							.find(),
				],
			] as const) {
				try {
					await read()
					expect.unreachable(`${field} should have failed`)
				} catch (error) {
					expectQueryShapeError(error, field)
				}
			}
		})

		test('unknown selected fields fail as query-shape errors on find reads before rows are loaded', async () => {
			const repo = makeRepo()

			try {
				await repo
					.on(ItemSchema)
					.one()
					.select(['unknownField' as any])
					.find()
				expect.unreachable('one().find() should have failed')
			} catch (error) {
				expectQueryShapeError(error, 'unknownField')
			}

			try {
				await repo
					.on(ItemSchema)
					.all()
					.select(['unknownField' as any])
					.find()
				expect.unreachable('all().find() should have failed')
			} catch (error) {
				expectQueryShapeError(error, 'unknownField')
			}
		})

		test('invalid and coherency-broken preload definitions fail as query-shape errors on find reads', async () => {
			const repo = makeRepo()

			for (const read of [
				() =>
					repo
						.on(UserSchema)
						.all()
						.preload([{ def: {} as any }])
						.find(),
				() => repo.on(UserSchema).all().preload([PostRels.author]).find(),
				() =>
					repo
						.on(UserSchema)
						.all()
						.preload([{ def: UserRels.posts, preloads: [UserRels.posts] }])
						.find(),
			]) {
				try {
					await read()
					expect.unreachable('preload should have failed')
				} catch (error) {
					expectQueryShapeError(error)
				}
			}
		})

		test('orderBy(string) remains an unvalidated raw-string escape hatch', async () => {
			const repo = makeRepo()
			await seedItems(repo, 2)

			const rows = await repo.on(ItemSchema).all().orderBy('missingRawSortField', 'asc').find()

			expect(rows).toHaveLength(2)
		})

		test('page and offset sources require an explicit limit at read terminals', async () => {
			const repo = makeRepo()
			await seedItems(repo, 10)

			for (const [field, read] of [
				['limit', () => repo.on(ItemSchema).all().page(2).find()],
				['limit', () => repo.on(ItemSchema).all().offset(2).find()],
				['limit', () => repo.on(ItemSchema).all().page(2).paginate()],
				[
					'limit',
					async () => {
						for await (const _row of repo.on(ItemSchema).all().page(2).iterate()) {
							expect.unreachable('iterate should fail before yielding rows')
						}
					},
				],
			] as const) {
				try {
					await read()
					expect.unreachable(`${field} should have failed`)
				} catch (error) {
					expectQueryShapeError(error, field)
				}
			}
		})

		test('find() without page, offset, or limit keeps existing flat-array behavior', async () => {
			const repo = makeRepo()
			await seedItems(repo, 12)

			const rows = await repo.on(ItemSchema).all().orderBy('position', 'asc').find()

			expect(rows).toHaveLength(12)
			expect(rows.map((row) => row.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
		})

		test('.paginate() returns a first-page envelope with docs computed from filter-only count', async () => {
			const repo = makeRepo()
			await seedItems(repo, 5)

			const page = await repo.on(ItemSchema).all().orderBy('position', 'asc').limit(2).paginate()

			expect(page.items.map((row) => row.position)).toEqual([1, 2])
			expect(page.docs).toEqual({ limit: 2, total: 5, count: 2 })
			expect(page.pages).toEqual({ current: 1, start: 1, last: 3, previous: null, next: 2 })
		})

		test('.paginate() reports pages.last = 1 for empty result sets', async () => {
			const repo = makeRepo()
			await seedItems(repo, 3)

			const page = await repo
				.on(ItemSchema)
				.all()
				.where((q) => q.eq('name', 'missing'))
				.limit(5)
				.paginate()

			expect(page.items).toEqual([])
			expect(page.docs).toEqual({ limit: 5, total: 0, count: 0 })
			expect(page.pages).toEqual({ current: 1, start: 1, last: 1, previous: null, next: null })
		})

		test('.paginate() preserves the previous neighbor on the last real page', async () => {
			const repo = makeRepo()
			await seedItems(repo, 5)

			const page = await repo.on(ItemSchema).all().orderBy('position', 'asc').limit(2).page(3).paginate()

			expect(page.items.map((row) => row.position)).toEqual([5])
			expect(page.docs).toEqual({ limit: 2, total: 5, count: 1 })
			expect(page.pages).toEqual({ current: 3, start: 1, last: 3, previous: 2, next: null })
		})

		test('.paginate() preserves past-last page requests with no navigation neighbors', async () => {
			const repo = makeRepo()
			await seedItems(repo, 5)

			const page = await repo.on(ItemSchema).all().orderBy('position', 'asc').limit(2).page(4).paginate()

			expect(page.items).toEqual([])
			expect(page.docs).toEqual({ limit: 2, total: 5, count: 0 })
			expect(page.pages).toEqual({ current: 4, start: 1, last: 3, previous: null, next: null })
		})

		test('.paginate() does not require orderBy', async () => {
			const repo = makeRepo()
			await seedItems(repo, 3)

			const page = await repo.on(ItemSchema).all().limit(2).paginate()

			expect(page.items).toHaveLength(2)
			expect(page.docs).toEqual({ limit: 2, total: 3, count: 2 })
			expect(page.pages).toEqual({ current: 1, start: 1, last: 2, previous: null, next: 2 })
		})

		test('.paginate() without an explicit limit returns all matches in a single-page envelope', async () => {
			const repo = makeRepo()
			await seedItems(repo, 101)

			const page = await repo.on(ItemSchema).all().orderBy('position', 'asc').paginate()

			expect(page.items).toHaveLength(101)
			expect(page.items[0].position).toBe(1)
			expect(page.items.at(-1)?.position).toBe(101)
			expect(page.docs).toEqual({ limit: 101, total: 101, count: 101 })
			expect(page.pages).toEqual({ current: 1, start: 1, last: 1, previous: null, next: null })
		})

		test('.paginate() without an explicit limit reports zero limit for empty result sets', async () => {
			const repo = makeRepo()
			await seedItems(repo, 3)

			const page = await repo
				.on(ItemSchema)
				.all()
				.where((q) => q.eq('name', 'missing'))
				.paginate()

			expect(page.items).toEqual([])
			expect(page.docs).toEqual({ limit: 0, total: 0, count: 0 })
			expect(page.pages).toEqual({ current: 1, start: 1, last: 1, previous: null, next: null })
		})

		test('.paginate() counts only the filter while page items honor limit and offset', async () => {
			const repo = makeRepo()
			await repo
				.on(ItemSchema)
				.all()
				.create([
					{ position: 1, name: 'keep' },
					{ position: 2, name: 'drop' },
					{ position: 3, name: 'keep' },
					{ position: 4, name: 'keep' },
				])

			const page = await repo
				.on(ItemSchema)
				.all()
				.where((q) => q.eq('name', 'keep'))
				.orderBy('position', 'asc')
				.limit(1)
				.page(2)
				.paginate()

			expect(page.items.map((row) => row.position)).toEqual([3])
			expect(page.docs).toEqual({ limit: 1, total: 3, count: 1 })
			expect(page.pages).toEqual({ current: 2, start: 1, last: 3, previous: 1, next: 3 })
		})

		test('.paginate() starts item and count reads in parallel after query-shape validation and config resolution', async () => {
			const adapter = InMemoryAdapter.create({})
			const origUse = adapter.use.bind(adapter)
			const events: string[] = []
			;(adapter as any).use = vi.fn((schema: AnySchema, config: any) => {
				const use = origUse(schema, config)
				return {
					...use,
					findMany: async (...args: any[]) => {
						events.push('findMany:start')
						await Promise.resolve()
						events.push('findMany:end')
						return use.findMany(...(args as [any, any]))
					},
					count: async (...args: any[]) => {
						events.push('count:start')
						await Promise.resolve()
						events.push('count:end')
						return use.count(...(args as [any]))
					},
				}
			})
			const repo = Repo.from(adapter)
				.resolve((name) => {
					events.push('resolve')
					return { table: name }
				})
				.build()
			await seedItems(repo, 3)
			events.length = 0

			const page = await repo
				.on(ItemSchema)
				.all()
				.where((q) => q.eq('name', 'Item 1'))
				.limit(1)
				.paginate()

			expect(events[0]).toBe('resolve')
			expect(events).toContain('count:start')
			expect(events).toContain('findMany:end')
			expect(events.indexOf('count:start')).toBeLessThan(events.indexOf('findMany:end'))
			expect(page.items.map((row) => row.position)).toEqual([1])
			expect(page.docs).toEqual({ limit: 1, total: 1, count: 1 })
		})

		test('.paginate() items preserve selected row shape', async () => {
			const repo = makeRepo()
			await seedItems(repo, 2)

			const page = await repo.on(ItemSchema).all().orderBy('position', 'asc').select(['name']).limit(1).paginate()

			expect(page.items).toEqual([{ name: 'Item 1' }])
			expect(page.docs).toMatchObject({ total: 2, count: 1 })
		})

		test('.paginate() items preserve preloaded row shape', async () => {
			const repo = makeRepo()
			const alice = await repo.on(UserSchema).one().create({ name: 'Alice' })
			const bob = await repo.on(UserSchema).one().create({ name: 'Bob' })
			await repo
				.on(PostSchema)
				.all()
				.create([
					{ userId: alice.id, title: 'A1' },
					{ userId: alice.id, title: 'A2' },
					{ userId: bob.id, title: 'B1' },
				])

			const page = await repo
				.on(UserSchema)
				.all()
				.orderBy('name', 'asc')
				.preload([UserRels.posts])
				.limit(1)
				.paginate()

			expect(page.items).toHaveLength(1)
			expect(page.items[0].name).toBe('Alice')
			expect(page.items[0].posts.map((post: any) => post.title)).toEqual(['A1', 'A2'])
			expect(page.docs).toEqual({ limit: 1, total: 2, count: 1 })
		})

		test('.paginate() uses offset-source last-wins and the final effective limit', async () => {
			const repo = makeRepo()
			await seedItems(repo, 10)

			const pageSource = await repo.on(ItemSchema).all().orderBy('position', 'asc').page(2).limit(3).paginate()
			const offsetSource = await repo
				.on(ItemSchema)
				.all()
				.orderBy('position', 'asc')
				.page(2)
				.limit(2)
				.offset(4)
				.paginate()

			expect(pageSource.items.map((row) => row.position)).toEqual([4, 5, 6])
			expect(pageSource.pages.current).toBe(2)
			expect(pageSource.docs.limit).toBe(3)
			expect(offsetSource.items.map((row) => row.position)).toEqual([5, 6])
			expect(offsetSource.pages.current).toBe(3)
			expect(offsetSource.docs.limit).toBe(2)
		})
	})

	describe('type-level: paginate surface', () => {
		const _TestSchema = Schema.from('paginate_type_users')
			.pk('id', v.string(), () => 'x')
			.field('name', v.string())
			.build()
		type S = typeof _TestSchema

		test('Paginated<T> exposes pages, docs, and items', () => {
			type Page = Paginated<{ id: string }>
			expectTypeOf<Page>().toHaveProperty('pages')
			expectTypeOf<Page>().toHaveProperty('docs')
			expectTypeOf<Page>().toHaveProperty('items')
			expectTypeOf<Page['items']>().toEqualTypeOf<{ id: string }[]>()
		})

		test('.paginate() is a no-argument AllBuilder terminal', () => {
			type Adapter = { findMany: (...a: any[]) => any; count: (...a: any[]) => any }
			type All = AllBuilderSurface<S, Adapter>
			type Result = import('./internals/types.js').SelectedWithPreloads<S, never, []>

			expectTypeOf<All['paginate']>().toBeFunction()
			expectTypeOf<Parameters<All['paginate']>>().toEqualTypeOf<[]>()
			expectTypeOf<ReturnType<All['paginate']>>().toEqualTypeOf<Promise<Paginated<Result>>>()
		})

		test('.paginate() exists only on AllBuilder', () => {
			type Adapter = { findMany: (...a: any[]) => any; count: (...a: any[]) => any }
			type One = OneBuilderSurface<S, Adapter>
			type OneHasPaginate = 'paginate' extends keyof One ? true : false

			expectTypeOf<OneHasPaginate>().toEqualTypeOf<false>()
		})

		test('.paginate() is gated on both findMany and count', () => {
			class FullAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string'] as const
				readonly queryableOps = ['eq'] as const
				async findMany() {
					return []
				}
				async count() {
					return 0
				}
			}
			class CountOnlyAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string'] as const
				readonly queryableOps = ['eq'] as const
				async count() {
					return 0
				}
			}
			class FindOnlyAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string'] as const
				readonly queryableOps = ['eq'] as const
				async findMany() {
					return []
				}
			}
			type Full = AllBuilderSurface<S, FullAdapter>
			type MissingFindMany = AllBuilderSurface<S, CountOnlyAdapter>
			type MissingCount = AllBuilderSurface<S, FindOnlyAdapter>

			expectTypeOf<Full['paginate']>().toBeFunction()
			expectTypeOf<MissingFindMany['paginate']>().toBeNever()
			expectTypeOf<MissingCount['paginate']>().toBeNever()
		})
	})
}
