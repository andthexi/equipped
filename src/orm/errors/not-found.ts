import { EquippedError } from '../../errors/index.js'
import { Filter, FilterGroup } from '../filter.js'

export type OrmNotFoundOperation = 'findOne' | 'updateOne' | 'deleteOne'

function renderFilter(group: FilterGroup): string {
	if (
		group.op === 'and' &&
		group.children.length === 1 &&
		group.children[0] instanceof Filter &&
		group.children[0].op === 'eq'
	) {
		const f = group.children[0]
		return `${f.field}=${f.value}`
	}
	return renderFilterTree(group)
}

function renderFilterTree(node: FilterGroup | Filter): string {
	if (node instanceof Filter) {
		return `${node.field} ${node.op} ${JSON.stringify(node.value)}`
	}
	const parts = node.children.map((c) => renderFilterTree(c))
	if (parts.length === 1) return parts[0]
	return `(${parts.join(` ${node.op} `)})`
}

export class OrmNotFoundError extends EquippedError {
	readonly schema: string
	readonly operation: OrmNotFoundOperation
	readonly where: FilterGroup

	constructor(opts: { schema: string; operation: OrmNotFoundOperation; where: FilterGroup; message?: string }) {
		const msg = opts.message ?? `${opts.schema}.${opts.operation}: no row matched ${renderFilter(opts.where)}`
		super(msg, {
			schema: opts.schema,
			operation: opts.operation,
			where: opts.where,
		})
		this.schema = opts.schema
		this.operation = opts.operation
		this.where = opts.where
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { OrmValidationError } = await import('./validation.js')

	describe('OrmNotFoundError', () => {
		describe('carrier construction', () => {
			test('stores schema, operation, and where on the instance', () => {
				const where = FilterGroup.create().eq('id', 'u1')
				const err = new OrmNotFoundError({ schema: 'users', operation: 'findOne', where })
				expect(err.schema).toBe('users')
				expect(err.operation).toBe('findOne')
				expect(err.where).toBe(where)
			})

			test('accepts all three operation literals', () => {
				const where = FilterGroup.create().eq('id', 'u1')
				for (const op of ['findOne', 'updateOne', 'deleteOne'] as const) {
					const err = new OrmNotFoundError({ schema: 'users', operation: op, where })
					expect(err.operation).toBe(op)
				}
			})
		})

		describe('default message generation', () => {
			test('PK-keyed filter renders as id=<pk>', () => {
				const where = FilterGroup.create().eq('id', 'abc-123')
				const err = new OrmNotFoundError({ schema: 'users', operation: 'findOne', where })
				expect(err.message).toBe('users.findOne: no row matched id=abc-123')
			})

			test('filter-based rendering shows the filter tree', () => {
				const where = FilterGroup.create().eq('email', 'a@b.com').gt('age', 18)
				const err = new OrmNotFoundError({ schema: 'users', operation: 'updateOne', where })
				expect(err.message).toBe('users.updateOne: no row matched (email eq "a@b.com" and age gt 18)')
			})

			test('single non-eq filter renders without parens', () => {
				const where = FilterGroup.create().gt('age', 18)
				const err = new OrmNotFoundError({ schema: 'users', operation: 'deleteOne', where })
				expect(err.message).toBe('users.deleteOne: no row matched age gt 18')
			})
		})

		describe('custom message override', () => {
			test('custom message replaces the default', () => {
				const where = FilterGroup.create().eq('id', 'u1')
				const err = new OrmNotFoundError({
					schema: 'users',
					operation: 'findOne',
					where,
					message: 'user must exist',
				})
				expect(err.message).toBe('user must exist')
			})
		})

		describe('instanceof discrimination', () => {
			test('instanceof OrmNotFoundError is true', () => {
				const where = FilterGroup.create().eq('id', 'u1')
				const err = new OrmNotFoundError({ schema: 'users', operation: 'findOne', where })
				expect(err).toBeInstanceOf(OrmNotFoundError)
			})

			test('instanceof EquippedError is true', () => {
				const where = FilterGroup.create().eq('id', 'u1')
				const err = new OrmNotFoundError({ schema: 'users', operation: 'findOne', where })
				expect(err).toBeInstanceOf(EquippedError)
			})

			test('instanceof OrmNotFoundError discriminates from OrmValidationError', () => {
				const where = FilterGroup.create().eq('id', 'u1')
				const notFound = new OrmNotFoundError({ schema: 'users', operation: 'findOne', where })
				const validation = new OrmValidationError('validation', 'users', 'createOne', [])
				expect(notFound).not.toBeInstanceOf(OrmValidationError)
				expect(validation).not.toBeInstanceOf(OrmNotFoundError)
			})

			test('both are instanceof EquippedError', () => {
				const where = FilterGroup.create().eq('id', 'u1')
				const notFound = new OrmNotFoundError({ schema: 'users', operation: 'findOne', where })
				const validation = new OrmValidationError('validation', 'users', 'createOne', [])
				expect(notFound).toBeInstanceOf(EquippedError)
				expect(validation).toBeInstanceOf(EquippedError)
			})
		})
	})
}
