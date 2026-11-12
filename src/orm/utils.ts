import type { Prettify as ValleyedPrettify } from 'valleyed'

import type { ComputedField, Field, SchemaField } from './fields.js'
import type { Filter, FilterGroup } from './filter.js'
import type { OrderBy } from './query-options.js'
import type { AnyRelDef } from './relations.js'
import type { Schema } from './schema.js'
import type { AnyUpdateOp } from './updates.js'

type AnyOrmClass =
	| Field<any, any>
	| SchemaField<any, any, any>
	| ComputedField<any, any, any>
	| Schema<any, any, any>
	| AnyRelDef
	| Filter
	| FilterGroup
	| OrderBy
	| AnyUpdateOp

export type Prettify<T> = T extends AnyOrmClass ? T : ValleyedPrettify<T>
