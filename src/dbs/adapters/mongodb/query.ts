import type { Collection } from 'mongodb'

import {
	QueryKeys,
	type QueryParamsBase,
	type QueryResults,
	type QueryWhereBlock,
	type QueryWhereClause,
} from '../../pipes.js'
import type * as core from '../base/core.js'

export const parseMongodbQueryParams = async <Model extends core.Model<{ _id: string }>>(
	collection: Collection<Model>,
	params: QueryParamsBase,
): Promise<QueryResults<Model>> => {
	// Handle where/search clauses
	const query = <ReturnType<typeof buildWhereQuery>[]>[]
	const where = buildWhereQuery(params.where, params.whereType)
	if (where) query.push(where)
	const auth = buildWhereQuery(params.auth, params.authType)
	if (auth) query.push(auth)
	if (params.search && params.search.fields.length > 0) {
		const search = params.search.fields.map((field) => ({
			[field]: {
				$regex: new RegExp(params.search!.value, 'i'),
			},
		}))
		query.push({ $or: search })
	}
	const totalClause = {}
	if (query.length > 0) totalClause['$and'] = query

	// Handle sort clauses
	const sort = params.sort.map((p) => [p.field, p.desc ? 'desc' : 'asc'])

	// Handle limit/offest clause
	const all = params.all ?? false
	const limit = params.limit
	const page = params.page

	const total = await collection.countDocuments(totalClause)

	const projection = params.select?.length ? Object.fromEntries(params.select.map((k) => [k, 1])) : undefined
	let builtQuery = collection.find(totalClause, { projection })
	if (sort.length) builtQuery = builtQuery.sort(Object.fromEntries(sort))
	if (!all && limit) {
		builtQuery = builtQuery.limit(limit)
		if (page) builtQuery = builtQuery.skip((page - 1) * limit)
	}

	const results = await builtQuery.toArray()
	const start = 1
	const last = Math.ceil(total / limit) || 1
	const next = page >= last ? null : page + 1
	const previous = page <= start ? null : page - 1

	return {
		pages: { start, last, next, previous, current: page },
		docs: { limit, total, count: results.length },
		results: results as any[],
	} satisfies QueryResults<Model>
}

function isWhereBlock(param: QueryWhereClause): param is QueryWhereBlock {
	return Object.values(QueryKeys).includes(param.condition as QueryKeys)
}

const buildWhereQuery = (
	params: QueryWhereClause[],
	key: QueryKeys = QueryKeys.and,
): Record<string, Record<string, any>> | null => {
	const where = (Array.isArray(params) ? params : [])
		.map((param) => {
			if (isWhereBlock(param)) return buildWhereQuery(param.value, param.condition)
			const { field } = param
			const checkedField = field === 'id' ? '_id' : (field ?? '')
			const checkedValue = param.value === undefined ? '' : param.value
			return {
				field: checkedField,
				value: checkedValue,
				condition: param.condition,
				isWhere: true,
			}
		})
		.filter((c) => !!c)
		.map((c) => {
			if (c.isWhere) return { [`${c.field}`]: { [`$${c.condition}`]: c.value } }
			else return c
		})

	return where.length > 0 ? { [`$${key}`]: where } : null
}
