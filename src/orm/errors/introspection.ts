import { EquippedError } from '../../errors/index.js'

export class OrmIntrospectionError extends EquippedError {
	readonly adapter: string
	readonly table: string

	constructor(opts: { adapter: string; table: string; cause: unknown }) {
		super(
			`Introspection failed for table '${opts.table}' on adapter '${opts.adapter}'`,
			{ adapter: opts.adapter, table: opts.table },
			opts.cause,
		)
		this.adapter = opts.adapter
		this.table = opts.table
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { EquippedError } = await import('../../errors/index.js')

	describe('OrmIntrospectionError', () => {
		test('stores adapter, table, and cause on the instance', () => {
			const cause = new Error('unknown column type')
			const err = new OrmIntrospectionError({ adapter: 'postgres', table: 'users', cause })
			expect(err.adapter).toBe('postgres')
			expect(err.table).toBe('users')
			expect(err.cause).toBe(cause)
		})

		test('message includes adapter and table', () => {
			const err = new OrmIntrospectionError({ adapter: 'pg', table: 'posts', cause: 'bad type' })
			expect(err.message).toBe("Introspection failed for table 'posts' on adapter 'pg'")
		})

		test('instanceof EquippedError is true', () => {
			const err = new OrmIntrospectionError({ adapter: 'x', table: 'y', cause: null })
			expect(err).toBeInstanceOf(OrmIntrospectionError)
			expect(err).toBeInstanceOf(EquippedError)
		})

		test('context carries adapter and table', () => {
			const err = new OrmIntrospectionError({ adapter: 'mem', table: 'items', cause: 'fail' })
			expect((err.context as any).adapter).toBe('mem')
			expect((err.context as any).table).toBe('items')
		})

		test('discriminates from sibling error classes', async () => {
			const { OrmMigrationError } = await import('./migration.js')
			const { OrmValidationError } = await import('./validation.js')
			const err = new OrmIntrospectionError({ adapter: 'x', table: 'y', cause: null })
			expect(err).not.toBeInstanceOf(OrmMigrationError)
			expect(err).not.toBeInstanceOf(OrmValidationError)
		})
	})
}
