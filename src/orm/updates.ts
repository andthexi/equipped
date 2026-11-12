import type { PipeInput, PipeOutput } from 'valleyed'

import type { AnyField, AnySchemaField, SchemaField } from './fields.js'
import { toFieldName } from './fields.js'
import type { AnySchema, SchemaFields } from './schema.js'
import type { Prettify } from './utils.js'

export type NumericFieldOf<S extends AnySchema> = {
	[K in keyof SchemaFields<S>]: SchemaFields<S>[K] extends SchemaField<any, infer P, any>
		? PipeOutput<P> extends number
			? SchemaFields<S>[K]
			: never
		: never
}[keyof SchemaFields<S>]

export type ComparableFieldOf<S extends AnySchema> = {
	[K in keyof SchemaFields<S>]: SchemaFields<S>[K] extends SchemaField<any, infer P, any>
		? PipeOutput<P> extends number | string | Date
			? SchemaFields<S>[K]
			: never
		: never
}[keyof SchemaFields<S>]

export type OptionalFieldOf<S extends AnySchema> = {
	[K in keyof SchemaFields<S>]: SchemaFields<S>[K] extends SchemaField<any, infer P, any>
		? undefined extends PipeOutput<P>
			? SchemaFields<S>[K]
			: never
		: never
}[keyof SchemaFields<S>]

export type ArrayFieldOf<S extends AnySchema> = {
	[K in keyof SchemaFields<S>]: SchemaFields<S>[K] extends SchemaField<any, infer P, any>
		? PipeOutput<P> extends readonly any[]
			? SchemaFields<S>[K]
			: never
		: never
}[keyof SchemaFields<S>]

export type ObjectFieldOf<S extends AnySchema> = {
	[K in keyof SchemaFields<S>]: SchemaFields<S>[K] extends SchemaField<any, infer P, any>
		? PipeOutput<P> extends Record<string, any>
			? PipeOutput<P> extends readonly any[]
				? never
				: SchemaFields<S>[K]
			: never
		: never
}[keyof SchemaFields<S>]

export type SetValues<S extends AnySchema> = Prettify<
	Partial<{
		[K in keyof SchemaFields<S>]: SchemaFields<S>[K] extends AnySchemaField
			? PipeInput<SchemaFields<S>[K]['pipe']>
			: never
	}>
>

export class SetOp {
	readonly kind = 'set' as const
	constructor(readonly values: Record<string, unknown>) {}
}
export class IncOp {
	readonly kind = 'inc' as const
	constructor(
		readonly field: string,
		readonly value: number,
	) {}
}
export class MulOp {
	readonly kind = 'mul' as const
	constructor(
		readonly field: string,
		readonly value: number,
	) {}
}
export class MinOp<T = unknown> {
	readonly kind = 'min' as const
	constructor(
		readonly field: string,
		readonly value: T,
	) {}
}
export class MaxOp<T = unknown> {
	readonly kind = 'max' as const
	constructor(
		readonly field: string,
		readonly value: T,
	) {}
}
export class UnsetOp {
	readonly kind = 'unset' as const
	constructor(readonly field: string) {}
}
export class PushOp<T = unknown> {
	readonly kind = 'push' as const
	constructor(
		readonly field: string,
		readonly value: T,
	) {}
}
export class PullOp<T = unknown> {
	readonly kind = 'pull' as const
	constructor(
		readonly field: string,
		readonly value: T,
	) {}
}
export class PatchOp<T = unknown> {
	readonly kind = 'patch' as const
	constructor(
		readonly field: string,
		readonly value: T,
	) {}
}

export type AnyUpdateOp = SetOp | IncOp | MulOp | MinOp | MaxOp | UnsetOp | PushOp | PullOp | PatchOp

export function isUpdateOp(v: unknown): v is AnyUpdateOp {
	return (
		v instanceof SetOp ||
		v instanceof IncOp ||
		v instanceof MulOp ||
		v instanceof MinOp ||
		v instanceof MaxOp ||
		v instanceof UnsetOp ||
		v instanceof PushOp ||
		v instanceof PullOp ||
		v instanceof PatchOp
	)
}

export type HasOp<A, Op extends string> = A extends { updateOps: readonly (infer U)[] }
	? Op extends U
		? true
		: false
	: false

export type UpdateOp<_S extends AnySchema, A> =
	| (HasOp<A, 'set'> extends true ? SetOp : never)
	| (HasOp<A, 'inc'> extends true ? IncOp : never)
	| (HasOp<A, 'mul'> extends true ? MulOp : never)
	| (HasOp<A, 'min'> extends true ? MinOp : never)
	| (HasOp<A, 'max'> extends true ? MaxOp : never)
	| (HasOp<A, 'unset'> extends true ? UnsetOp : never)
	| (HasOp<A, 'push'> extends true ? PushOp : never)
	| (HasOp<A, 'pull'> extends true ? PullOp : never)
	| (HasOp<A, 'patch'> extends true ? PatchOp : never)

export function set<S extends AnySchema>(values: SetValues<S>): SetOp {
	return new SetOp(values as Record<string, unknown>)
}

export function inc<S extends AnySchema>(field: NumericFieldOf<S>, value: number): IncOp {
	return new IncOp(toFieldName(field as AnyField), value)
}

export function mul<S extends AnySchema>(field: NumericFieldOf<S>, value: number): MulOp {
	return new MulOp(toFieldName(field as AnyField), value)
}

export function min<S extends AnySchema>(field: ComparableFieldOf<S>, value: unknown): MinOp {
	return new MinOp(toFieldName(field as AnyField), value)
}

export function max<S extends AnySchema>(field: ComparableFieldOf<S>, value: unknown): MaxOp {
	return new MaxOp(toFieldName(field as AnyField), value)
}

export function unset<S extends AnySchema>(field: OptionalFieldOf<S>): UnsetOp {
	return new UnsetOp(toFieldName(field as AnyField))
}

export function push<S extends AnySchema>(field: ArrayFieldOf<S>, value: unknown): PushOp {
	return new PushOp(toFieldName(field as AnyField), value)
}

export function pull<S extends AnySchema>(field: ArrayFieldOf<S>, value: unknown): PullOp {
	return new PullOp(toFieldName(field as AnyField), value)
}

export function patch<S extends AnySchema>(field: ObjectFieldOf<S>, value: Record<string, unknown>): PatchOp {
	return new PatchOp(toFieldName(field as AnyField), value)
}

export function opTouchedFields(op: AnyUpdateOp): string[] {
	if (op instanceof SetOp) return Object.keys(op.values)
	return [op.field]
}

export function flattenOps(ops: AnyUpdateOp[]): Record<string, unknown> {
	const data: Record<string, unknown> = {}
	for (const op of ops) {
		if (op instanceof SetOp) Object.assign(data, op.values)
		else data[op.field] = op
	}
	return data
}

if (import.meta.vitest) {
	const { describe, test, expect, expectTypeOf } = import.meta.vitest
	const { v } = await import('valleyed')
	const { Schema } = await import('./schema.js')

	const TestSchema = Schema.from('test')
		.pk('id', v.string(), () => 'x')
		.field('name', v.string())
		.field('age', v.number())
		.field('score', v.optional(v.number()))
		.field('tags', v.array(v.string()))
		.field('meta', v.object({ a: v.number() }))
		.field('createdAt', v.number(), { onCreate: () => 1000 })
		.field('updatedAt', v.number(), { onCreate: () => 1000, onUpdate: () => 2000 })
		.build()

	describe('op classes', () => {
		test('SetOp has kind "set" and stores values', () => {
			const op = new SetOp({ name: 'Alice' })
			expect(op.kind).toBe('set')
			expect(op.values).toEqual({ name: 'Alice' })
		})
		test('IncOp has kind "inc" and stores field + value', () => {
			const op = new IncOp('age', 5)
			expect(op.kind).toBe('inc')
			expect(op.field).toBe('age')
			expect(op.value).toBe(5)
		})
		test('MulOp has kind "mul" and stores field + value', () => {
			const op = new MulOp('score', 3)
			expect(op.kind).toBe('mul')
			expect(op.field).toBe('score')
			expect(op.value).toBe(3)
		})
		test('MinOp has kind "min"', () => {
			expect(new MinOp('age', 10).kind).toBe('min')
		})
		test('MaxOp has kind "max"', () => {
			expect(new MaxOp('age', 99).kind).toBe('max')
		})
		test('UnsetOp has kind "unset"', () => {
			expect(new UnsetOp('score').kind).toBe('unset')
		})
		test('PushOp has kind "push"', () => {
			expect(new PushOp('tags', 'x').kind).toBe('push')
		})
		test('PullOp has kind "pull"', () => {
			expect(new PullOp('tags', 'x').kind).toBe('pull')
		})
		test('PatchOp has kind "patch"', () => {
			expect(new PatchOp('meta', { a: 9 }).kind).toBe('patch')
		})
	})

	describe('isUpdateOp', () => {
		test('returns true for every op class', () => {
			expect(isUpdateOp(new SetOp({}))).toBe(true)
			expect(isUpdateOp(new IncOp('f', 1))).toBe(true)
			expect(isUpdateOp(new MulOp('f', 2))).toBe(true)
			expect(isUpdateOp(new MinOp('f', 0))).toBe(true)
			expect(isUpdateOp(new MaxOp('f', 10))).toBe(true)
			expect(isUpdateOp(new UnsetOp('f'))).toBe(true)
			expect(isUpdateOp(new PushOp('f', 'v'))).toBe(true)
			expect(isUpdateOp(new PullOp('f', 'v'))).toBe(true)
			expect(isUpdateOp(new PatchOp('f', {}))).toBe(true)
		})
		test('returns false for non-op values', () => {
			expect(isUpdateOp('string')).toBe(false)
			expect(isUpdateOp(42)).toBe(false)
			expect(isUpdateOp(null)).toBe(false)
			expect(isUpdateOp({})).toBe(false)
		})
	})

	describe('op helper functions', () => {
		test('set() creates SetOp with values', () => {
			const op = set<typeof TestSchema>({ name: 'Alice', age: 30 })
			expect(op).toBeInstanceOf(SetOp)
			expect(op.kind).toBe('set')
			expect(op.values).toEqual({ name: 'Alice', age: 30 })
		})
		test('inc() creates IncOp from field ref', () => {
			const op = inc<typeof TestSchema>(TestSchema.fields.age, 5)
			expect(op).toBeInstanceOf(IncOp)
			expect(op.field).toBe('age')
			expect(op.value).toBe(5)
		})
		test('mul() creates MulOp from field ref', () => {
			const op = mul<typeof TestSchema>(TestSchema.fields.age, 3)
			expect(op).toBeInstanceOf(MulOp)
			expect(op.field).toBe('age')
			expect(op.value).toBe(3)
		})
		test('min() creates MinOp from field ref', () => {
			const op = min<typeof TestSchema>(TestSchema.fields.age, 10)
			expect(op).toBeInstanceOf(MinOp)
			expect(op.field).toBe('age')
		})
		test('max() creates MaxOp from field ref', () => {
			const op = max<typeof TestSchema>(TestSchema.fields.age, 99)
			expect(op).toBeInstanceOf(MaxOp)
			expect(op.field).toBe('age')
		})
		test('unset() creates UnsetOp from field ref', () => {
			const op = unset<typeof TestSchema>(TestSchema.fields.score)
			expect(op).toBeInstanceOf(UnsetOp)
			expect(op.field).toBe('score')
		})
		test('push() creates PushOp from field ref', () => {
			const op = push<typeof TestSchema>(TestSchema.fields.tags, 'new-tag')
			expect(op).toBeInstanceOf(PushOp)
			expect(op.field).toBe('tags')
			expect(op.value).toBe('new-tag')
		})
		test('pull() creates PullOp from field ref', () => {
			const op = pull<typeof TestSchema>(TestSchema.fields.tags, 'old-tag')
			expect(op).toBeInstanceOf(PullOp)
			expect(op.field).toBe('tags')
		})
		test('patch() creates PatchOp from field ref', () => {
			const op = patch<typeof TestSchema>(TestSchema.fields.meta, { a: 9 })
			expect(op).toBeInstanceOf(PatchOp)
			expect(op.field).toBe('meta')
			expect(op.value).toEqual({ a: 9 })
		})
	})

	describe('opTouchedFields', () => {
		test('SetOp returns all keys from values', () => {
			expect(opTouchedFields(new SetOp({ name: 'A', age: 1 }))).toEqual(['name', 'age'])
		})
		test('IncOp returns the field', () => {
			expect(opTouchedFields(new IncOp('age', 1))).toEqual(['age'])
		})
		test('UnsetOp returns the field', () => {
			expect(opTouchedFields(new UnsetOp('score'))).toEqual(['score'])
		})
	})

	describe('type-level: field-category helpers', () => {
		test('NumericFieldOf only matches numeric fields (excludes optional numeric)', () => {
			type Numeric = NumericFieldOf<typeof TestSchema>
			expectTypeOf<Numeric['name']>().toEqualTypeOf<'age' | 'createdAt' | 'updatedAt'>()
		})
		test('ComparableFieldOf matches numeric and string fields (excludes optional)', () => {
			type Comparable = ComparableFieldOf<typeof TestSchema>
			expectTypeOf<Comparable['name']>().toEqualTypeOf<'id' | 'name' | 'age' | 'createdAt' | 'updatedAt'>()
		})
		test('OptionalFieldOf only matches optional fields', () => {
			type Optional = OptionalFieldOf<typeof TestSchema>
			expectTypeOf<Optional['name']>().toEqualTypeOf<'score'>()
		})
		test('ArrayFieldOf only matches array fields', () => {
			type Arr = ArrayFieldOf<typeof TestSchema>
			expectTypeOf<Arr['name']>().toEqualTypeOf<'tags'>()
		})
		test('ObjectFieldOf only matches object fields (not arrays)', () => {
			type Obj = ObjectFieldOf<typeof TestSchema>
			expectTypeOf<Obj['name']>().toEqualTypeOf<'meta'>()
		})
	})

	describe('type-level: inc on a string field is a TS error', () => {
		test('inc rejects non-numeric fields', () => {
			// @ts-expect-error — name is a string field, not numeric
			inc<typeof TestSchema>(TestSchema.fields.name, 1)
		})
	})

	describe('type-level: push on a non-array field is a TS error', () => {
		test('push rejects non-array fields', () => {
			// @ts-expect-error — name is a string field, not array
			push<typeof TestSchema>(TestSchema.fields.name, 'val')
		})
	})

	describe('type-level: per-op gating via UpdateOp<S, A>', () => {
		test('undeclared ops resolve to never', async () => {
			const { OrmAdapter } = await import('./orm-adapter.js')
			class LimitedAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string', 'number'] as const
				readonly updateOps = ['set', 'inc'] as const
			}

			type Limited = UpdateOp<typeof TestSchema, LimitedAdapter>
			expectTypeOf<Limited>().toEqualTypeOf<SetOp | IncOp>()
		})

		test('adapter with no updateOps resolves all variants to never', async () => {
			const { OrmAdapter } = await import('./orm-adapter.js')
			class NoOpsAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string'] as const
				readonly updateOps = [] as const
			}

			type NoOps = UpdateOp<typeof TestSchema, NoOpsAdapter>
			expectTypeOf<NoOps>().toBeNever()
		})

		test('adapter with all updateOps includes all variants', async () => {
			const { OrmAdapter } = await import('./orm-adapter.js')
			class FullAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({})
				readonly supportedFieldTypes = ['string', 'number'] as const
				readonly updateOps = ['set', 'inc', 'mul', 'min', 'max', 'unset', 'push', 'pull', 'patch'] as const
			}

			type Full = UpdateOp<typeof TestSchema, FullAdapter>
			type Expected = SetOp | IncOp | MulOp | MinOp | MaxOp | UnsetOp | PushOp | PullOp | PatchOp
			expectTypeOf<Full>().toEqualTypeOf<Expected>()
		})
	})
}
