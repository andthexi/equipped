import { v, type Pipe, type PipeInput, type PipeOutput } from 'valleyed'

import { OrmValidationError, type OrmValidationFailure } from './errors/index.js'
import type { AnySchemaField, SchemaField } from './fields.js'
import { Schema, type AnySchema, type SchemaFields, type SchemaOutput } from './schema.js'
import { SetOp, isUpdateOp, opTouchedFields, type AnyUpdateOp } from './updates.js'
import type { Prettify } from './utils.js'

export type SchemaCreateInput<S extends AnySchema> = Prettify<
	{
		[
			K in keyof SchemaFields<S> as SchemaFields<S>[K] extends SchemaField<any, any, true> ? never : K
		]: SchemaFields<S>[K] extends AnySchemaField ? PipeInput<SchemaFields<S>[K]['pipe']> : never
	} & {
		[
			K in keyof SchemaFields<S> as SchemaFields<S>[K] extends SchemaField<any, any, true> ? K : never
		]?: SchemaFields<S>[K] extends AnySchemaField ? PipeInput<SchemaFields<S>[K]['pipe']> : never
	}
>

export type SchemaUpdateInput<S extends AnySchema> =
	S extends Schema<any, any, infer F>
		? { [K in keyof F]?: F[K] extends AnySchemaField ? PipeInput<F[K]['pipe']> | AnyUpdateOp : never }
		: Record<string, unknown>

export type SchemaUpdateOutput<S extends AnySchema> =
	S extends Schema<any, any, infer F>
		? { [K in keyof F]?: F[K] extends AnySchemaField ? PipeOutput<F[K]['pipe']> | AnyUpdateOp : never }
		: Record<string, unknown>

export function tryValidateCreateRow<S extends AnySchema>(
	s: S,
	data: Record<string, unknown>,
): { ok: true; value: SchemaOutput<S> } | { ok: false; failures: OrmValidationFailure[] } {
	const failures: OrmValidationFailure[] = []
	const result: Record<string, unknown> = {}

	for (const [key, entry] of Object.entries(s.fields)) {
		const pipe = entry.onCreate ? v.defaults(entry.pipe, entry.onCreate()) : entry.pipe
		const fieldValue = key in data ? data[key] : undefined
		const validated = v.validate(pipe, fieldValue)
		if (validated.valid) {
			result[key] = validated.value
		} else {
			failures.push({ field: key, cause: validated.error })
		}
	}

	if (failures.length > 0) return { ok: false, failures }
	return { ok: true, value: result as SchemaOutput<S> }
}

export function validateCreate<S extends AnySchema>(s: S, data: Record<string, unknown>): SchemaOutput<S> {
	const result = tryValidateCreateRow(s, data)
	if (!result.ok) {
		throw new OrmValidationError('validation', s.name, 'createOne', result.failures)
	}
	return result.value
}

export function validateCreateMany<S extends AnySchema>(s: S, rows: Record<string, unknown>[]): SchemaOutput<S>[] {
	const allFailures: OrmValidationFailure[] = []
	const validated: SchemaOutput<S>[] = []

	for (let i = 0; i < rows.length; i++) {
		const result = tryValidateCreateRow(s, rows[i])
		if (result.ok) {
			validated.push(result.value)
		} else {
			for (const failure of result.failures) {
				allFailures.push({ ...failure, rowIndex: i })
			}
		}
	}

	if (allFailures.length > 0) {
		throw new OrmValidationError('validation', s.name, 'createMany', allFailures)
	}

	return validated
}

export function validateUpdate<S extends AnySchema>(s: S, data: Record<string, unknown>): SchemaUpdateOutput<S> {
	const pipes: Record<string, Pipe<any, any>> = {}
	const ops: Record<string, unknown> = {}

	for (const [key, value] of Object.entries(data)) {
		if (isUpdateOp(value)) ops[key] = value
		else if (key in s.fieldDefs) pipes[key] = s.fieldDefs[key].pipe
	}

	for (const [key, entry] of Object.entries(s.fieldDefs)) {
		if (!(key in data) && entry.onUpdate) pipes[key] = v.defaults(entry.pipe, entry.onUpdate())
	}

	const r = v.validate(v.object(pipes), data)
	if (!r.valid) throw new OrmValidationError('validation', s.name, 'updateByPk', [{ cause: r.error }])
	const validated = r.value as Record<string, unknown>
	return { ...validated, ...ops } as SchemaUpdateOutput<S>
}

export function validateUpdateOps(schema: AnySchema, ops: AnyUpdateOp[], operation = 'updateByPk'): AnyUpdateOp[] {
	const touched = new Map<string, number[]>()

	for (let i = 0; i < ops.length; i++) {
		for (const field of opTouchedFields(ops[i])) {
			if (!touched.has(field)) touched.set(field, [])
			touched.get(field)!.push(i)
		}
	}

	const autoBumped: AnyUpdateOp[] = []
	for (const [key, entry] of Object.entries(schema.fieldDefs)) {
		if (entry.onUpdate && !touched.has(key)) {
			const bumpOp = new SetOp({ [key]: entry.onUpdate() })
			autoBumped.push(bumpOp)
			touched.set(key, [ops.length + autoBumped.length - 1])
		}
	}

	const allOps = [...ops, ...autoBumped]

	const conflicts: OrmValidationFailure[] = []
	for (const [field, indices] of touched) {
		if (indices.length > 1) {
			conflicts.push({
				field,
				cause: `field "${field}" touched by multiple ops at indices [${indices.join(', ')}]`,
			})
		}
	}
	if (conflicts.length > 0) {
		throw new OrmValidationError('conflicting-ops', schema.name, operation, conflicts)
	}

	const failures: OrmValidationFailure[] = []
	for (let i = 0; i < allOps.length; i++) {
		const op = allOps[i]
		if (op instanceof SetOp) {
			for (const [key, value] of Object.entries(op.values)) {
				const fieldDef = schema.fields[key] as AnySchemaField | undefined
				if (!fieldDef) continue
				const r = v.validate(fieldDef.pipe, value)
				if (!r.valid) {
					failures.push({ opIndex: i, field: key, cause: r.error })
				}
			}
		}
	}
	if (failures.length > 0) {
		throw new OrmValidationError('validation', schema.name, operation, failures)
	}

	return allOps
}

export function composeSchemaConfig(
	resolve: (schema: AnySchema) => unknown,
	transforms: ReadonlyArray<(config: any, schema: AnySchema) => any>,
	schema: AnySchema,
	pipe: Pipe<any, any>,
): unknown {
	let config = resolve(schema)
	for (const transform of transforms) {
		config = transform(config, schema)
	}
	const r = v.validate(pipe, config)
	if (!r.valid) throw new OrmValidationError('validation', schema.name, 'schemaConfig', [{ cause: r.error }])
	return r.value
}

export function validateUpsertConflicts(
	schema: AnySchema,
	rawCreate: Record<string, unknown>,
	ops: AnyUpdateOp[],
): void {
	const createFields = new Set(Object.keys(rawCreate))
	const conflicts: OrmValidationFailure[] = []
	for (const op of ops) {
		if (op instanceof SetOp) continue
		for (const field of opTouchedFields(op)) {
			if (createFields.has(field)) {
				conflicts.push({
					field,
					cause: `field "${field}" present in both create payload and atomic op "${op.kind}"`,
				})
			}
		}
	}
	if (conflicts.length > 0) {
		throw new OrmValidationError('conflicting-ops', schema.name, 'upsertOne', conflicts)
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { IncOp, MulOp, SetOp, UnsetOp } = await import('./updates.js')
	const { EquippedError } = await import('../errors/index.js')

	describe('validateCreate', () => {
		const UserSchema = Schema.from('users')
			.pk('id', v.string(), () => 'auto-id')
			.field('email', v.string())
			.field('name', v.string())
			.field('age', v.optional(v.number()))
			.field('createdAt', v.number(), { onCreate: () => 1000 })
			.build()

		test('generates pk when not provided', () => {
			const result = validateCreate(UserSchema, { email: 'a@b.com', name: 'Alice' })
			expect(result.id).toBe('auto-id')
		})

		test('uses provided pk when given', () => {
			const result = validateCreate(UserSchema, { id: 'custom-id', email: 'a@b.com', name: 'Alice' })
			expect(result.id).toBe('custom-id')
		})

		test('applies onCreate generator for generated fields', () => {
			const result = validateCreate(UserSchema, { email: 'a@b.com', name: 'Alice' })
			expect(result.createdAt).toBe(1000)
		})

		test('allows overriding generated field values', () => {
			const result = validateCreate(UserSchema, { email: 'a@b.com', name: 'Alice', createdAt: 9999 })
			expect(result.createdAt).toBe(9999)
		})

		test('optional fields default to undefined when not provided', () => {
			const result = validateCreate(UserSchema, { email: 'a@b.com', name: 'Alice' })
			expect(result.age).toBeUndefined()
		})

		test('strips unknown fields', () => {
			const result = validateCreate(UserSchema, { email: 'a@b.com', name: 'Alice', admin: true })
			expect((result as any).admin).toBeUndefined()
		})

		test('throws OrmValidationError on invalid field type', () => {
			try {
				validateCreate(UserSchema, { email: 123, name: 'Alice' })
				expect.unreachable()
			} catch (e) {
				expect(e).toBeInstanceOf(OrmValidationError)
				const err = e as InstanceType<typeof OrmValidationError>
				expect(err.kind).toBe('validation')
				expect(err.schema).toBe('users')
				expect(err.operation).toBe('createOne')
				expect(err.failures.length).toBeGreaterThan(0)
				expect(err.failures[0].field).toBe('email')
			}
		})

		test('throws OrmValidationError when required field is missing', () => {
			try {
				validateCreate(UserSchema, { email: 'a@b.com' })
				expect.unreachable()
			} catch (e) {
				expect(e).toBeInstanceOf(OrmValidationError)
				const err = e as InstanceType<typeof OrmValidationError>
				expect(err.kind).toBe('validation')
				expect(err.failures.some((f) => f.field === 'name')).toBe(true)
			}
		})

		test('collects all field failures in a single error', () => {
			try {
				validateCreate(UserSchema, { email: 123, name: 456 })
				expect.unreachable()
			} catch (e) {
				expect(e).toBeInstanceOf(OrmValidationError)
				const err = e as InstanceType<typeof OrmValidationError>
				const failedFields = err.failures.map((f) => f.field)
				expect(failedFields).toContain('email')
				expect(failedFields).toContain('name')
			}
		})
	})

	describe('validateCreateMany', () => {
		const ItemSchema = Schema.from('items')
			.pk('id', v.string(), () => 'item-id')
			.field('title', v.string())
			.field('price', v.number())
			.build()

		test('validates all rows and returns validated documents', () => {
			const results = validateCreateMany(ItemSchema, [
				{ title: 'A', price: 10 },
				{ title: 'B', price: 20 },
			])
			expect(results).toHaveLength(2)
			expect(results[0].title).toBe('A')
			expect(results[1].title).toBe('B')
		})

		test('collects failures across rows with rowIndex populated', () => {
			try {
				validateCreateMany(ItemSchema, [
					{ title: 'Good', price: 10 },
					{ title: 123, price: 20 },
					{ title: 'Also bad', price: 'not-a-number' },
				])
				expect.unreachable()
			} catch (e) {
				expect(e).toBeInstanceOf(OrmValidationError)
				const err = e as InstanceType<typeof OrmValidationError>
				expect(err.kind).toBe('validation')
				expect(err.schema).toBe('items')
				expect(err.operation).toBe('createMany')
				expect(err.failures.length).toBeGreaterThanOrEqual(2)
				const rowIndices = err.failures.map((f) => f.rowIndex)
				expect(rowIndices).toContain(1)
				expect(rowIndices).toContain(2)
				expect(rowIndices).not.toContain(0)
			}
		})

		test('throws single error even with multiple bad rows', () => {
			try {
				validateCreateMany(ItemSchema, [
					{ title: 1, price: 'bad' },
					{ title: 2, price: 'worse' },
				])
				expect.unreachable()
			} catch (e) {
				expect(e).toBeInstanceOf(OrmValidationError)
				const err = e as InstanceType<typeof OrmValidationError>
				expect(err.failures.filter((f) => f.rowIndex === 0).length).toBeGreaterThan(0)
				expect(err.failures.filter((f) => f.rowIndex === 1).length).toBeGreaterThan(0)
			}
		})
	})

	describe('validateUpdate', () => {
		const UserSchema = Schema.from('users')
			.pk('id', v.string(), () => 'auto-id')
			.field('email', v.string())
			.field('name', v.string())
			.field('updatedAt', v.number(), { onCreate: () => 1000, onUpdate: () => 2000 })
			.build()

		test('validates only provided fields', () => {
			const result = validateUpdate(UserSchema, { name: 'Bob' })
			expect(result).toHaveProperty('name', 'Bob')
			expect(result).not.toHaveProperty('email')
		})

		test('applies onUpdate generator for unset generated fields', () => {
			const result = validateUpdate(UserSchema, { name: 'Bob' })
			expect(result).toHaveProperty('updatedAt', 2000)
		})

		test('allows overriding onUpdate field explicitly', () => {
			const result = validateUpdate(UserSchema, { name: 'Bob', updatedAt: 5000 })
			expect(result).toHaveProperty('updatedAt', 5000)
		})

		test('strips unknown fields', () => {
			const result = validateUpdate(UserSchema, { name: 'Bob', admin: true })
			expect((result as any).admin).toBeUndefined()
		})

		test('throws on invalid field type', () => {
			expect(() => validateUpdate(UserSchema, { name: 123 })).toThrow()
		})

		test('passes Op instances through without validation', () => {
			const result = validateUpdate(UserSchema, { name: new IncOp('name', 1) })
			expect(result.name).toBeInstanceOf(IncOp)
		})

		test('Op on a field suppresses onUpdate for that field but not others', () => {
			const result = validateUpdate(UserSchema, { updatedAt: new IncOp('updatedAt', 1) })
			expect(result.updatedAt).toBeInstanceOf(IncOp)
		})

		test('plain value and Op can coexist in same update', () => {
			const result = validateUpdate(UserSchema, { name: 'Bob', email: new UnsetOp('email') })
			expect(result.name).toBe('Bob')
			expect(result.email).toBeInstanceOf(UnsetOp)
			expect(result.updatedAt).toBe(2000)
		})

		test('Op on onUpdate field suppresses its generator', () => {
			const result = validateUpdate(UserSchema, { updatedAt: new MulOp('updatedAt', 2) })
			expect(result.updatedAt).toBeInstanceOf(MulOp)
		})
	})

	describe('OrmValidationError', () => {
		test('has correct kind, schema, operation, and failures', () => {
			const err = new OrmValidationError('conflicting-ops', 'users', 'updateByPk', [
				{ field: 'views', cause: 'conflict' },
			])
			expect(err).toBeInstanceOf(EquippedError)
			expect(err.kind).toBe('conflicting-ops')
			expect(err.schema).toBe('users')
			expect(err.operation).toBe('updateByPk')
			expect(err.failures).toHaveLength(1)
		})
	})

	describe('validateUpdateOps', () => {
		const UpdateSchema = Schema.from('items')
			.pk('id', v.string(), () => 'auto')
			.field('name', v.string())
			.field('views', v.number())
			.field('updatedAt', v.number(), { onCreate: () => 1000, onUpdate: () => 2000 })
			.build()

		test('passes through valid ops', () => {
			const ops = validateUpdateOps(UpdateSchema, [new SetOp({ name: 'New Name' })])
			expect(ops.length).toBeGreaterThanOrEqual(1)
			expect(ops[0]).toBeInstanceOf(SetOp)
		})

		test('auto-bumps onUpdate fields not touched by user ops', () => {
			const ops = validateUpdateOps(UpdateSchema, [new SetOp({ name: 'New Name' })])
			const bumped = ops.find((op) => op instanceof SetOp && 'updatedAt' in op.values && op !== ops[0])
			expect(bumped).toBeDefined()
			expect((bumped as SetOp).values.updatedAt).toBe(2000)
		})

		test('user set({updatedAt:X}) suppresses auto-bump for that field', () => {
			const ops = validateUpdateOps(UpdateSchema, [new SetOp({ updatedAt: 9999 })])
			const setOps = ops.filter((op) => op instanceof SetOp) as SetOp[]
			const allUpdatedAtValues = setOps.flatMap((op) => ('updatedAt' in op.values ? [op.values.updatedAt] : []))
			expect(allUpdatedAtValues).toEqual([9999])
		})

		test('atomic op on onUpdate field suppresses auto-bump', () => {
			const ops = validateUpdateOps(UpdateSchema, [new IncOp('updatedAt', 1)])
			const setOps = ops.filter((op) => op instanceof SetOp) as SetOp[]
			const hasAutoBumpedUpdatedAt = setOps.some((op) => 'updatedAt' in op.values)
			expect(hasAutoBumpedUpdatedAt).toBe(false)
		})

		test('set({views:0}) + inc(views, 1) throws conflicting-ops', () => {
			expect(() => validateUpdateOps(UpdateSchema, [new SetOp({ views: 0 }), new IncOp('views', 1)])).toThrow(
				OrmValidationError,
			)

			try {
				validateUpdateOps(UpdateSchema, [new SetOp({ views: 0 }), new IncOp('views', 1)])
			} catch (e) {
				const err = e as OrmValidationError
				expect(err.kind).toBe('conflicting-ops')
				expect(err.failures[0].field).toBe('views')
			}
		})

		test('cross-kind conflict (unset + inc on same field) throws', () => {
			const UpdateSchema2 = Schema.from('items2')
				.pk('id', v.string(), () => 'auto')
				.field('score', v.optional(v.number()))
				.build()
			expect(() => validateUpdateOps(UpdateSchema2, [new UnsetOp('score'), new IncOp('score', 5)])).toThrow(
				OrmValidationError,
			)
		})

		test('SetOp values are pipe-validated', () => {
			expect(() => validateUpdateOps(UpdateSchema, [new SetOp({ name: 123 as any })])).toThrow(OrmValidationError)

			try {
				validateUpdateOps(UpdateSchema, [new SetOp({ name: 123 as any })])
			} catch (e) {
				const err = e as OrmValidationError
				expect(err.kind).toBe('validation')
				expect(err.failures[0].field).toBe('name')
			}
		})

		test('atomic op operands are NOT pipe-validated', () => {
			const ops = validateUpdateOps(UpdateSchema, [new IncOp('views', -999)])
			expect(ops).toHaveLength(2)
		})

		test('auto-bumped SetOp values are pipe-validated', () => {
			const BadSchema = Schema.from('bad')
				.pk('id', v.string(), () => 'auto')
				.field('name', v.string())
				.field('counter', v.number(), { onUpdate: () => 'not-a-number' as any })
				.build()
			expect(() => validateUpdateOps(BadSchema, [new SetOp({ name: 'test' })])).toThrow(OrmValidationError)
		})

		test('collects all conflicts in one error', () => {
			try {
				validateUpdateOps(UpdateSchema, [
					new SetOp({ views: 0, name: 'A' }),
					new IncOp('views', 1),
					new SetOp({ name: 'B' }),
				])
			} catch (e) {
				const err = e as OrmValidationError
				expect(err.kind).toBe('conflicting-ops')
				expect(err.failures.length).toBe(2)
			}
		})
	})

	describe('composeSchemaConfig', () => {
		const TestSchema = Schema.from('cfg_test')
			.pk('id', v.string(), () => 'x')
			.build()

		const tablePipe = v.object({ table: v.string() })

		test('composes base resolver output and validates against pipe', () => {
			const result = composeSchemaConfig(() => ({ table: 'users' }), [], TestSchema, tablePipe)
			expect(result).toEqual({ table: 'users' })
		})

		test('applies transforms in order before validation', () => {
			const result = composeSchemaConfig(
				() => ({ table: 'users' }),
				[
					(cfg: any) => ({ ...cfg, table: `a_${cfg.table}` }),
					(cfg: any) => ({ ...cfg, table: `b_${cfg.table}` }),
				],
				TestSchema,
				tablePipe,
			)
			expect(result).toEqual({ table: 'b_a_users' })
		})

		test('throws OrmValidationError when composed config fails pipe validation', () => {
			try {
				composeSchemaConfig(() => ({ table: 123 }), [], TestSchema, tablePipe)
				expect.unreachable()
			} catch (e) {
				expect(e).toBeInstanceOf(OrmValidationError)
				const err = e as OrmValidationError
				expect(err.kind).toBe('validation')
				expect(err.schema).toBe('cfg_test')
				expect(err.operation).toBe('schemaConfig')
				expect(err.failures).toHaveLength(1)
			}
		})

		test('throws OrmValidationError when transform corrupts valid base config', () => {
			try {
				composeSchemaConfig(
					() => ({ table: 'users' }),
					[(cfg: any) => ({ ...cfg, table: 42 })],
					TestSchema,
					tablePipe,
				)
				expect.unreachable()
			} catch (e) {
				expect(e).toBeInstanceOf(OrmValidationError)
				const err = e as OrmValidationError
				expect(err.kind).toBe('validation')
				expect(err.operation).toBe('schemaConfig')
			}
		})

		test('returns typed effective config on success', () => {
			const pipe = v.object({ table: v.string(), prefix: v.optional(v.string()) })
			const result = composeSchemaConfig(
				() => ({ table: 'orders' }),
				[(cfg: any) => ({ ...cfg, prefix: 'tenant1' })],
				TestSchema,
				pipe,
			)
			expect(result).toEqual({ table: 'orders', prefix: 'tenant1' })
		})
	})
}
