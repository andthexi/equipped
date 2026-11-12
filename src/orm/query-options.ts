import { toFieldName, type AnyField } from './fields.js'

export class OrderBy {
	readonly field: string
	constructor(
		field: string | AnyField,
		readonly direction: 'asc' | 'desc',
	) {
		this.field = toFieldName(field)
	}
}

export type QueryOptions<Sel extends string = string> = {
	orderBy?: OrderBy[]
	limit?: number
	offset?: number
	select?: readonly Sel[]
}

export type IterationOptions = {
	batchSize?: number
}

export type IterationQueryOptions<Sel extends string = string> = QueryOptions<Sel> & IterationOptions
