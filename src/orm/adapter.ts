import type { Pipe, PipeInput, PipeOutput } from 'valleyed'

import type { SchemaField } from './fields.js'
import type { AnySchema, SchemaFields } from './schema.js'

export type FieldTypeName = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array' | 'date'
export type FilterOpName =
	| 'eq'
	| 'ne'
	| 'gt'
	| 'gte'
	| 'lt'
	| 'lte'
	| 'in'
	| 'notIn'
	| 'like'
	| 'exists'
	| 'notExists'
	| 'contains'
	| 'notContains'
export type UpdateOpName = 'set' | 'inc' | 'mul' | 'min' | 'max' | 'unset' | 'push' | 'pull' | 'patch'
export type AggregateOpName = 'count' | 'countDistinct' | 'sum' | 'avg' | 'min' | 'max'

export type InferAdapterConfig<A> = A extends { schemaConfigPipe: infer P extends Pipe<any, any> }
	? PipeInput<P>
	: A extends { use: (schema: any, config: infer C) => any }
		? C
		: never

export type InferAdapterQueryableOps<A> = A extends { queryableOps: infer Ops extends readonly FilterOpName[] }
	? Ops
	: readonly []

export type InferRawArgs<A> = A extends { raw: (schema: any, config: any, ...args: infer Args) => any } ? Args : never

export type InferRawReturn<A> = A extends { raw: (...args: any[]) => Promise<infer R> } ? R : unknown

type ToFieldTypeName<T> = T extends undefined
	? never
	: T extends string
		? 'string'
		: T extends number
			? 'number'
			: T extends boolean
				? 'boolean'
				: T extends null
					? 'null'
					: T extends readonly any[]
						? 'array'
						: T extends Date
							? 'date'
							: T extends Record<string, any>
								? 'object'
								: never

type SchemaFieldTypeNames<S extends AnySchema> = {
	[K in keyof SchemaFields<S>]: SchemaFields<S>[K] extends SchemaField<any, infer P, any>
		? ToFieldTypeName<PipeOutput<P>>
		: never
}[keyof SchemaFields<S>]

export type SchemaCompatible<A, S extends AnySchema> = A extends { supportedFieldTypes: readonly (infer FT)[] }
	? [SchemaFieldTypeNames<S>] extends [FT]
		? S
		: never
	: S

if (import.meta.vitest) {
	const { describe, test, expectTypeOf } = import.meta.vitest
	const { v } = await import('valleyed')
	const { Schema } = await import('./schema.js')
	const { OrmAdapter } = await import('./orm-adapter.js')

	describe('type-level: InferRawArgs and InferRawReturn', () => {
		test('InferRawArgs extracts user args from class-based adapter raw signature', () => {
			class RawAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ table: v.string() })
				readonly supportedFieldTypes = ['string'] as const
				async raw(_s: AnySchema, _c: unknown, _sql: string, _params: number[]) {
					return [42]
				}
			}
			type Args = InferRawArgs<RawAdapter>
			expectTypeOf<Args>().toEqualTypeOf<[sql: string, params: number[]]>()
		})

		test('InferRawReturn extracts return type from class-based adapter raw signature', () => {
			class RawAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ table: v.string() })
				readonly supportedFieldTypes = ['string'] as const
				async raw(_s: AnySchema, _c: unknown, _sql: string) {
					return { rows: [] as unknown[] }
				}
			}
			type Ret = InferRawReturn<RawAdapter>
			expectTypeOf<Ret>().toEqualTypeOf<{ rows: unknown[] }>()
		})

		test('InferRawArgs returns never when adapter has no raw', () => {
			class NoRawAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ table: v.string() })
				readonly supportedFieldTypes = ['string'] as const
			}
			type Args = InferRawArgs<NoRawAdapter>
			expectTypeOf<Args>().toBeNever()
		})
	})

	describe('type-level: SchemaCompatible', () => {
		test('adapter with empty supportedFieldTypes rejects any schema', () => {
			class EmptyAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = [] as const
			}
			const _TestSchema = Schema.from('test')
				.pk('id', v.string(), () => 'x')
				.build()
			type Result = SchemaCompatible<EmptyAdapter, typeof _TestSchema>
			expectTypeOf<Result>().toBeNever()
		})

		test('adapter with matching supportedFieldTypes accepts schema', () => {
			class StringAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string'] as const
			}
			const _TestSchema = Schema.from('test')
				.pk('id', v.string(), () => 'x')
				.build()
			type Result = SchemaCompatible<StringAdapter, typeof _TestSchema>
			expectTypeOf<Result>().toEqualTypeOf<typeof _TestSchema>()
		})

		test('adapter missing required field type rejects schema', () => {
			class StringOnlyAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string'] as const
			}
			const _SchemaWithNumber = Schema.from('nums')
				.pk('id', v.string(), () => 'x')
				.field('age', v.number())
				.build()
			type Result = SchemaCompatible<StringOnlyAdapter, typeof _SchemaWithNumber>
			expectTypeOf<Result>().toBeNever()
		})
	})
}
