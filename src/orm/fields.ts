import { v, type Pipe, type PipeOutput } from 'valleyed'

import type { FieldTypeName } from './adapter'

type ObjectLike = Record<string, unknown>

type NestedKey<T> = T extends unknown ? (T extends ObjectLike ? keyof T & string : never) : never

type NestedValue<T, K extends string> = T extends unknown ? (T extends ObjectLike ? (K extends keyof T ? T[K] : never) : never) : never

type FieldTypeFor<T> = T extends unknown
	? T extends Date
		? 'date'
		: T extends readonly unknown[]
			? 'array'
			: T extends string
				? 'string'
				: T extends number
					? 'number'
					: T extends boolean
						? 'boolean'
						: T extends null
							? 'null'
							: T extends ObjectLike
								? 'object'
								: never
	: never

export class Field<T = unknown, Name extends string = string, S = unknown> {
	declare readonly __valueType?: T
	declare readonly __schema?: S
	readonly name: Name
	readonly path: readonly string[]
	readonly valueType: FieldTypeName | null

	constructor(name: Name, path?: readonly string[], valueType?: FieldTypeName | null) {
		this.name = name
		this.path = path ?? [name]
		this.valueType = valueType ?? null
	}

	nested<const K extends NestedKey<T>, const Type extends FieldTypeFor<NestedValue<T, K>>>(
		key: K,
		type: Type,
	): Field<NestedValue<T, K>, Name, any> {
		return new Field(this.name, [...this.path, key], type)
	}
}

export type AnyField = Field<any, string, any>

export function toFieldName(field: string | AnyField): string {
	if (field instanceof Field) return field.path.join('.')
	return field
}

export class SchemaField<
	Name extends string = string,
	P extends Pipe<any, any> = Pipe<any, any>,
	HasOnCreate extends boolean = false,
> extends Field<PipeOutput<P>, Name> {
	declare readonly __hasOnCreate?: HasOnCreate
	readonly pipe: P
	readonly onCreate?: () => PipeOutput<P>
	readonly onUpdate?: () => PipeOutput<P>

	constructor(name: Name, pipe: P, opts?: { onCreate?: () => PipeOutput<P>; onUpdate?: () => PipeOutput<P> }) {
		super(name)
		this.pipe = pipe
		this.onCreate = opts?.onCreate
		this.onUpdate = opts?.onUpdate
	}
}

export type AnySchemaField = SchemaField<string, Pipe<any, any>, boolean>

export class ComputedField<
	Name extends string = string,
	P extends Pipe<any, any> = Pipe<any, any>,
	Deps extends readonly string[] = readonly string[],
> {
	constructor(
		readonly name: Name,
		readonly pipe: P,
		readonly deps: Deps,
		readonly compute: (data: Record<Deps[number], unknown>) => PipeOutput<P>,
	) {}
}

export type AnyComputedField = ComputedField<string, Pipe<any, any>, readonly string[]>

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	describe('Fields', () => {
		describe('Field', () => {
			test('stores name and defaults path to [name]', () => {
				const f = new Field('email')
				expect(f.name).toBe('email')
				expect(f.path).toEqual(['email'])
				expect(f.valueType).toBeNull()
			})

			test('stores provided custom path', () => {
				const f = new Field('profile', ['profile', 'displayName'])
				expect(f.name).toBe('profile')
				expect(f.path).toEqual(['profile', 'displayName'])
			})

			test('creates typed nested field paths', () => {
				const f = new Field<{ profile: { displayName: string } }>('account')
				const nested = f.nested('profile', 'object').nested('displayName', 'string')

				expect(nested.name).toBe('account')
				expect(nested.path).toEqual(['account', 'profile', 'displayName'])
				expect(nested.valueType).toBe('string')
			})
		})

		describe('toFieldName()', () => {
			test('returns string input unchanged', () => {
				expect(toFieldName('createdAt')).toBe('createdAt')
			})

			test('converts Field path into dot notation', () => {
				const f = new Field('profile', ['profile', 'displayName'])
				expect(toFieldName(f)).toBe('profile.displayName')
			})
		})

		describe('SchemaField', () => {
			test('extends Field and stores pipe', () => {
				const mockPipe = v.string()
				const f = new SchemaField('email', mockPipe)
				expect(f).toBeInstanceOf(Field)
				expect(f.name).toBe('email')
				expect(f.path).toEqual(['email'])
				expect(f.pipe).toBe(mockPipe)
			})

			test('stores lifecycle hooks when provided', () => {
				const mockPipe = v.number()
				const f = new SchemaField('updatedAt', mockPipe, {
					onCreate: () => 1000,
					onUpdate: () => 2000,
				})
				expect(f.onCreate?.()).toBe(1000)
				expect(f.onUpdate?.()).toBe(2000)
			})

			test('keeps lifecycle hooks undefined when omitted', () => {
				const mockPipe = v.string()
				const f = new SchemaField('name', mockPipe)
				expect(f.onCreate).toBeUndefined()
				expect(f.onUpdate).toBeUndefined()
			})
		})
	})
}
