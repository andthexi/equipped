import { EquippedError } from '../../errors/index.js'

export type OrmValidationErrorKind =
	| 'validation'
	| 'conflicting-ops'
	| 'empty-group'
	| 'undeclared-op'
	| 'upsert-filter-incompatible'
	| 'aggregate'
	| 'query-shape'
	| 'changes'

export type OrmValidationFailure = {
	opIndex?: number
	rowIndex?: number
	field?: string
	alias?: string
	option?: 'limit' | 'offset' | 'page' | 'batchSize'
	migrationId?: string
	changeIndex?: number
	cause: unknown
}

export class OrmValidationError extends EquippedError {
	constructor(
		readonly kind: OrmValidationErrorKind,
		readonly schema: string,
		readonly operation: string,
		readonly failures: OrmValidationFailure[],
	) {
		super(`ORM validation error (${kind}) on ${schema}.${operation}`, {
			kind,
			schema,
			operation,
			failures,
		})
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { EquippedError } = await import('../../errors/index.js')

	describe('OrmValidationError', () => {
		test('constructs with aggregate kind', () => {
			const err = new OrmValidationError('aggregate', 'orders', 'aggregate', [])
			expect(err.kind).toBe('aggregate')
			expect(err.operation).toBe('aggregate')
			expect(err.message).toBe('ORM validation error (aggregate) on orders.aggregate')
			expect(err).toBeInstanceOf(OrmValidationError)
			expect(err).toBeInstanceOf(EquippedError)
		})

		test('failure carries alias through to context', () => {
			const failures: OrmValidationFailure[] = [{ alias: 'total_price', cause: 'alias collision' }]
			const err = new OrmValidationError('aggregate', 'orders', 'aggregate', failures)
			expect(err.failures[0].alias).toBe('total_price')
			expect((err.context as any).failures[0].alias).toBe('total_price')
		})

		test('failure without alias still works', () => {
			const failures: OrmValidationFailure[] = [{ field: 'amount', cause: 'invalid field' }]
			const err = new OrmValidationError('validation', 'orders', 'createOne', failures)
			expect(err.failures[0].alias).toBeUndefined()
			expect(err.failures[0].field).toBe('amount')
		})

		test.each([
			'validation',
			'conflicting-ops',
			'empty-group',
			'undeclared-op',
			'upsert-filter-incompatible',
			'query-shape',
			'changes',
		] as const)('kind %s still works', (kind) => {
			const err = new OrmValidationError(kind, 'users', 'createOne', [])
			expect(err.kind).toBe(kind)
		})
	})
}
