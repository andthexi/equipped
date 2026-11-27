import { v, type Pipe, type PipeInput, type PipeOutput } from 'valleyed'

import { ComputedField, SchemaField, type AnyComputedField, type AnySchemaField } from './fields.js'
import type { Prettify } from './utils.js'

const RESERVED_SCHEMA_NAMES = new Set(['_equipped_migrations', '_equipped_migration_locks'])

type AnyPrimaryKeyField = SchemaField<string, Pipe<any, any>, Pipe<any, any>, true>

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type FieldOutputOption<P extends Pipe<any, any>> =
	Equal<PipeInput<P>, PipeOutput<P>> extends true
		? { output?: Pipe<PipeOutput<P>, PipeOutput<P>> }
		: { output: Pipe<PipeOutput<P>, PipeOutput<P>> }
type FieldLifecycleOptions<P extends Pipe<any, any>> = {
	onCreate?: () => PipeOutput<P>
	onUpdate?: () => PipeOutput<P>
}
type FieldOutput<P extends Pipe<any, any>, O> = O extends { output: infer Output extends Pipe<any, any> } ? Output : P

export type AnySchema = Schema<
	string,
	AnyPrimaryKeyField,
	Record<string, AnySchemaField>,
	Record<string, AnyComputedField>
>

export type SchemaComputedDefs<S extends AnySchema> =
	S extends Schema<any, any, any, infer C> ? C : Record<string, AnyComputedField>

export type SchemaPersistedOutput<S extends AnySchema> = Prettify<{
	[K in keyof SchemaFields<S>]: SchemaFields<S>[K] extends SchemaField<any, any, infer P, any> ? PipeOutput<P> : never
}>

export type SchemaComputedOutput<S extends AnySchema> = Prettify<{
	[K in keyof SchemaComputedDefs<S>]: SchemaComputedDefs<S>[K] extends ComputedField<any, infer P, any>
		? PipeOutput<P>
		: never
}>

export type SchemaOutput<S extends AnySchema> = Prettify<{
	[K in keyof SchemaPersistedOutput<S> | keyof SchemaComputedOutput<S>]: K extends keyof SchemaPersistedOutput<S>
		? SchemaPersistedOutput<S>[K]
		: K extends keyof SchemaComputedOutput<S>
			? SchemaComputedOutput<S>[K]
			: never
}>

export type SchemaFields<S extends AnySchema> =
	S extends Schema<any, infer PKField, infer F, any>
		? PKField extends AnySchemaField
			? Prettify<Record<PKField['name'], PKField> & F>
			: F
		: never

export type SchemaTaggedFields<S extends AnySchema> = {
	[K in keyof SchemaFields<S>]: SchemaFields<S>[K] & { readonly __schema?: S }
}

export class SchemaBuilder<
	N extends string,
	PKField extends AnyPrimaryKeyField | never = never,
	F extends Record<string, AnySchemaField> = {},
	C extends Record<string, AnyComputedField> = {},
> {
	#name: N
	#pkField: PKField | null
	#fieldDefs: F
	#computedDefs: C

	constructor(name: N, pkField?: PKField | null, fieldDefs?: F, computedDefs?: C) {
		this.#name = name
		this.#pkField = pkField ?? null
		this.#fieldDefs = fieldDefs ?? ({} as F)
		this.#computedDefs = computedDefs ?? ({} as C)
	}

	get name() {
		return this.#name
	}

	pk<K extends string, P extends Pipe<any, any>, O extends FieldOutputOption<P>>(
		name: [PKField] extends [never] ? K : never,
		options: { input: P } & O & { generate: () => PipeOutput<P> },
	): SchemaBuilder<N, SchemaField<K, P, FieldOutput<P, O>, true>, F> {
		const output = (options.output ?? options.input) as FieldOutput<P, O>
		const generate = options.generate as () => PipeOutput<FieldOutput<P, O>>
		return new SchemaBuilder<N, SchemaField<K, P, FieldOutput<P, O>, true>, F>(
			this.#name,
			new SchemaField<K, P, FieldOutput<P, O>, true>(name as K, options.input, output, { generate }),
			{ ...this.#fieldDefs } as F,
			undefined,
		)
	}

	field<K extends string, P extends Pipe<any, any>, O extends FieldOutputOption<P> & FieldLifecycleOptions<P>>(
		name: K extends keyof F ? never : K,
		options: { input: P } & O,
	): SchemaBuilder<
		N,
		PKField,
		{
			[Key in keyof F | K]: Key extends K
				? SchemaField<K, P, FieldOutput<P, O>, [O] extends [{ onCreate: () => any }] ? true : false>
				: Key extends keyof F
					? F[Key]
					: never
		}
	> {
		const output = (options.output ?? options.input) as FieldOutput<P, O>
		const hooks = {
			onCreate: options.onCreate as (() => PipeOutput<FieldOutput<P, O>>) | undefined,
			onUpdate: options.onUpdate as (() => PipeOutput<FieldOutput<P, O>>) | undefined,
		}
		const nextFields = {
			...this.#fieldDefs,
			[name]: new SchemaField<K, P, FieldOutput<P, O>, [O] extends [{ onCreate: () => any }] ? true : false>(
				name as K,
				options.input,
				output,
				hooks,
			),
		}
		return new SchemaBuilder(this.#name, this.#pkField, nextFields, { ...this.#computedDefs }) as any
	}

	computed<
		K extends string,
		Deps extends readonly (keyof SchemaPersistedOutput<Schema<N, PKField, F, C>> & string)[],
		P extends Pipe<any, any>,
	>(
		name: K extends keyof SchemaPersistedOutput<Schema<N, PKField, F, C>> | keyof C ? never : K,
		deps: Deps,
		pipe: P,
		compute: (data: Pick<SchemaPersistedOutput<Schema<N, PKField, F, C>>, Deps[number]>) => PipeOutput<P>,
	): SchemaBuilder<
		N,
		PKField,
		F,
		{
			[Key in keyof C | K]: Key extends K ? ComputedField<K, P, Deps> : Key extends keyof C ? C[Key] : never
		}
	> {
		const nextComputed = { ...this.#computedDefs, [name]: new ComputedField(name as K, pipe, deps, compute as any) }
		return new SchemaBuilder(this.#name, this.#pkField, { ...this.#fieldDefs }, nextComputed) as any
	}

	build(this: [PKField] extends [never] ? never : SchemaBuilder<N, PKField, F, C>): Schema<N, PKField, F, C> {
		const self = this as unknown as SchemaBuilder<N, PKField, F, C>
		return new Schema<N, PKField, F, C>(self.#name, self.#pkField, self.#fieldDefs, self.#computedDefs)
	}
}

export class Schema<
	N extends string,
	PKField extends AnyPrimaryKeyField | never = never,
	F extends Record<string, AnySchemaField> = {},
	C extends Record<string, AnyComputedField> = {},
> {
	#name: N
	#pkField: PKField | null
	#fieldDefs: F
	#computedDefs: C

	constructor(name: N, pkField: PKField | null, fieldDefs: F, computedDefs: C) {
		this.#name = name
		this.#pkField = pkField
		this.#fieldDefs = fieldDefs
		this.#computedDefs = computedDefs
		if (this.#pkField) {
			Object.defineProperty(this.#pkField, '__schema', { value: this, enumerable: false, configurable: true })
		}
		for (const field of Object.values(this.#fieldDefs)) {
			Object.defineProperty(field, '__schema', { value: this, enumerable: false, configurable: true })
		}
	}

	get name() {
		return this.#name
	}

	get pkField() {
		if (!this.#pkField) throw new Error(`Schema "${this.#name}" does not have a primary key defined`)
		return this.#pkField
	}

	get fieldDefs(): F {
		return this.#fieldDefs
	}

	get computedDefs(): C {
		return this.#computedDefs
	}

	get fields() {
		return {
			...(this.#pkField ? { [this.#pkField.name]: this.#pkField } : {}),
			...this.#fieldDefs,
		} as unknown as SchemaTaggedFields<this>
	}

	static from<N extends string>(name: N): SchemaBuilder<N> {
		if (RESERVED_SCHEMA_NAMES.has(name)) throw new Error(`Schema name "${name}" is reserved`)
		return new SchemaBuilder(name)
	}
}

if (import.meta.vitest) {
	const { describe, test, expect, expectTypeOf } = import.meta.vitest

	describe('SchemaBuilder', () => {
		const UserSchema = Schema.from('users')
			.pk('id', { input: v.string(), generate: () => 'generated-id' })
			.field('email', { input: v.string() })
			.field('name', { input: v.string() })
			.field('age', { input: v.optional(v.number()) })
			.field('createdAt', { input: v.number(), onCreate: () => 1000 })
			.field('updatedAt', { input: v.number(), onCreate: () => 1000, onUpdate: () => 2000 })
			.build()

		describe('Schema.from()', () => {
			test.each(['_equipped_migrations', '_equipped_migration_locks'])(
				'rejects reserved name %s immediately',
				(name) => {
					expect(() => Schema.from(name)).toThrow(`Schema name "${name}" is reserved`)
				},
			)

			test('returns a SchemaBuilder instance', () => {
				expect(Schema.from('test')).toBeInstanceOf(SchemaBuilder)
			})

			test('returns a Schema instance after build', () => {
				const s = Schema.from('test')
					.pk('id', { input: v.string(), generate: () => 'x' })
					.build()
				expect(s).toBeInstanceOf(Schema)
			})

			test('Schema has no builder methods', () => {
				const s = Schema.from('test')
					.pk('id', { input: v.string(), generate: () => 'x' })
					.build()
				expect(s).not.toHaveProperty('pk')
				expect(s).not.toHaveProperty('field')
				expect(s).not.toHaveProperty('computed')
				expect(s).not.toHaveProperty('build')
			})

			test('stores the schema name on builder', () => {
				expect(Schema.from('orders').name).toBe('orders')
			})

			test('stores the schema name after build', () => {
				expect(
					Schema.from('orders')
						.pk('id', { input: v.string(), generate: () => 'x' })
						.build().name,
				).toBe('orders')
			})

			test('full builder chain works', () => {
				const s = Schema.from('users')
					.pk('id', { input: v.string(), generate: () => 'gen' })
					.field('email', { input: v.string() })
					.field('age', { input: v.number() })
					.build()
				expect(s.name).toBe('users')
				expect(s.pkField.name).toBe('id')
				expect(Object.keys(s.fields)).toEqual(['id', 'email', 'age'])
			})

			test('.build() is unavailable without .pk() at the type level', () => {
				// @ts-expect-error — .build() requires .pk() to have been called
				Schema.from('test').field('name', { input: v.string() }).build()
			})
		})

		describe('.name', () => {
			test('returns the schema name', () => {
				expect(UserSchema.name).toBe('users')
			})
		})

		describe('.pk()', () => {
			test('pkField returns the pk field', () => {
				expect(UserSchema.pkField.name).toBe('id')
			})

			test('pk entry is a SchemaField instance', () => {
				expect(UserSchema.fields.id).toBeInstanceOf(SchemaField)
			})

			test('pk entry has correct pipe', () => {
				expect(UserSchema.fields.id.input).toBeDefined()
				expect(UserSchema.fields.id.output).toBeDefined()
			})

			test('pk entry has correct name and path', () => {
				expect(UserSchema.fields.id.name).toBe('id')
				expect(UserSchema.fields.id.path).toEqual(['id'])
			})

			test('pk generate stores the value factory', () => {
				expect(UserSchema.fields.id.generate?.()).toBe('generated-id')
			})

			test('pkField throws when no pk defined', () => {
				const schema = new Schema('nopk', null, { name: new SchemaField('name', v.string(), v.string()) }, {})
				expect(() => schema.pkField).toThrow()
			})
		})

		describe('.field()', () => {
			test('all field entries are SchemaField instances', () => {
				for (const entry of Object.values(UserSchema.fieldDefs)) {
					expect(entry).toBeInstanceOf(SchemaField)
				}
			})

			test('field has correct name and path', () => {
				expect(UserSchema.fields.email.name).toBe('email')
				expect(UserSchema.fields.email.path).toEqual(['email'])
			})

			test('field has correct pipe', () => {
				expect(UserSchema.fields.email.input).toBeDefined()
				expect(UserSchema.fields.email.output).toBe(UserSchema.fields.email.input)
				expect(UserSchema.fieldDefs.email.output).toBe(UserSchema.fields.email.output)
			})

			test('field with onCreate stores the function', () => {
				expect(UserSchema.fields.createdAt.onCreate?.()).toBe(1000)
			})

			test('field with onUpdate stores the function', () => {
				expect(UserSchema.fields.updatedAt.onUpdate?.()).toBe(2000)
			})

			test('field with both hooks stores both', () => {
				expect(UserSchema.fields.updatedAt.onCreate?.()).toBe(1000)
				expect(UserSchema.fields.updatedAt.onUpdate?.()).toBe(2000)
			})

			test('field with no lifecycle has undefined hooks', () => {
				expect(UserSchema.fields.email.onCreate).toBeUndefined()
				expect(UserSchema.fields.email.onUpdate).toBeUndefined()
			})
		})

		describe('.computed()', () => {
			test('registers computed fields and dependencies', () => {
				const WithComputed = Schema.from('users')
					.pk('id', { input: v.string(), generate: () => 'u1' })
					.field('name', { input: v.string() })
					.field('email', { input: v.string() })
					.computed('display', ['name', 'email'], v.string(), ({ name, email }) => `${name} <${email}>`)
					.build()

				expect(Object.keys(WithComputed.computedDefs)).toEqual(['display'])
				expect(WithComputed.computedDefs.display.deps).toEqual(['name', 'email'])
				expect(WithComputed.computedDefs.display.compute({ name: 'Alice', email: 'a@b.com' })).toBe(
					'Alice <a@b.com>',
				)
			})

			test('computed field names are included in schema output type', () => {
				const WithComputed = Schema.from('users')
					.pk('id', { input: v.string(), generate: () => 'u1' })
					.field('name', { input: v.string() })
					.computed('nameUpper', ['name'], v.string(), ({ name }) => name.toUpperCase())
					.build()

				type Out = SchemaOutput<typeof WithComputed>
				const value: Out = { id: 'u1', name: 'Alice', nameUpper: 'ALICE' }
				expect(Object.keys(WithComputed.computedDefs)).toEqual(['nameUpper'])
				expect(value.nameUpper).toBe('ALICE')
			})
		})

		describe('.fields', () => {
			test('includes all keys including pk', () => {
				expect(Object.keys(UserSchema.fields)).toEqual(['id', 'email', 'name', 'age', 'createdAt', 'updatedAt'])
			})

			test('pk entry appears first', () => {
				expect(Object.keys(UserSchema.fields)[0]).toBe('id')
			})

			test('schema with no fields has only pk in fields', () => {
				const PkOnly = Schema.from('minimal')
					.pk('id', { input: v.string(), generate: () => 'x' })
					.build()
				expect(Object.keys(PkOnly.fields)).toEqual(['id'])
			})
		})

		describe('.fieldDefs', () => {
			test('excludes the pk field', () => {
				expect(Object.keys(UserSchema.fieldDefs)).not.toContain('id')
			})

			test('contains all non-pk fields in order', () => {
				expect(Object.keys(UserSchema.fieldDefs)).toEqual(['email', 'name', 'age', 'createdAt', 'updatedAt'])
			})

			test('schema with no fields has empty fieldDefs', () => {
				const PkOnly = Schema.from('minimal')
					.pk('id', { input: v.string(), generate: () => 'x' })
					.build()
				expect(Object.keys(PkOnly.fieldDefs)).toHaveLength(0)
			})
		})
	})

	describe('type-level: Schema.from uniqueness guard', () => {
		test('duplicate .field() name is a TS error', () => {
			Schema.from('test')
				.pk('id', { input: v.string(), generate: () => 'x' })
				.field('email', { input: v.string() })
				// @ts-expect-error — duplicate field name 'email' should fail
				.field('email', { input: v.string() })
				.build()
		})
	})

	describe('clone-on-step: fan-out independence', () => {
		test('.field() returns a new builder, not the same instance', () => {
			const base = Schema.from('test').pk('id', { input: v.string(), generate: () => 'x' })
			const a = base.field('email', { input: v.string() })
			expect(a).not.toBe(base)
		})

		test('.pk() returns a new builder, not the same instance', () => {
			const base = Schema.from('test')
			const a = base.pk('id', { input: v.string(), generate: () => 'x' })
			expect(a).not.toBe(base)
		})

		test('.computed() returns a new builder, not the same instance', () => {
			const base = Schema.from('test')
				.pk('id', { input: v.string(), generate: () => 'x' })
				.field('name', { input: v.string() })
			const a = base.computed('upper', ['name'], v.string(), ({ name }) => name.toUpperCase())
			expect(a).not.toBe(base)
		})

		test('fan-out from shared base does not pollute either branch', () => {
			const base = Schema.from('test').pk('id', { input: v.string(), generate: () => 'x' })
			const branchA = base.field('email', { input: v.string() }).build()
			const branchB = base.field('age', { input: v.number() }).build()

			expect(Object.keys(branchA.fieldDefs)).toEqual(['email'])
			expect(Object.keys(branchB.fieldDefs)).toEqual(['age'])
		})

		test('fan-out with computed does not pollute base', () => {
			const base = Schema.from('test')
				.pk('id', { input: v.string(), generate: () => 'x' })
				.field('name', { input: v.string() })
			const withComputed = base.computed('upper', ['name'], v.string(), ({ name }) => name.toUpperCase()).build()
			const withoutComputed = base.build()

			expect(Object.keys(withComputed.computedDefs)).toEqual(['upper'])
			expect(Object.keys(withoutComputed.computedDefs)).toEqual([])
		})
	})

	describe('type-level: schema-tagged Fields', () => {
		test('fields accessor returns schema-tagged Field instances', () => {
			const _TestSchema = Schema.from('test')
				.pk('id', { input: v.string(), generate: () => 'x' })
				.field('email', { input: v.string() })
				.build()
			type FieldS = NonNullable<(typeof _TestSchema.fields.id)['__schema']>
			expectTypeOf<FieldS>().toEqualTypeOf<typeof _TestSchema>()

			type FieldS2 = NonNullable<(typeof _TestSchema.fields.email)['__schema']>
			expectTypeOf<FieldS2>().toEqualTypeOf<typeof _TestSchema>()
		})

		test('fields carry runtime __schema reference to parent schema', () => {
			const TestSchema = Schema.from('test')
				.pk('id', { input: v.string(), generate: () => 'x' })
				.field('email', { input: v.string() })
				.build()
			expect((TestSchema.fields.id as any).__schema).toBe(TestSchema)
			expect((TestSchema.fields.email as any).__schema).toBe(TestSchema)
		})
	})
}
