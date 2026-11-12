import type { FilterGroup } from '../filter.js'
import type { AggregateSpec } from '../orm-adapter.js'
import type { IterationQueryOptions, QueryOptions } from '../query-options.js'
import type { AnySchema } from '../schema.js'
import type { AnyUpdateOp } from '../updates.js'

export type OrmUse = {
	findMany: (filter: FilterGroup, options?: QueryOptions) => Promise<Record<string, unknown>[]>
	iterateMany: (
		filter: FilterGroup,
		options?: IterationQueryOptions,
	) => AsyncGenerator<Record<string, unknown>, void, void>
	findOne: (filter: FilterGroup) => Promise<Record<string, unknown> | null>
	count: (filter: FilterGroup) => Promise<number>
	createOne: (data: Record<string, unknown>) => Promise<Record<string, unknown>>
	createMany: (data: Record<string, unknown>[]) => Promise<Record<string, unknown>[]>
	updateMany: (filter: FilterGroup, data: Record<string, unknown>) => Promise<Record<string, unknown>[]>
	updateOne: (filter: FilterGroup, data: Record<string, unknown>) => Promise<Record<string, unknown> | null>
	upsertOne: (
		filter: FilterGroup,
		create: Record<string, unknown>,
		ops: AnyUpdateOp[],
	) => Promise<Record<string, unknown>>
	deleteOne: (filter: FilterGroup) => Promise<Record<string, unknown> | null>
	deleteMany: (filter: FilterGroup) => Promise<Record<string, unknown>[]>
	raw: (...args: any[]) => Promise<any>
	aggregate: (spec: AggregateSpec) => Promise<Array<Record<string, unknown>>>
	aggregateOps: readonly string[]
}

export type OrmAdapterLike<Config = unknown> = {
	use(schema: AnySchema, config: Config): OrmUse
	connect?(): Promise<void>
	disconnect?(): Promise<void>
	session?<T>(fn: () => Promise<T>): Promise<T>
}

export type OrmAdapterConfig<A extends OrmAdapterLike<any>> = A extends OrmAdapterLike<infer Config> ? Config : never
