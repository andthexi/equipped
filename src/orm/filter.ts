import type { FieldTypeName, FilterOpName } from './adapter'
import { EquippedError } from '../errors'
import { OrmValidationError, type OrmValidationFailure } from './errors'
import { Field, toFieldName, type AnyField } from './fields'
import type { AggregateSpec } from './orm-adapter'
import type { AnySchema } from './schema'

export class Filter {
	readonly field: string
	readonly path: readonly string[]
	readonly valueType: FieldTypeName | null

	constructor(
		field: string | AnyField,
		readonly op: FilterOpName,
		readonly value: unknown,
		path?: readonly string[],
		valueType?: FieldTypeName | null,
	) {
		this.field = toFieldName(field)
		this.path = field instanceof Field ? field.path : (path ?? [field])
		this.valueType = field instanceof Field ? field.valueType : (valueType ?? null)
	}
}

export type FilterChild = Filter | FilterGroup

export type FilterFactory = (q: FilterGroup) => FilterGroup

export type FilterGroupOp = 'and' | 'or'

export class FilterGroup {
	readonly children: readonly FilterChild[]

	private constructor(
		readonly op: FilterGroupOp = 'and',
		children?: readonly FilterChild[],
	) {
		this.children = children ?? []
	}

	#withChild(child: FilterChild): FilterGroup {
		return new FilterGroup(this.op, [...this.children, child])
	}

	eq<T>(field: string | Field<T>, value: T): FilterGroup {
		return this.#withChild(new Filter(field, 'eq', value))
	}

	ne<T>(field: string | Field<T>, value: T): FilterGroup {
		return this.#withChild(new Filter(field, 'ne', value))
	}

	gt<T>(field: string | Field<T>, value: T): FilterGroup {
		return this.#withChild(new Filter(field, 'gt', value))
	}

	gte<T>(field: string | Field<T>, value: T): FilterGroup {
		return this.#withChild(new Filter(field, 'gte', value))
	}

	lt<T>(field: string | Field<T>, value: T): FilterGroup {
		return this.#withChild(new Filter(field, 'lt', value))
	}

	lte<T>(field: string | Field<T>, value: T): FilterGroup {
		return this.#withChild(new Filter(field, 'lte', value))
	}

	in<T>(field: string | Field<T>, value: T[]): FilterGroup {
		return this.#withChild(new Filter(field, 'in', value))
	}

	notIn<T>(field: string | Field<T>, value: T[]): FilterGroup {
		return this.#withChild(new Filter(field, 'notIn', value))
	}

	like(field: string | Field<string>, value: string): FilterGroup {
		return this.#withChild(new Filter(field, 'like', value))
	}

	exists(field: string | Field<unknown>): FilterGroup {
		return this.#withChild(new Filter(field, 'exists', true))
	}

	notExists(field: string | Field<unknown>): FilterGroup {
		return this.#withChild(new Filter(field, 'notExists', true))
	}

	contains<T>(field: string | Field<T>, value: T[]): FilterGroup {
		return this.#withChild(new Filter(field, 'contains', value))
	}

	notContains<T>(field: string | Field<T>, value: T[]): FilterGroup {
		return this.#withChild(new Filter(field, 'notContains', value))
	}

	and(facFns: FilterFactory[]): FilterGroup {
		if (facFns.length === 0) throw new EquippedError('and() requires at least one filter factory', { op: 'and' })
		const group = new FilterGroup('and', facFns.map((fn) => fn(FilterGroup.create())))
		return this.#withChild(group)
	}

	or(facFns: FilterFactory[]): FilterGroup {
		if (facFns.length === 0) throw new EquippedError('or() requires at least one filter factory', { op: 'or' })
		const group = new FilterGroup('or', facFns.map((fn) => fn(FilterGroup.create())))
		return this.#withChild(group)
	}

	clone(): FilterGroup {
		return new FilterGroup(
			this.op,
			this.children.map((c) => {
				if (c instanceof Filter) return new Filter(c.field, c.op, structuredClone(c.value), c.path, c.valueType)
				return c.clone()
			}),
		)
	}

	static create(): FilterGroup {
		return new FilterGroup()
	}
}


export type GatedFilterGroup<DeclaredOps extends readonly FilterOpName[]> = {
	[K in FilterOpName]: K extends DeclaredOps[number] ? FilterGroup[K] : never
} & Pick<FilterGroup, 'and' | 'or' | 'clone' | 'children' | 'op'>

export type GatedFilterFactory<DeclaredOps extends readonly FilterOpName[]> = (
	q: GatedFilterGroup<DeclaredOps>,
) => GatedFilterGroup<DeclaredOps>

export function assertNormalisedAggregate(schema: AnySchema, adapter: { aggregateOps: readonly string[] }, spec: AggregateSpec): void {
	const failures: OrmValidationFailure[] = []

	if (spec.aggregates.length === 0) {
		failures.push({ cause: 'At least one aggregator step is required' })
	}

	const seenAliases = new Set<string>()
	for (const agg of spec.aggregates) {
		if (seenAliases.has(agg.alias)) {
			failures.push({ alias: agg.alias, cause: `Duplicate alias "${agg.alias}"` })
		}
		seenAliases.add(agg.alias)

		if (!adapter.aggregateOps.includes(agg.fn)) {
			failures.push({ alias: agg.alias, cause: `Undeclared aggregate op "${agg.fn}"` })
		}
	}

	const allFields = schema.fields as Record<string, unknown>
	const fieldNames = new Set(Object.keys(allFields))
	for (const field of spec.groupBy) {
		if (!fieldNames.has(field)) {
			failures.push({ field, cause: `Unknown groupBy field "${field}" on schema "${schema.name}"` })
		}
		if (seenAliases.has(field)) {
			failures.push({ alias: field, cause: `Alias "${field}" collides with groupBy field name` })
		}
	}

	if (failures.length > 0) {
		throw new OrmValidationError('aggregate', schema.name, 'aggregate', failures)
	}

	if (spec.where) {
		assertNormalisedFilter(schema, spec.where)
	}

	if (spec.having) {
		const validHavingFields = new Set([...seenAliases, ...spec.groupBy])
		const havingErrors: OrmValidationFailure[] = []

		function walkHaving(node: FilterChild): void {
			if (node instanceof Filter) {
				if (!validHavingFields.has(node.field)) {
					havingErrors.push({ field: node.field, cause: `Unknown having field "${node.field}" — must be an aggregator alias or groupBy field` })
				}
			} else if (node instanceof FilterGroup) {
				for (const child of node.children) walkHaving(child)
			}
		}

		for (const child of spec.having.children) walkHaving(child)

		if (havingErrors.length > 0) {
			throw new OrmValidationError('aggregate', schema.name, 'aggregate', havingErrors)
		}
	}
}

function filterRoot(node: Filter): string {
	return node.path[0] ?? node.field
}

export function assertNormalisedFilter(schema: AnySchema, group: FilterGroup): void {
	const allFields = schema.fields as Record<string, unknown>
	const fieldNames = new Set(Object.keys(allFields))
	const errors: Array<{ field: string; cause: string }> = []

	function walk(node: FilterChild): void {
		if (node instanceof Filter) {
			if (!fieldNames.has(filterRoot(node))) {
				errors.push({ field: node.field, cause: `Unknown field "${node.field}" on schema "${schema.name}"` })
			}
		} else if (node instanceof FilterGroup) {
			for (const child of node.children) walk(child)
		}
	}

	for (const child of group.children) walk(child)

	if (errors.length > 0) {
		throw new OrmValidationError(
			'validation',
			schema.name,
			'filter',
			errors.map((e) => ({ field: e.field, cause: e.cause })),
		)
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { v } = await import('valleyed')
	const { Schema } = await import('./schema')

	const UserSchema = Schema.from('users')
		.pk('id', v.string(), () => 'u1')
		.field('email', v.string())
		.field('age', v.number())
		.field('name', v.string())
		.field('tags', v.array(v.string()))
		.build()

	const LinkSchema = Schema.from('links')
		.pk('id', v.string(), () => 'link-1')
		.field('def', v.object({ type: v.string() }))
		.build()

	describe('FilterGroup', () => {
		describe('filter-op methods', () => {
			test('eq adds a filter clause with op eq', () => {
				const g = FilterGroup.create().eq(UserSchema.fields.age, 25)
				expect(g.children).toHaveLength(1)
				const f = g.children[0] as Filter
				expect(f.field).toBe('age')
				expect(f.op).toBe('eq')
				expect(f.value).toBe(25)
			})

			test('ne adds a filter clause with op ne', () => {
				const g = FilterGroup.create().ne('name', 'Bob')
				const f = g.children[0] as Filter
				expect(f.op).toBe('ne')
				expect(f.value).toBe('Bob')
			})

			test('gt/gte/lt/lte produce correct ops', () => {
				const g = FilterGroup.create()
					.gt(UserSchema.fields.age, 10)
					.gte(UserSchema.fields.age, 20)
					.lt(UserSchema.fields.age, 30)
					.lte(UserSchema.fields.age, 40)
				expect(g.children.map((c) => (c as Filter).op)).toEqual(['gt', 'gte', 'lt', 'lte'])
			})

			test('in adds a filter clause with array value', () => {
				const g = FilterGroup.create().in(UserSchema.fields.age, [1, 2, 3])
				const f = g.children[0] as Filter
				expect(f.op).toBe('in')
				expect(f.value).toEqual([1, 2, 3])
			})

			test('notIn adds a filter clause with op notIn', () => {
				const g = FilterGroup.create().notIn(UserSchema.fields.age, [4, 5])
				const f = g.children[0] as Filter
				expect(f.op).toBe('notIn')
				expect(f.value).toEqual([4, 5])
			})

			test('like adds a filter clause with op like', () => {
				const g = FilterGroup.create().like(UserSchema.fields.email, 'alice')
				const f = g.children[0] as Filter
				expect(f.op).toBe('like')
				expect(f.value).toBe('alice')
			})

			test('exists adds a filter clause with op exists', () => {
				const g = FilterGroup.create().exists(UserSchema.fields.name)
				const f = g.children[0] as Filter
				expect(f.op).toBe('exists')
			})

			test('notExists is its own op, not a boolean form of exists', () => {
				const g = FilterGroup.create().notExists(UserSchema.fields.name)
				const f = g.children[0] as Filter
				expect(f.op).toBe('notExists')
				expect(f.op).not.toBe('exists')
			})

			test('contains/notContains produce correct ops', () => {
				const g = FilterGroup.create()
					.contains('tags', ['a'])
					.notContains('tags', ['b'])
				expect((g.children[0] as Filter).op).toBe('contains')
				expect((g.children[1] as Filter).op).toBe('notContains')
			})

			test('all 13 filter ops produce matching Filter.op values (name-parity)', () => {
				const g = FilterGroup.create()
					.eq('f', 1)
					.ne('f', 1)
					.gt('f', 1)
					.gte('f', 1)
					.lt('f', 1)
					.lte('f', 1)
					.in('f', [1])
					.notIn('f', [1])
					.like('f', 'x')
					.exists('f')
					.notExists('f')
					.contains('f', [1])
					.notContains('f', [1])
				const ops = g.children.map((c) => (c as Filter).op)
				expect(ops).toEqual([
					'eq', 'ne', 'gt', 'gte', 'lt', 'lte',
					'in', 'notIn', 'like', 'exists', 'notExists',
					'contains', 'notContains',
				])
			})
		})

		describe('raw-string field overload', () => {
			test('accepts raw string field name', () => {
				const g = FilterGroup.create().eq('age', 18)
				const f = g.children[0] as Filter
				expect(f.field).toBe('age')
			})

			test('accepts typed Field ref and extracts field name', () => {
				const g = FilterGroup.create().eq(UserSchema.fields.age, 18)
				const f = g.children[0] as Filter
				expect(f.field).toBe('age')
			})

			test('preserves nested field path and value type', () => {
				const g = FilterGroup.create().eq(LinkSchema.fields.def.nested('type', 'string'), 'depends-on')
				const f = g.children[0] as Filter

				expect(f.field).toBe('def.type')
				expect(f.path).toEqual(['def', 'type'])
				expect(f.valueType).toBe('string')
			})
		})

		describe('structural combinators', () => {
			test('and() creates a nested and-group', () => {
				const g = FilterGroup.create().and([
					(q) => q.eq('age', 10),
					(q) => q.eq('name', 'Alice'),
				])
				expect(g.children).toHaveLength(1)
				const nested = g.children[0] as FilterGroup
				expect(nested.op).toBe('and')
				expect(nested.children).toHaveLength(2)
			})

			test('or() creates a nested or-group', () => {
				const g = FilterGroup.create().or([
					(q) => q.eq('name', 'Alice'),
					(q) => q.eq('name', 'Bob'),
				])
				const nested = g.children[0] as FilterGroup
				expect(nested.op).toBe('or')
			})
		})

		describe('empty-combinator rejection', () => {
			test('and([]) throws at builder time', () => {
				expect(() => FilterGroup.create().and([])).toThrow()
			})

			test('or([]) throws at builder time', () => {
				expect(() => FilterGroup.create().or([])).toThrow()
			})

			test('thrown error has stack pointing at offending call', () => {
				try {
					FilterGroup.create().and([])
					expect.unreachable()
				} catch (e) {
					expect((e as Error).stack).toContain('filter.ts')
				}
			})
		})

		describe('clone()', () => {
			test('deep-clones the tree', () => {
				const original = FilterGroup.create()
					.eq('name', 'Alice')
					.and([(q) => q.gt('age', 20)])
				const cloned = original.clone()

				expect(cloned.children).toHaveLength(2)
				expect(cloned).not.toBe(original)
				expect(cloned.children[0]).not.toBe(original.children[0])
			})

			test('structuredClone of values — mutations on clone do not leak', () => {
				const arr = [1, 2, 3]
				const original = FilterGroup.create().in('ids', arr)
				const cloned = original.clone()

				const clonedValue = (cloned.children[0] as Filter).value as number[]
				clonedValue.push(4)

				expect((original.children[0] as Filter).value).toEqual([1, 2, 3])
				expect(clonedValue).toEqual([1, 2, 3, 4])
			})
		})
	})

	describe('clone-on-step: fan-out independence', () => {
		test('.eq() returns a new FilterGroup, not the same instance', () => {
			const base = FilterGroup.create()
			const a = base.eq('name', 'Alice')
			expect(a).not.toBe(base)
		})

		test('fan-out from shared base does not pollute either branch', () => {
			const base = FilterGroup.create().eq('name', 'Alice')
			const branchA = base.gt('age', 20)
			const branchB = base.lt('age', 40)

			expect(branchA.children).toHaveLength(2)
			expect(branchB.children).toHaveLength(2)
			expect(base.children).toHaveLength(1)
			expect((branchA.children[1] as Filter).op).toBe('gt')
			expect((branchB.children[1] as Filter).op).toBe('lt')
		})

		test('.and() returns a new FilterGroup', () => {
			const base = FilterGroup.create().eq('name', 'Alice')
			const withAnd = base.and([(q) => q.gt('age', 20)])
			expect(withAnd).not.toBe(base)
			expect(base.children).toHaveLength(1)
			expect(withAnd.children).toHaveLength(2)
		})

		test('.or() returns a new FilterGroup', () => {
			const base = FilterGroup.create().eq('name', 'Alice')
			const withOr = base.or([(q) => q.gt('age', 20)])
			expect(withOr).not.toBe(base)
			expect(base.children).toHaveLength(1)
			expect(withOr.children).toHaveLength(2)
		})
	})

	describe('assertNormalisedFilter', () => {
		test('passes for valid filter referencing known fields', () => {
			const g = FilterGroup.create().eq(UserSchema.fields.age, 25)
			expect(() => assertNormalisedFilter(UserSchema, g)).not.toThrow()
		})

		test('passes for raw string field that exists on schema', () => {
			const g = FilterGroup.create().eq('email', 'test@test.com')
			expect(() => assertNormalisedFilter(UserSchema, g)).not.toThrow()
		})

		test('rejects unknown field name with OrmValidationError', () => {
			const g = FilterGroup.create().eq('unknownField', 42)
			expect(() => assertNormalisedFilter(UserSchema, g)).toThrow(OrmValidationError)
		})

		test('rejected error has kind validation', () => {
			const g = FilterGroup.create().eq('badField', 42)
			try {
				assertNormalisedFilter(UserSchema, g)
				expect.unreachable()
			} catch (e) {
				expect(e).toBeInstanceOf(OrmValidationError)
				expect((e as OrmValidationError).kind).toBe('validation')
				expect((e as OrmValidationError).failures).toHaveLength(1)
				expect((e as OrmValidationError).failures[0].field).toBe('badField')
			}
		})

		test('preserves logical field names verbatim for Field refs', () => {
			const g = FilterGroup.create().eq(UserSchema.fields.email, 'a@b.com')
			const f = g.children[0] as Filter
			expect(f.field).toBe('email')
			assertNormalisedFilter(UserSchema, g)
		})

		test('preserves logical field names verbatim for raw-string overloads', () => {
			const g = FilterGroup.create().eq('age', 18)
			const f = g.children[0] as Filter
			expect(f.field).toBe('age')
			assertNormalisedFilter(UserSchema, g)
		})

		test('accepts nested filters under a known root field', () => {
			const g = FilterGroup.create().eq(LinkSchema.fields.def.nested('type', 'string'), 'depends-on')
			expect(() => assertNormalisedFilter(LinkSchema, g)).not.toThrow()
		})

		test('rejects nested filters under an unknown root field', () => {
			const g = FilterGroup.create().eq('missing.type', 'value')
			expect(() => assertNormalisedFilter(UserSchema, g)).toThrow(OrmValidationError)
		})

		test('walks nested groups to detect unknown fields', () => {
			const g = FilterGroup.create().and([
				(q) => q.eq('name', 'Alice'),
				(q) => q.or([(inner) => inner.eq('nonexistent', 'val')]),
			])
			expect(() => assertNormalisedFilter(UserSchema, g)).toThrow(OrmValidationError)
		})
	})

	describe('assertNormalisedAggregate', () => {
		const adapter = { aggregateOps: ['count'] as readonly string[] }

		test('passes for valid count aggregate', () => {
			const spec = { aggregates: [{ fn: 'count' as const, alias: 'total' }], groupBy: [] }
			expect(() => assertNormalisedAggregate(UserSchema, adapter, spec)).not.toThrow()
		})

		test('rejects empty aggregator list', () => {
			const spec = { aggregates: [], groupBy: [] }
			expect(() => assertNormalisedAggregate(UserSchema, adapter, spec)).toThrow(OrmValidationError)
			try {
				assertNormalisedAggregate(UserSchema, adapter, spec)
				expect.unreachable()
			} catch (e) {
				expect((e as OrmValidationError).kind).toBe('aggregate')
			}
		})

		test('rejects undeclared aggregate op', () => {
			const spec = { aggregates: [{ fn: 'sum' as const, alias: 'total', field: 'age' }], groupBy: [] }
			expect(() => assertNormalisedAggregate(UserSchema, adapter, spec)).toThrow(OrmValidationError)
			try {
				assertNormalisedAggregate(UserSchema, adapter, spec)
				expect.unreachable()
			} catch (e) {
				const err = e as OrmValidationError
				expect(err.kind).toBe('aggregate')
				expect(err.failures[0].alias).toBe('total')
				expect(err.failures[0].cause).toContain('Undeclared')
			}
		})

		test('rejects duplicate aliases', () => {
			const spec = {
				aggregates: [
					{ fn: 'count' as const, alias: 'total' },
					{ fn: 'count' as const, alias: 'total' },
				],
				groupBy: [],
			}
			expect(() => assertNormalisedAggregate(UserSchema, adapter, spec)).toThrow(OrmValidationError)
			try {
				assertNormalisedAggregate(UserSchema, adapter, spec)
				expect.unreachable()
			} catch (e) {
				const err = e as OrmValidationError
				expect(err.failures.some((f) => f.alias === 'total')).toBe(true)
			}
		})

		test('validates where filter against schema', () => {
			const spec = {
				aggregates: [{ fn: 'count' as const, alias: 'total' }],
				groupBy: [],
				where: FilterGroup.create().eq('unknownField', 42),
			}
			expect(() => assertNormalisedAggregate(UserSchema, adapter, spec)).toThrow(OrmValidationError)
		})

		test('collects multiple failures', () => {
			const spec = {
				aggregates: [
					{ fn: 'sum' as const, alias: 'x', field: 'age' },
					{ fn: 'avg' as const, alias: 'x', field: 'age' },
				],
				groupBy: [],
			}
			try {
				assertNormalisedAggregate(UserSchema, adapter, spec)
				expect.unreachable()
			} catch (e) {
				const err = e as OrmValidationError
				expect(err.failures.length).toBeGreaterThanOrEqual(2)
			}
		})

		test('rejects unknown groupBy field', () => {
			const allOps = { aggregateOps: ['count', 'sum'] as readonly string[] }
			const spec = {
				aggregates: [{ fn: 'count' as const, alias: 'total' }],
				groupBy: ['nonexistent'],
			}
			try {
				assertNormalisedAggregate(UserSchema, allOps, spec)
				expect.unreachable()
			} catch (e) {
				const err = e as OrmValidationError
				expect(err.kind).toBe('aggregate')
				expect(err.failures[0].cause).toContain('groupBy')
				expect(err.failures[0].field).toBe('nonexistent')
			}
		})

		test('rejects alias colliding with groupBy field name', () => {
			const allOps = { aggregateOps: ['count'] as readonly string[] }
			const spec = {
				aggregates: [{ fn: 'count' as const, alias: 'name' }],
				groupBy: ['name'],
			}
			try {
				assertNormalisedAggregate(UserSchema, allOps, spec)
				expect.unreachable()
			} catch (e) {
				const err = e as OrmValidationError
				expect(err.kind).toBe('aggregate')
				expect(err.failures.some((f) => String(f.cause).includes('collides'))).toBe(true)
			}
		})

		test('rejects unknown having field', () => {
			const allOps = { aggregateOps: ['count'] as readonly string[] }
			const spec = {
				aggregates: [{ fn: 'count' as const, alias: 'total' }],
				groupBy: ['name'],
				having: FilterGroup.create().gt('nonexistent', 0),
			}
			try {
				assertNormalisedAggregate(UserSchema, allOps, spec)
				expect.unreachable()
			} catch (e) {
				const err = e as OrmValidationError
				expect(err.kind).toBe('aggregate')
				expect(err.failures[0].cause).toContain('having')
			}
		})

		test('having accepts alias and groupBy field names', () => {
			const allOps = { aggregateOps: ['count'] as readonly string[] }
			const spec = {
				aggregates: [{ fn: 'count' as const, alias: 'total' }],
				groupBy: ['name'],
				having: FilterGroup.create().gt('total', 0).eq('name', 'Alice'),
			}
			expect(() => assertNormalisedAggregate(UserSchema, allOps, spec)).not.toThrow()
		})

		test('passes valid groupBy with known schema fields', () => {
			const allOps = { aggregateOps: ['count'] as readonly string[] }
			const spec = {
				aggregates: [{ fn: 'count' as const, alias: 'total' }],
				groupBy: ['name', 'age'],
			}
			expect(() => assertNormalisedAggregate(UserSchema, allOps, spec)).not.toThrow()
		})
	})
}
