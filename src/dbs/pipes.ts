import { type ConditionalObjectKeys, type Pipe, type PipeInput, type PipeOutput, v } from 'valleyed'

import { Instance } from '../instance/index.js'
import type { Select } from './adapters/base/core.js'

export enum QueryKeys {
	and = 'and',
	or = 'or',
}

export enum Conditions {
	lt = 'lt',
	lte = 'lte',
	gt = 'gt',
	gte = 'gte',
	eq = 'eq',
	ne = 'ne',
	in = 'in',
	nin = 'nin',
}

// eslint-disable-next-line promise/valid-params -- valleyed v.catch(schema, fallback) is not Promise.prototype.catch
const queryKeys = v.catch(v.defaults(v.in([QueryKeys.and, QueryKeys.or]), QueryKeys.and), QueryKeys.and)
const queryWhere = v.object({
	field: v.string(),
	value: v.any(),
	// eslint-disable-next-line promise/valid-params -- valleyed v.catch(schema, fallback) is not Promise.prototype.catch
	condition: v.catch(v.defaults(v.in(Object.values(Conditions)), Conditions.eq), Conditions.eq),
})
const queryWhereBlock = v.recursive(
	() =>
		v.discriminate((d) => (Object.values(QueryKeys).includes(d.condition as any) ? 'block' : 'regular'), {
			block: v.object({
				condition: queryKeys,
				value: v.array(queryWhereBlock),
			}),
			regular: queryWhere,
		}),
	'QueryWhereBlock',
) as Pipe<
	| {
			condition: PipeInput<typeof queryKeys>
			value: PipeInput<typeof queryWhere>[]
	  }
	| PipeInput<typeof queryWhere>,
	| {
			condition: PipeOutput<typeof queryKeys>
			value: PipeOutput<typeof queryWhere>[]
	  }
	| PipeOutput<typeof queryWhere>
>

const queryWhereClause = v.defaults(v.array(queryWhereBlock), [])

export function queryParamsPipe() {
	return v.meta(
		v
			.object({
				all: v.defaults(v.boolean(), false),
				limit: v.lazy(() => {
					const pagLimit = Instance.get().settings.utils.paginationDefaultLimit
					// eslint-disable-next-line promise/valid-params -- valleyed v.catch(schema, fallback) is not Promise.prototype.catch
					return v.catch(v.defaults(v.number().pipe(v.lte(pagLimit)), pagLimit), pagLimit)
				}),
				// eslint-disable-next-line promise/valid-params -- valleyed v.catch(schema, fallback) is not Promise.prototype.catch
				page: v.catch(v.defaults(v.number().pipe(v.gte(1)), 1), 1),
				search: v.defaults(
					v.nullish(
						v.object({
							value: v.string(),
							fields: v.array(v.string()),
						}),
					),
					null,
				),
				sort: v.defaults(
					v.array(
						v.object({
							field: v.string(),
							desc: v.defaults(v.boolean(), false),
						}),
					),
					[],
				),
				whereType: queryKeys,
				where: queryWhereClause,
				select: v.optional(v.array(v.string())),
			})
			.pipe((p) => ({ ...p, auth: <(typeof p)['where']>[], authType: QueryKeys.and })),
		{ title: 'Query Params', $refId: 'QueryParams' },
	)
}

export function queryResultsPipe<T>(model: Pipe<any, T>) {
	return v.object({
		pages: v.object({
			current: v.number(),
			start: v.number(),
			last: v.number(),
			previous: v.nullable(v.number()),
			next: v.nullable(v.number()),
		}),
		docs: v.object({
			limit: v.number(),
			total: v.number(),
			count: v.number(),
		}),
		results: v.array(model),
	})
}

export function wrapQueryParams(params: QueryParamsInput): QueryParamsBase {
	return v.assert(queryParamsPipe(), params)
}

export type QueryParamsBase = PipeOutput<ReturnType<typeof queryParamsPipe>>
export type QueryParams<T, S extends Select<T> | undefined = undefined> = Omit<QueryParamsBase, 'select'> & {
	select?: S extends undefined ? QueryParamsBase['select'] : S
}
export type QueryParamsInput = ConditionalObjectKeys<PipeInput<ReturnType<typeof queryParamsPipe>>>
export type QueryWhereClause = QueryParamsBase['where'][number]
export type QueryWhere = Extract<QueryWhereClause, { field: string }>
export type QueryWhereBlock = Exclude<QueryWhereClause, { field: string }>
export type QueryResults<T> = PipeOutput<ReturnType<typeof queryResultsPipe<T>>>
