import type { AnyPreloadDef, PreloadedMap } from '../../relations.js'
import type { AnySchema, SchemaOutput } from '../../schema.js'
import type { Prettify } from '../../utils.js'

type Selected<S extends AnySchema, Sel extends string> = [Sel] extends [never]
	? SchemaOutput<S>
	: Pick<SchemaOutput<S>, Sel & keyof SchemaOutput<S>>

export type SelectedWithPreloads<
	S extends AnySchema,
	Sel extends string,
	P extends readonly AnyPreloadDef[],
> = Prettify<Selected<S, Sel> & PreloadedMap<P>>

export type Paginated<T> = {
	pages: {
		current: number
		start: number
		last: number
		previous: number | null
		next: number | null
	}
	docs: {
		limit: number
		total: number
		count: number
	}
	items: T[]
}
