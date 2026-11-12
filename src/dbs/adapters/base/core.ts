import type { Filter, UpdateFilter } from 'mongodb'
import type { ConditionalObjectKeys, DeepPartial, DistributiveOmit } from 'valleyed'

import type { QueryParams, QueryParamsBase, QueryResults } from '../../pipes.js'
import type { DbChange } from './changes.js'

export type IdType = { _id: string } | { id: string }
export type Entity = { toJSON: () => Record<string, unknown> }
type ModelId<T> = T extends Model<infer Id> ? Id[keyof Id] : never
export type Model<IdKey extends IdType> = IdKey & {
	createdAt?: number
	updatedAt?: number
}

export type Select<T> = (keyof T)[]
type SelectEntity<E, S> = S extends readonly (keyof E)[] ? (S[number] extends never ? E : Pick<E, S[number]>) : E

type Sort = NonNullable<QueryParamsBase['sort']>[number]

type FindManyOptions<T, S extends Select<T> | undefined = undefined> = {
	limit?: number
	sort?: Sort | Sort[]
	select?: S
}

type FindOneOptions<T, S extends Select<T> | undefined = undefined> = {
	select?: S
}

export type Table<
	Id extends IdType,
	T extends Model<Id>,
	E extends Entity,
	Extras extends Record<string, unknown> = {},
> = {
	query: <const S extends Select<T> | undefined = undefined>(
		query: QueryParams<T, S>,
	) => Promise<QueryResults<SelectEntity<E, S>>>
	findMany: <const S extends Select<T> | undefined = undefined>(
		filter: Filter<T>,
		options?: FindManyOptions<T, S>,
	) => Promise<SelectEntity<E, S>[]>
	findOne: <const S extends Select<T> | undefined = undefined>(
		filter: Filter<T>,
		options?: FindOneOptions<T, S>,
	) => Promise<SelectEntity<E, S> | null>
	findById: <const S extends Select<T> | undefined = undefined>(
		id: ModelId<T>,
		options?: FindOneOptions<T, S>,
	) => Promise<SelectEntity<E, S> | null>
	insertOne: (values: CreateInput<T>, options?: { makeId?: () => string; getTime?: () => Date }) => Promise<E>
	insertMany: (
		values: CreateInput<T>[],
		options?: { makeId?: (i: number) => string; getTime?: () => Date },
	) => Promise<E[]>
	updateMany: (filter: Filter<T>, values: UpdateInput<T>, options?: { getTime?: () => Date }) => Promise<E[]>
	updateOne: (filter: Filter<T>, values: UpdateInput<T>, options?: { getTime?: () => Date }) => Promise<E | null>
	updateById: (id: ModelId<T>, values: UpdateInput<T>, options?: { getTime?: () => Date }) => Promise<E | null>
	upsertOne: (
		filter: Filter<T>,
		values: { insert: CreateInput<T> } | { insert: Partial<CreateInput<T>>; update: UpdateInput<T> },
		options?: { makeId?: () => string; getTime?: () => Date },
	) => Promise<E>
	deleteOne: (filter: Filter<T>) => Promise<E | null>
	deleteById: (id: ModelId<T>) => Promise<E | null>
	deleteMany: (filter: Filter<T>) => Promise<E[]>
	bulkWrite: (operations: BulkWriteOperation<T>[], options?: { getTime?: () => Date }) => Promise<void>
	readonly config: Config<T, E>
	readonly extras: Extras
	watch: (callbacks: DbChangeCallbacks<T, E>) => DbChange<T, E>
}

export type { Filter }

type AllKeys<T> = T extends any ? keyof T : never
export type EntityInput<T extends Model<any>> = ConditionalObjectKeys<
	DistributiveOmit<T, AllKeys<IdType> | keyof Model<IdType>>
>

export type CreateInput<T extends Model<any>> = EntityInput<T>
// TODO: Updatefilter no type safe
export type UpdateInput<T extends Model<any>> = DistributiveOmit<UpdateFilter<CreateInput<T>>, '$setOnInsert'>

export type BulkWriteOperation<T extends Model<any>> =
	| { op: 'insert'; value: CreateInput<T>; makeId?: (i: number) => string }
	| { op: 'update'; filter: Filter<T>; value: UpdateInput<T> }
	| ({ op: 'upsert'; filter: Filter<T>; makeId?: (i: number) => string } & (
			{ insert: CreateInput<T> } | { insert: Partial<CreateInput<T>>; update: UpdateInput<T> }
	  ))
	| { op: 'delete'; filter: Filter<T> }

export type DbChangeCallbacks<M extends Model<IdType>, E extends Entity> = {
	created?: (data: { before: null; after: E }) => Promise<void>
	updated?: (data: { before: E; after: E; changes: DeepPartial<M> }) => Promise<void>
	deleted?: (data: { before: E; after: null }) => Promise<void>
}

export type Config<M extends Model<IdType>, E extends Entity> = {
	db: string
	col: string
	mapper: (model: M, select?: Select<E>) => E
	options?: { skipAudit?: boolean }
}
